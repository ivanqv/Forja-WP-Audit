import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, main } from '../src/cli.js';
import type { Inventory } from '../src/core/types.js';
import { handleWpRequest } from './wp-mock.js';

let server: Server;
let siteUrl: string;
let outDir: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    const r = handleWpRequest(
      {
        posts: [{ id: 7, link: 'http://127.0.0.1/hello/', title: 'Hello', content: '<img src="/wp-content/uploads/hello.jpg" srcset="/wp-content/uploads/hello-300x200.jpg 300w">', featured_media: 3 }],
        pages: [{ id: 2, link: 'http://127.0.0.1/about/', title: 'About', content: '<img src="/wp-content/uploads/hello.jpg">' }],
        media: [{ id: 3, source_url: 'http://127.0.0.1/wp-content/uploads/cover.jpg' }],
      },
      `http://127.0.0.1${req.url}`,
    );
    res.writeHead(r.status, Object.fromEntries(r.headers)).end(r.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  siteUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  outDir = await mkdtemp(join(tmpdir(), 'forja-wp-audit-'));
});

afterAll(async () => {
  server.close();
  await rm(outDir, { recursive: true, force: true });
});

const capture = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l) }, out, err };
};

describe('cli', () => {
  it('audits a (local, mocked) WordPress site end to end and writes inventory.json', async () => {
    const c = capture();
    const code = await main(['audit', siteUrl, '--output', outDir, '--allow-private-network'], c.io);
    expect(code).toBe(EXIT_OK);
    expect(c.err.join('\n')).toContain('Fetched posts page 1/1');
    expect(c.out.join('\n')).toContain('Unique image URLs: 3');

    const inv = JSON.parse(await readFile(join(outDir, 'inventory.json'), 'utf8')) as Inventory;
    expect(inv.stats).toEqual({ postsAnalyzed: 1, pagesAnalyzed: 1, totalImageReferences: 4, uniqueImageUrls: 3 });
    expect(inv.images.find((i) => i.filename === 'hello.jpg')!.references.map((r) => r.title)).toEqual(['Hello', 'About']);
  });

  it('blocks loopback targets by default', async () => {
    const c = capture();
    expect(await main(['audit', siteUrl, '--output', outDir], c.io)).toBe(EXIT_FAILURE);
    expect(c.err.join('\n')).toMatch(/private, loopback or link-local/);
  });

  it.each([[[]], [['audit']], [['scan', 'https://example.com']], [['audit', 'example.com']], [['audit', 'https://example.com', '--bogus']]])(
    'returns a usage error for %j', async (argv) => {
      expect(await main(argv, capture().io)).toBe(EXIT_USAGE);
    },
  );

  it('prints help', async () => {
    const c = capture();
    expect(await main(['--help'], c.io)).toBe(EXIT_OK);
    expect(c.out[0]).toMatch(/^Usage:/);
  });
});
