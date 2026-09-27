import { describe, expect, it } from 'vitest';
import { BlockedDestinationError, createSafeFetch, HttpRequestError, isPrivateAddress } from '../src/core/safe-fetch.js';

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

describe('isPrivateAddress', () => {
  it.each(['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', 'not-an-ip'])(
    'blocks %s', (ip) => expect(isPrivateAddress(ip)).toBe(true),
  );
  it.each(['93.184.216.34', '8.8.8.8', '2606:4700::1111'])('allows %s', (ip) => expect(isPrivateAddress(ip)).toBe(false));
});

describe('createSafeFetch', () => {
  it('rejects hostnames resolving to private addresses', async () => {
    const f = createSafeFetch({ lookup: async () => [{ address: '10.0.0.5', family: 4 }], fetchImpl: () => { throw new Error('should not fetch'); } });
    await expect(f('https://internal.example.com/')).rejects.toBeInstanceOf(BlockedDestinationError);
  });

  it('rejects IP literals in private ranges', async () => {
    const f = createSafeFetch({ lookup: publicLookup });
    await expect(f('http://[::1]:8080/')).rejects.toBeInstanceOf(BlockedDestinationError);
  });

  it('validates every redirect hop', async () => {
    const fetchImpl = (async (url: URL) =>
      url.hostname === 'public.example.com'
        ? new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } })
        : new Response('secret')) as unknown as typeof fetch;
    const f = createSafeFetch({ lookup: publicLookup, fetchImpl });
    await expect(f('https://public.example.com/')).rejects.toThrow(/Blocked request to 169\.254\.169\.254/);
  });

  it('follows safe redirects and returns the final URL', async () => {
    const fetchImpl = (async (url: URL) =>
      url.pathname === '/old' ? new Response(null, { status: 301, headers: { location: '/new' } }) : new Response('ok')) as unknown as typeof fetch;
    const res = await createSafeFetch({ lookup: publicLookup, fetchImpl })('https://example.com/old');
    expect(res).toMatchObject({ status: 200, url: 'https://example.com/new', body: 'ok' });
  });

  it('enforces the response size limit', async () => {
    const fetchImpl = (async () => new Response('x'.repeat(100))) as unknown as typeof fetch;
    await expect(createSafeFetch({ lookup: publicLookup, fetchImpl, maxBytes: 10 })('https://example.com/')).rejects.toBeInstanceOf(HttpRequestError);
  });

  it('times out slow requests', async () => {
    const fetchImpl = ((_: URL, init: RequestInit) =>
      new Promise((_r, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)))) as unknown as typeof fetch;
    await expect(createSafeFetch({ lookup: publicLookup, fetchImpl, timeoutMs: 20 })('https://example.com/')).rejects.toThrow(/timed out/);
  });

  it('sends only GET requests', async () => {
    let method = '';
    const fetchImpl = (async (_: URL, init: RequestInit) => { method = init.method!; return new Response('ok'); }) as unknown as typeof fetch;
    await createSafeFetch({ lookup: publicLookup, fetchImpl })('https://example.com/');
    expect(method).toBe('GET');
  });
});
