import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

export class BlockedDestinationError extends Error {}
export class HttpRequestError extends Error {}

export interface HttpResponse {
  status: number;
  url: string;
  headers: Headers;
  body: string;
}

export type Lookup = (hostname: string) => Promise<{ address: string; family: number }[]>;

export interface SafeFetchOptions {
  /** Allow loopback/private/link-local destinations (tests, local development). Default false. */
  allowPrivateNetwork?: boolean;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  fetchImpl?: typeof fetch;
  lookup?: Lookup;
}

export type SafeFetch = (url: string) => Promise<HttpResponse>;

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
 * Creates a read-only GET fetcher with SSRF protection: every hop (including
 * redirects) must be http(s) and resolve only to public addresses, responses are
 * size-capped and the whole request is bounded by a timeout.
 *
 * ponytail: checks DNS before connecting, so a DNS-rebinding race remains possible;
 * pin the resolved IP in a custom undici dispatcher if that threat matters.
 */
export function createSafeFetch(options: SafeFetchOptions = {}): SafeFetch {
  const {
    allowPrivateNetwork = false,
    timeoutMs = 15_000,
    maxBytes = 32 * 1024 * 1024,
    maxRedirects = 5,
    fetchImpl = fetch,
    lookup = defaultLookup,
  } = options;

  const assertAllowed = async (url: URL) => {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new BlockedDestinationError(`Blocked non-http(s) destination: ${url.protocol}`);
    }
    if (allowPrivateNetwork) return;
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = isIP(host) ? [host] : (await lookup(host)).map((a) => a.address);
    if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
      throw new BlockedDestinationError(
        `Blocked request to ${url.hostname}: it resolves to a private, loopback or link-local address.`,
      );
    }
  };

  return async (input) => {
    let url = new URL(input);
    const signal = AbortSignal.timeout(timeoutMs);
    for (let hop = 0; hop <= maxRedirects; hop++) {
      await assertAllowed(url);
      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: 'GET',
          redirect: 'manual',
          signal,
          headers: { accept: 'application/json', 'user-agent': 'forja-wp-audit' },
        });
      } catch (err) {
        if (signal.aborted) throw new HttpRequestError(`Request timed out after ${timeoutMs} ms: ${url.origin}${url.pathname}`);
        throw new HttpRequestError(`Request failed for ${url.origin}${url.pathname}: ${(err as Error).message}`);
      }
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        await res.body?.cancel();
        url = new URL(location, url);
        continue;
      }
      try {
        return { status: res.status, url: url.href, headers: res.headers, body: await readCapped(res, maxBytes) };
      } catch (err) {
        if (signal.aborted) throw new HttpRequestError(`Request timed out after ${timeoutMs} ms: ${url.origin}${url.pathname}`);
        throw err;
      }
    }
    throw new HttpRequestError(`Too many redirects (more than ${maxRedirects}).`);
  };
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new HttpRequestError(`Response exceeded ${maxBytes} bytes.`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
