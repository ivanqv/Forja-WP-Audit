import { createHash } from 'node:crypto';
import type { SafeStream } from './safe-fetch.js';
import type { ImageInspection } from './types.js';
import { mapLimit } from './wp-client.js';

export interface InspectOptions {
  stream: SafeStream;
  /** Parallel downloads. Default 2. */
  concurrency?: number;
  /** Per-file size limit. Default 25 MiB. */
  maxBytes?: number;
  onProgress?: (done: number, total: number) => void;
}

const ACCEPT = 'image/avif,image/webp,image/*;q=0.8';

/**
 * Downloads each image once and hashes it while streaming (nothing is kept in
 * memory or written to disk). Failures are recorded per image, never thrown.
 */
export async function inspectImages(urls: string[], options: InspectOptions): Promise<ImageInspection[]> {
  const { stream, concurrency = 2, maxBytes = 25 * 1024 * 1024, onProgress } = options;
  let done = 0;
  return mapLimit(urls, concurrency, async (url) => {
    const result = await inspectOne(url, stream, maxBytes);
    onProgress?.(++done, urls.length);
    return result;
  });
}

async function inspectOne(url: string, stream: SafeStream, maxBytes: number): Promise<ImageInspection> {
  const fail = (error: string, httpStatus?: number): ImageInspection => ({ url, ok: false, error, ...(httpStatus ? { httpStatus } : {}) });
  try {
    const res = await stream(url, ACCEPT);
    const contentType = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (res.status !== 200) {
      res.cancel();
      return fail(`HTTP ${res.status}`, res.status);
    }
    if (!contentType.startsWith('image/')) {
      res.cancel();
      return fail(`Unexpected content type "${contentType || 'none'}"`, res.status);
    }
    if (Number(res.headers.get('content-length')) > maxBytes) {
      res.cancel();
      return fail(`File larger than ${maxBytes} bytes`, res.status);
    }
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of res.body) {
      bytes += chunk.byteLength;
      if (bytes > maxBytes) {
        res.cancel();
        return fail(`File larger than ${maxBytes} bytes`, res.status);
      }
      hash.update(chunk);
    }
    return { url, ok: true, sha256: hash.digest('hex'), bytes, contentType };
  } catch (err) {
    return fail((err as Error).message);
  }
}
