import type { StreamResponse, SafeStream } from '../src/core/safe-fetch.js';

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Synthetic "image": a PNG signature followed by a deterministic payload. */
export const fakeImage = (seed: string, size = 64) =>
  Buffer.concat([PNG_HEADER, Buffer.alloc(size - PNG_HEADER.length, seed)]);

export interface MockFile {
  body?: Buffer;
  status?: number;
  type?: string;
  headers?: Record<string, string>;
  error?: Error;
}

/** Mocked SafeStream serving synthetic files by URL. Unknown URLs return 404. */
export function mockStream(files: Record<string, MockFile>, log: string[] = []): SafeStream {
  return async (url): Promise<StreamResponse> => {
    log.push(url);
    const f = files[url] ?? { status: 404, type: 'text/html', body: Buffer.from('not found') };
    if (f.error) throw f.error;
    const body = f.body ?? Buffer.alloc(0);
    return {
      status: f.status ?? 200,
      url,
      headers: new Headers({ 'content-type': f.type ?? 'image/png', ...f.headers }),
      body: (async function* () {
        for (let i = 0; i < body.length; i += 16) yield body.subarray(i, i + 16);
      })(),
      cancel: () => {},
    };
  };
}
