import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BlockedDestinationError,
  createGuardedLookup,
  createSafeHttp,
  HttpRequestError,
  isPrivateAddress,
  parseRetryAfter,
  type Transport,
} from '../src/core/safe-fetch.js';

type Reply = Awaited<ReturnType<Transport>>;
export const reply = (status: number, body: string | Buffer = '', headers: Record<string, string> = {}): Reply => ({
  status,
  headers: new Headers(headers),
  body: (async function* () {
    if (body.length) yield Buffer.from(body);
  })(),
  cancel: () => {},
});
const fast = { retryBaseDelayMs: 1, maxRetryWaitMs: 5 };

describe('isPrivateAddress', () => {
  it.each(['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', 'not-an-ip'])(
    'blocks %s', (ip) => expect(isPrivateAddress(ip)).toBe(true),
  );
  it.each(['93.184.216.34', '8.8.8.8', '2606:4700::1111'])('allows %s', (ip) => expect(isPrivateAddress(ip)).toBe(false));
});

describe('createGuardedLookup', () => {
  const run = (lookup: ReturnType<typeof createGuardedLookup>, all: boolean) =>
    new Promise<unknown>((resolve, reject) => lookup('host.test', { all }, (err, address) => (err ? reject(err) : resolve(address))));

  it('rejects hostnames resolving to private addresses', async () => {
    const lookup = createGuardedLookup(false, async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }]);
    await expect(run(lookup, false)).rejects.toBeInstanceOf(BlockedDestinationError);
  });
  it('returns public addresses in both lookup modes', async () => {
    const lookup = createGuardedLookup(false, async () => [{ address: '93.184.216.34', family: 4 }]);
    await expect(run(lookup, false)).resolves.toBe('93.184.216.34');
    await expect(run(lookup, true)).resolves.toEqual([{ address: '93.184.216.34', family: 4 }]);
  });
});

describe('createSafeHttp with a mocked transport', () => {
  it('rejects private IP literals before connecting', async () => {
    const { fetch } = createSafeHttp({ transport: () => { throw new Error('should not connect'); } });
    await expect(fetch('http://[::1]:8080/')).rejects.toBeInstanceOf(BlockedDestinationError);
    await expect(fetch('http://169.254.169.254/latest')).rejects.toBeInstanceOf(BlockedDestinationError);
  });

  it('validates every redirect hop', async () => {
    const transport: Transport = async (url) =>
      url.hostname === 'public.example.com' ? reply(302, '', { location: 'http://169.254.169.254/latest/meta-data' }) : reply(200, 'secret');
    await expect(createSafeHttp({ transport }).fetch('https://public.example.com/')).rejects.toThrow(/Blocked request to 169\.254\.169\.254/);
  });

  it('follows safe redirects and returns the final URL', async () => {
    const transport: Transport = async (url) => (url.pathname === '/old' ? reply(301, '', { location: '/new' }) : reply(200, 'ok'));
    expect(await createSafeHttp({ transport }).fetch('https://example.com/old')).toMatchObject({ status: 200, url: 'https://example.com/new', body: 'ok' });
  });

  it('enforces the response size limit', async () => {
    const transport: Transport = async () => reply(200, 'x'.repeat(100));
    await expect(createSafeHttp({ transport, maxBytes: 10 }).fetch('https://example.com/')).rejects.toBeInstanceOf(HttpRequestError);
  });

  it('times out slow requests', async () => {
    const transport: Transport = (_, { signal }) => new Promise((_r, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
    await expect(createSafeHttp({ transport, timeoutMs: 20 }).fetch('https://example.com/')).rejects.toThrow(/timed out/);
  });

  it('retries 429 and transient 5xx a bounded number of times', async () => {
    const statuses = [429, 503, 200];
    let calls = 0;
    const transport: Transport = async () => reply(statuses[calls++]!, 'ok');
    expect((await createSafeHttp({ transport, ...fast }).fetch('https://example.com/')).status).toBe(200);
    expect(calls).toBe(3);

    calls = 0;
    const always503: Transport = async () => { calls++; return reply(503); };
    expect((await createSafeHttp({ transport: always503, retries: 2, ...fast }).fetch('https://example.com/')).status).toBe(503);
    expect(calls).toBe(3);
  });

  it('does not retry non-transient errors', async () => {
    let calls = 0;
    const transport: Transport = async () => { calls++; return reply(404); };
    await createSafeHttp({ transport, ...fast }).fetch('https://example.com/');
    expect(calls).toBe(1);
  });

  it('caps Retry-After waits', async () => {
    let calls = 0;
    const transport: Transport = async () => (calls++ === 0 ? reply(429, '', { 'retry-after': '3600' }) : reply(200, 'ok'));
    const started = Date.now();
    await createSafeHttp({ transport, maxRetryWaitMs: 20 }).fetch('https://example.com/');
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('classifies failures so callers can tell DNS, connection, timeout and redirect problems apart', async () => {
    const failWith = (code: string): Transport => async () => { throw Object.assign(new Error(code), { code }); };
    const kind = (p: Promise<unknown>) => p.then(() => 'ok', (e: HttpRequestError) => e.kind);
    expect(await kind(createSafeHttp({ transport: failWith('ENOTFOUND') }).stream('https://gone.example/', '*/*'))).toBe('dns');
    expect(await kind(createSafeHttp({ transport: failWith('ECONNREFUSED') }).stream('https://down.example/', '*/*'))).toBe('connection');
    const hang: Transport = (_, { signal }) => new Promise((_r, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
    expect(await kind(createSafeHttp({ transport: hang, timeoutMs: 20 }).stream('https://slow.example/', '*/*'))).toBe('timeout');
    const loop: Transport = async () => reply(302, '', { location: '/again' });
    expect(await kind(createSafeHttp({ transport: loop }).stream('https://loop.example/', '*/*'))).toBe('redirect');
    const broken: Transport = async () => reply(301, '', { location: 'http://[bad' });
    expect(await kind(createSafeHttp({ transport: broken }).stream('https://broken.example/', '*/*'))).toBe('redirect');
  });

  it('sends HEAD when asked and still validates every redirect hop', async () => {
    const seen: string[] = [];
    const transport: Transport = async (url, { method }) => {
      seen.push(`${method} ${url.hostname}`);
      return url.hostname === 'public.example.com' ? reply(302, '', { location: 'http://10.0.0.8/x.jpg' }) : reply(200);
    };
    await expect(createSafeHttp({ transport }).stream('https://public.example.com/x.jpg', 'image/*', { method: 'HEAD' }))
      .rejects.toBeInstanceOf(BlockedDestinationError);
    expect(seen).toEqual(['HEAD public.example.com']);
  });

  it('parses Retry-After seconds and dates', () => {
    expect(parseRetryAfter('5')).toBe(5000);
    expect(parseRetryAfter('Wed, 21 Oct 2015 07:28:10 GMT', Date.parse('Wed, 21 Oct 2015 07:28:00 GMT'))).toBe(10_000);
    expect(parseRetryAfter('soon')).toBeNull();
  });
});

describe('createSafeHttp with the real network transport', () => {
  let server: Server;
  let port = 0;
  const methods: string[] = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      methods.push(req.method!);
      res.writeHead(200, { 'content-type': 'text/plain' }).end('hello');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address();
    port = typeof addr === 'object' && addr ? addr.port : 0;
  });
  afterAll(() => server.close());

  it('checks the address at connect time (DNS rebinding)', async () => {
    // A public-looking hostname that resolves to loopback when the socket connects.
    const { fetch } = createSafeHttp({ lookup: async () => [{ address: '127.0.0.1', family: 4 }] });
    await expect(fetch(`http://rebind.example.com:${port}/`)).rejects.toBeInstanceOf(BlockedDestinationError);
    expect(methods).toHaveLength(0);
  });

  it('performs GET requests when the destination is allowed', async () => {
    const { fetch } = createSafeHttp({ allowPrivateNetwork: true });
    expect((await fetch(`http://127.0.0.1:${port}/`)).body).toBe('hello');
    expect(methods).toEqual(['GET']);
  });

  it('performs HEAD requests without a body', async () => {
    const { stream } = createSafeHttp({ allowPrivateNetwork: true });
    const res = await stream(`http://127.0.0.1:${port}/`, '*/*', { method: 'HEAD' });
    const chunks: Uint8Array[] = [];
    for await (const c of res.body) chunks.push(c);
    expect(res.status).toBe(200);
    expect(chunks).toEqual([]);
    expect(methods.at(-1)).toBe('HEAD');
  });
});
