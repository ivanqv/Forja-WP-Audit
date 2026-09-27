import { createHash } from 'node:crypto';
import { BlockedDestinationError, HttpRequestError, type RequestMethod, type SafeStream } from './safe-fetch.js';
import type { HealthReason, HealthStatus, ImageInspection } from './types.js';
import { mapLimit } from './wp-client.js';

export interface InspectOptions {
  stream: SafeStream;
  /**
   * `download` (default): GET the whole file and hash it (needed for duplicates).
   * `head`: HEAD request only, with a GET fallback whose body is never read.
   */
  mode?: 'download' | 'head';
  /** Parallel requests. Default 2. */
  concurrency?: number;
  /** Per-file size limit. Default 25 MiB. */
  maxBytes?: number;
  onProgress?: (done: number, total: number) => void;
}

const ACCEPT = 'image/avif,image/webp,image/*;q=0.8';

/**
 * Inspects each image URL once. Downloads are hashed while streaming (nothing is
 * kept in memory or written to disk). Failures are classified per image, never thrown.
 */
export async function inspectImages(urls: string[], options: InspectOptions): Promise<ImageInspection[]> {
  const { stream, mode = 'download', concurrency = 2, maxBytes = 25 * 1024 * 1024, onProgress } = options;
  let done = 0;
  return mapLimit(urls, concurrency, async (url) => {
    let result = await inspectOne(url, stream, maxBytes, mode === 'head' ? 'HEAD' : 'GET');
    // Servers that reject or misimplement HEAD (405, 403, 404, text/html...) get a second chance via GET.
    if (result.method === 'HEAD' && result.httpStatus !== undefined && result.status !== 'healthy' && result.status !== 'uninspectable') {
      result = await inspectOne(url, stream, maxBytes, 'GET', false);
    }
    onProgress?.(++done, urls.length);
    return result;
  });
}

async function inspectOne(url: string, stream: SafeStream, maxBytes: number, method: RequestMethod, hash = method === 'GET'): Promise<ImageInspection> {
  const fail = (status: HealthStatus, reason: HealthReason, error: string, extra: Partial<ImageInspection> = {}): ImageInspection =>
    ({ url, status, method, reason, error, ...extra });
  try {
    const res = await stream(url, ACCEPT, { method });
    const contentType = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    const httpStatus = res.status;
    const length = res.headers.has('content-length') ? Number(res.headers.get('content-length')) : undefined;
    const meta = { httpStatus, ...(contentType ? { contentType } : {}) };
    if (httpStatus < 200 || httpStatus >= 300) {
      res.cancel();
      const status = httpStatus === 404 || httpStatus === 410 ? 'missing' : 'inaccessible';
      return fail(status, 'http-status', `HTTP ${httpStatus}`, meta);
    }
    if (!contentType.startsWith('image/')) {
      res.cancel();
      return fail('unexpected-content', 'content-type', `Unexpected content type "${contentType || 'none'}"`, meta);
    }
    if (length !== undefined && length > maxBytes) {
      res.cancel();
      return fail('uninspectable', 'too-large', `File larger than ${maxBytes} bytes`, { ...meta, bytes: length });
    }
    if (!hash) {
      res.cancel(); // headers are enough: never download the body for a health check
      return { url, status: 'healthy', method, ...meta, ...(length !== undefined ? { bytes: length } : {}) };
    }
    const sha = createHash('sha256');
    let bytes = 0;
    for await (const chunk of res.body) {
      bytes += chunk.byteLength;
      if (bytes > maxBytes) {
        res.cancel();
        return fail('uninspectable', 'too-large', `File larger than ${maxBytes} bytes`, meta);
      }
      sha.update(chunk);
    }
    return { url, status: 'healthy', method, ...meta, bytes, sha256: sha.digest('hex') };
  } catch (err) {
    const message = (err as Error).message;
    if (err instanceof BlockedDestinationError) return fail('inaccessible', 'blocked', message);
    if (err instanceof HttpRequestError) {
      switch (err.kind) {
        case 'timeout': return fail('timeout', 'timeout', message);
        case 'dns': case 'connection': case 'redirect': return fail('unreachable', err.kind, message);
        case 'too-large': return fail('uninspectable', 'too-large', message);
      }
    }
    // Mid-body socket errors surface as plain errno errors.
    if ((err as NodeJS.ErrnoException).code) return fail('unreachable', 'connection', message);
    return fail('unknown', 'error', message);
  }
}
