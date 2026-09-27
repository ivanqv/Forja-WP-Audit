import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { inspectImages } from '../src/core/inspect.js';
import { HttpRequestError } from '../src/core/safe-fetch.js';
import { fakeImage, mockStream } from './fixtures.js';

const u = (name: string) => `https://example.com/wp-content/uploads/${name}`;

describe('inspectImages', () => {
  it('computes SHA-256 and size of the streamed bytes', async () => {
    const body = fakeImage('a', 100);
    const [r] = await inspectImages([u('a.png')], { stream: mockStream({ [u('a.png')]: { body } }) });
    expect(r).toEqual({ url: u('a.png'), ok: true, sha256: createHash('sha256').update(body).digest('hex'), bytes: 100, contentType: 'image/png' });
    const [abc] = await inspectImages([u('abc')], { stream: mockStream({ [u('abc')]: { body: Buffer.from('abc') } }) });
    expect(abc!.ok && abc!.sha256).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('records failures per image without aborting the rest', async () => {
    const stream = mockStream({
      [u('ok.png')]: { body: fakeImage('o') },
      [u('gone.png')]: { status: 404, body: Buffer.from('nope') },
      [u('page.png')]: { type: 'text/html', body: Buffer.from('<html>') },
      [u('big.png')]: { body: fakeImage('b', 2000) },
      [u('huge.png')]: { body: fakeImage('h', 64), headers: { 'content-length': '999999' } },
      [u('slow.png')]: { error: new HttpRequestError('Request timed out after 15000 ms') },
    });
    const results = await inspectImages(['ok.png', 'gone.png', 'page.png', 'big.png', 'huge.png', 'slow.png'].map(u), { stream, maxBytes: 1000 });
    expect(results.map((r) => (r.ok ? 'ok' : r.error))).toEqual([
      'ok',
      'HTTP 404',
      'Unexpected content type "text/html"',
      'File larger than 1000 bytes',
      'File larger than 1000 bytes',
      'Request timed out after 15000 ms',
    ]);
    expect(results[1]).toMatchObject({ httpStatus: 404 });
  });

  it('limits concurrent downloads to 2 by default and reports progress', async () => {
    let inFlight = 0;
    let max = 0;
    const base = mockStream(Object.fromEntries(['1', '2', '3', '4', '5'].map((n) => [u(n), { body: fakeImage(n) }])));
    const stream = async (url: string, accept: string) => {
      inFlight++;
      max = Math.max(max, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return base(url, accept);
    };
    const progress: number[] = [];
    await inspectImages(['1', '2', '3', '4', '5'].map(u), { stream, onProgress: (d) => progress.push(d) });
    expect(max).toBe(2);
    expect(progress).toEqual([1, 2, 3, 4, 5]);
  });
});
