import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { inspectImages } from '../src/core/inspect.js';
import { BlockedDestinationError, HttpRequestError } from '../src/core/safe-fetch.js';
import { fakeImage, mockStream } from './fixtures.js';

const u = (name: string) => `https://example.com/wp-content/uploads/${name}`;

describe('inspectImages (download mode)', () => {
  it('computes SHA-256 and size of the streamed bytes', async () => {
    const body = fakeImage('a', 100);
    const [r] = await inspectImages([u('a.png')], { stream: mockStream({ [u('a.png')]: { body } }) });
    expect(r).toEqual({ url: u('a.png'), status: 'healthy', method: 'GET', httpStatus: 200, sha256: createHash('sha256').update(body).digest('hex'), bytes: 100, contentType: 'image/png' });
    const [abc] = await inspectImages([u('abc')], { stream: mockStream({ [u('abc')]: { body: Buffer.from('abc') } }) });
    expect(abc!.sha256).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('classifies failures per image without aborting the rest', async () => {
    const stream = mockStream({
      [u('ok.png')]: { body: fakeImage('o') },
      [u('gone.png')]: { status: 410 },
      [u('forbidden.png')]: { status: 403 },
      [u('error.png')]: { status: 500 },
      [u('page.png')]: { type: 'text/html', body: Buffer.from('<html>') },
      [u('big.png')]: { body: fakeImage('b', 2000) },
      [u('huge.png')]: { body: fakeImage('h', 64), headers: { 'content-length': '999999' } },
      [u('slow.png')]: { error: new HttpRequestError('Request timed out after 15000 ms', 'timeout') },
      [u('dns.png')]: { error: new HttpRequestError('getaddrinfo ENOTFOUND old.example.org', 'dns') },
      [u('refused.png')]: { error: new HttpRequestError('connect ECONNREFUSED', 'connection') },
      [u('loop.png')]: { error: new HttpRequestError('Too many redirects (more than 5).', 'redirect') },
      [u('private.png')]: { error: new BlockedDestinationError('Blocked request to 10.0.0.1') },
      [u('weird.png')]: { error: new Error('boom') },
    });
    const names = ['ok.png', 'missing.png', 'gone.png', 'forbidden.png', 'error.png', 'page.png', 'big.png', 'huge.png', 'slow.png', 'dns.png', 'refused.png', 'loop.png', 'private.png', 'weird.png'];
    const results = await inspectImages(names.map(u), { stream, maxBytes: 1000 });
    expect(results.map((r) => [r.status, r.reason ?? null, r.httpStatus ?? null])).toEqual([
      ['healthy', null, 200],
      ['missing', 'http-status', 404],
      ['missing', 'http-status', 410],
      ['inaccessible', 'http-status', 403],
      ['inaccessible', 'http-status', 500],
      ['unexpected-content', 'content-type', 200],
      ['uninspectable', 'too-large', 200],
      ['uninspectable', 'too-large', 200],
      ['timeout', 'timeout', null],
      ['unreachable', 'dns', null],
      ['unreachable', 'connection', null],
      ['unreachable', 'redirect', null],
      ['inaccessible', 'blocked', null],
      ['unknown', 'error', null],
    ]);
    expect(results[5]!.error).toBe('Unexpected content type "text/html"');
    expect(results.every((r) => r.method === 'GET')).toBe(true);
  });

  it('limits concurrent downloads to 2 by default and reports progress', async () => {
    let inFlight = 0;
    let max = 0;
    const base = mockStream(Object.fromEntries(['1', '2', '3', '4', '5'].map((n) => [u(n), { body: fakeImage(n) }])));
    const stream: typeof base = async (url, accept, init) => {
      inFlight++;
      max = Math.max(max, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return base(url, accept, init);
    };
    const progress: number[] = [];
    await inspectImages(['1', '2', '3', '4', '5'].map(u), { stream, onProgress: (d) => progress.push(d) });
    expect(max).toBe(2);
    expect(progress).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('inspectImages (head mode)', () => {
  it('uses HEAD only and never reads a body for healthy images', async () => {
    const log: string[] = [];
    const read: string[] = [];
    const stream = mockStream({ [u('a.png')]: { body: fakeImage('a'), headers: { 'content-length': '64' } } }, log, read);
    const [r] = await inspectImages([u('a.png')], { stream, mode: 'head' });
    expect(r).toEqual({ url: u('a.png'), status: 'healthy', method: 'HEAD', httpStatus: 200, contentType: 'image/png', bytes: 64 });
    expect(log).toEqual([`HEAD ${u('a.png')}`]);
    expect(read).toEqual([]);
  });

  it('falls back to a GET without reading the body when HEAD is rejected or misimplemented', async () => {
    const log: string[] = [];
    const read: string[] = [];
    const stream = mockStream({
      [u('no-head.png')]: { body: fakeImage('a'), head: { status: 405 } },
      [u('html-head.png')]: { body: fakeImage('b'), head: { type: 'text/html' } },
      [u('forbidden-head.png')]: { body: fakeImage('c'), head: { status: 403 } },
    }, log, read);
    const results = await inspectImages(['no-head.png', 'html-head.png', 'forbidden-head.png', 'gone.png'].map(u), { stream, mode: 'head' });
    expect(results.map((r) => [r.status, r.method])).toEqual([['healthy', 'GET'], ['healthy', 'GET'], ['healthy', 'GET'], ['missing', 'GET']]);
    expect(log.filter((l) => l.startsWith('HEAD'))).toHaveLength(4);
    expect(log.filter((l) => !l.startsWith('HEAD'))).toHaveLength(4);
    expect(read).toEqual([]);
  });

  it('does not retry via GET after network errors or when HEAD already proves the file is too large', async () => {
    const log: string[] = [];
    const stream = mockStream({
      [u('dns.png')]: { error: new HttpRequestError('ENOTFOUND', 'dns') },
      [u('huge.png')]: { headers: { 'content-length': '999999' } },
    }, log);
    const results = await inspectImages([u('dns.png'), u('huge.png')], { stream, mode: 'head', maxBytes: 1000 });
    expect(results.map((r) => r.status)).toEqual(['unreachable', 'uninspectable']);
    expect(log).toEqual([`HEAD ${u('dns.png')}`, `HEAD ${u('huge.png')}`]);
  });
});
