import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

export class BlockedDestinationError extends Error {}
export class HttpRequestError extends Error {}

export interface HttpResponse {
  status: number;
  url: string;
  headers: Headers;
  body: string;
}

/** A response whose body has not been read yet. Callers must consume or `cancel()` it. */
export interface StreamResponse {
  status: number;
  url: string;
  headers: Headers;
  body: AsyncIterable<Uint8Array>;
  cancel: () => void;
}

export type Lookup = (hostname: string) => Promise<{ address: string; family: number }[]>;

/** Low-level GET used by the safe client; injectable for tests. */
export type Transport = (
  url: URL,
  init: { signal: AbortSignal; headers: Record<string, string>; lookup: LookupFunction },
) => Promise<{ status: number; headers: Headers; body: AsyncIterable<Uint8Array>; cancel: () => void }>;

export interface SafeFetchOptions {
  /** Allow loopback/private/link-local destinations (tests, local development). Default false. */
  allowPrivateNetwork?: boolean;
  /** Per-attempt timeout covering connection, headers and body. */
  timeoutMs?: number;
  /** Response size cap for `fetch` (text) responses. */
  maxBytes?: number;
  maxRedirects?: number;
  /** Retries for HTTP 429 and transient 5xx responses. Default 2. */
  retries?: number;
  /** Base delay for exponential backoff when no Retry-After is sent. */
  retryBaseDelayMs?: number;
  /** Upper bound for any single wait, including Retry-After. */
  maxRetryWaitMs?: number;
  transport?: Transport;
  lookup?: Lookup;
}

export type SafeFetch = (url: string) => Promise<HttpResponse>;
export type SafeStream = (url: string, accept: string) => Promise<StreamResponse>;

export interface SafeHttp {
  fetch: SafeFetch;
  stream: SafeStream;
}

const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
] as const) blocked.addSubnet(net, prefix, 'ipv6');

/** True for loopback, private, link-local, CGNAT, multicast and reserved addresses (IPv4-mapped IPv6 included). */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blocked.check(address, 'ipv4');
  if (family === 6) return blocked.check(address, 'ipv6');
  return true;
}

const defaultLookup: Lookup = (hostname) => dnsLookup(hostname, { all: true });

/**
 * DNS lookup used by the socket itself: the address that is validated is the
 * address that is connected to, so DNS rebinding between check and connect is not possible.
 */
export function createGuardedLookup(allowPrivateNetwork: boolean, resolve: Lookup = defaultLookup): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname).then(
      (addresses) => {
        const first = addresses[0];
        if (!first || (!allowPrivateNetwork && addresses.some((a) => isPrivateAddress(a.address)))) {
          callback(blockedError(hostname), '', 0);
          return;
        }
        if (options.all) (callback as unknown as (e: null, a: typeof addresses) => void)(null, addresses);
        else callback(null, first.address, first.family);
      },
      (err: NodeJS.ErrnoException) => callback(err, '', 0),
    );
  };
}

const blockedError = (host: string) =>
  new BlockedDestinationError(`Blocked request to ${host}: it resolves to a private, loopback or link-local address.`);

const defaultTransport: Transport = (url, { signal, headers, lookup }) =>
  new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    // agent: false → a fresh socket per request, so every connection goes through the guarded lookup.
    const req = client.get(url, { headers, signal, lookup, agent: false }, (res) => {
      const h = new Headers();
      for (const [k, v] of Object.entries(res.headers)) {
        if (v !== undefined) h.set(k, Array.isArray(v) ? v.join(', ') : v);
      }
      resolve({ status: res.statusCode ?? 0, headers: h, body: res, cancel: () => res.destroy() });
    });
    req.on('error', reject);
  });

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

/** Parses Retry-After (seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  if (/^\d+$/.test(value.trim())) return Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

/**
 * Read-only GET client with SSRF protection: every hop (including redirects) must be
 * http(s); IP literals are checked up front and hostnames are checked at connect time.
 * Requests are bounded by a timeout, retried a bounded number of times on 429/5xx, and
 * text responses are size-capped.
 */
export function createSafeHttp(options: SafeFetchOptions = {}): SafeHttp {
  const {
    allowPrivateNetwork = false,
    timeoutMs = 15_000,
    maxBytes = 32 * 1024 * 1024,
    maxRedirects = 5,
    retries = 2,
    retryBaseDelayMs = 500,
    maxRetryWaitMs = 10_000,
    transport = defaultTransport,
  } = options;
  const lookup = createGuardedLookup(allowPrivateNetwork, options.lookup);

  const assertAllowed = (url: URL) => {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new BlockedDestinationError(`Blocked non-http(s) destination: ${url.protocol}`);
    }
    const host = url.hostname.replace(/^\[|\]$/g, '');
    // Sockets skip DNS lookup for IP literals, so they must be checked here.
    if (!allowPrivateNetwork && isIP(host) && isPrivateAddress(host)) throw blockedError(url.hostname);
  };

  const attempt = async (input: string, accept: string): Promise<StreamResponse> => {
    let url = new URL(input);
    const signal = AbortSignal.timeout(timeoutMs);
    const where = () => `${url.origin}${url.pathname}`;
    for (let hop = 0; hop <= maxRedirects; hop++) {
      assertAllowed(url);
      let res: Awaited<ReturnType<Transport>>;
      try {
        res = await transport(url, { signal, lookup, headers: { accept, 'user-agent': 'forja-wp-audit' } });
      } catch (err) {
        if (err instanceof BlockedDestinationError) throw err;
        if (signal.aborted) throw new HttpRequestError(`Request timed out after ${timeoutMs} ms: ${where()}`);
        throw new HttpRequestError(`Request failed for ${where()}: ${(err as Error).message}`);
      }
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        res.cancel();
        url = new URL(location, url);
        continue;
      }
      const body = (async function* () {
        try {
          for await (const chunk of res.body) yield chunk;
        } catch (err) {
          if (signal.aborted) throw new HttpRequestError(`Request timed out after ${timeoutMs} ms: ${where()}`);
          throw err;
        }
      })();
      return { status: res.status, url: url.href, headers: res.headers, body, cancel: res.cancel };
    }
    throw new HttpRequestError(`Too many redirects (more than ${maxRedirects}).`);
  };

  const stream: SafeStream = async (url, accept) => {
    for (let n = 0; ; n++) {
      const res = await attempt(url, accept);
      if (!RETRYABLE.has(res.status) || n >= retries) return res;
      res.cancel();
      const wait = parseRetryAfter(res.headers.get('retry-after')) ?? retryBaseDelayMs * 2 ** n;
      await sleep(Math.min(wait, maxRetryWaitMs));
    }
  };

  const fetch: SafeFetch = async (url) => {
    const res = await stream(url, 'application/json');
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of res.body) {
      size += chunk.byteLength;
      if (size > maxBytes) {
        res.cancel();
        throw new HttpRequestError(`Response exceeded ${maxBytes} bytes.`);
      }
      chunks.push(chunk);
    }
    return { status: res.status, url: res.url, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') };
  };

  return { fetch, stream };
}

/** Text-only convenience wrapper (Sprint 01 API). */
export function createSafeFetch(options: SafeFetchOptions = {}): SafeFetch {
  return createSafeHttp(options).fetch;
}
