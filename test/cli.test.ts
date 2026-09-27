import { createServer, type Server } from 'node:http';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, main } from '../src/cli.js';
import type { Inventory } from '../src/core/types.js';
import { fakeImage } from './fixtures.js';
import { handleWpRequest } from './wp-mock.js';

const images: Record<string, { body: Buffer; status?: number; type?: string }> = {
  '/wp-content/uploads/hello.jpg': { body: fakeImage('h') },
  '/wp-content/uploads/hello-300x200.jpg': { body: fakeImage('s', 32) },
  '/wp-content/uploads/cover.jpg': { body: fakeImage('h') }, // same bytes as hello.jpg
};

let server: Server;
let siteUrl: string;
let outDir: string;
let headRequests = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
    headRequests += req.method === 'HEAD' ? 1 : 0;
    const img = images[req.url ?? ''];
    if (img) { res.writeHead(img.status ?? 200, { 'content-type': img.type ?? 'image/jpeg' }).end(img.body); return; }
    const r = handleWpRequest(
      {
        posts: [{ id: 7, link: `http://${req.headers.host}/hello/`, title: 'Hello', content: '<img src="/wp-content/uploads/hello.jpg" srcset="/wp-content/uploads/hello-300x200.jpg 300w">', featured_media: 3 }],
        pages: [{ id: 2, link: `http://${req.headers.host}/about/`, title: 'About', content: '<img src="/wp-content/uploads/hello.jpg">' }],
        media: [{ id: 3, source_url: `http://${req.headers.host}/wp-content/uploads/cover.jpg` }],
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
    // Backward compatibility: no image downloads and no duplicates section without --duplicates.
    expect(inv).not.toHaveProperty('duplicates');
    expect(Object.keys(inv)).toEqual(['schemaVersion', 'siteUrl', 'auditedAt', 'stats', 'images', 'domains', 'warnings']);
    expect(await readdir(outDir)).toEqual(['inventory.json']);
    expect(c.out.join('\n')).not.toContain('HTML report');
  });

  it('detects duplicates with --duplicates', async () => {
    const c = capture();
    const code = await main(['audit', siteUrl, '--duplicates', '-o', outDir, '--allow-private-network'], c.io);
    expect(code).toBe(EXIT_OK);
    expect(c.err.join('\n')).toContain('Inspected 3/3 images');
    expect(c.out.join('\n')).toContain("Exact duplicates:  1 group(s)");

    const inv = JSON.parse(await readFile(join(outDir, 'inventory.json'), 'utf8')) as Inventory;
    const d = inv.duplicates!;
    expect(d.inspection).toMatchObject({ attempted: 3, inspected: 3, failed: 0 });
    expect(d.exactDuplicates.map((g) => g.files.map((f) => f.filename))).toEqual([['cover.jpg', 'hello.jpg']]);
    expect(d.exactDuplicates[0]!.theoreticalDuplicateBytes).toBe(64);
    expect(d.responsiveFamilies.map((f) => f.baseName)).toEqual(['hello.jpg']);
    expect(inv.stats.uniqueImageUrls).toBe(3);
  });

  it('checks media health with --health using HEAD requests', async () => {
    const c = capture();
    headRequests = 0;
    const code = await main(['audit', siteUrl, '--health', '--allowed-domains', 'cdn.example.com', '-o', outDir, '--allow-private-network'], c.io);
    expect(code).toBe(EXIT_OK);
    expect(c.out.join('\n')).toContain('Media health:      3/3 healthy');
    expect(c.out.join('\n')).toContain('External image domains: none');
    expect(headRequests).toBe(3);

    const inv = JSON.parse(await readFile(join(outDir, 'inventory.json'), 'utf8')) as Inventory;
    expect(inv).not.toHaveProperty('duplicates');
    expect(inv.mediaHealth!.allowedDomains).toEqual(['cdn.example.com']);
    expect(inv.mediaHealth!.domains).toMatchObject([{ hostname: '127.0.0.1', classification: 'internal', imageUrls: 3, affectedPosts: 1, affectedPages: 1 }]);
  });

  it('also writes report.html with --html, leaving inventory.json unchanged', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forja-wp-audit-html-'));
    try {
      for (const flags of [[], ['--health'], ['--duplicates'], ['--health', '--duplicates']]) {
        const c = capture();
        expect(await main(['audit', siteUrl, ...flags, '--html', '-o', dir, '--allow-private-network'], c.io)).toBe(EXIT_OK);
        expect(c.out.join('\n')).toContain(`HTML report written to ${join(dir, 'report.html')}`);
        expect((await readdir(dir)).sort()).toEqual(['inventory.json', 'report.html']);
        const inv = JSON.parse(await readFile(join(dir, 'inventory.json'), 'utf8')) as Inventory;
        expect(Object.keys(inv).includes('mediaHealth')).toBe(flags.includes('--health'));
        const html = await readFile(join(dir, 'report.html'), 'utf8');
        expect(html).toContain('<h1>Media audit · 127.0.0.1</h1>');
        expect(html.includes('id="health"')).toBe(flags.includes('--health'));
        expect(html.includes('id="duplicates"')).toBe(flags.includes('--duplicates'));
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('blocks loopback targets by default', async () => {
    const c = capture();
    expect(await main(['audit', siteUrl, '--output', outDir], c.io)).toBe(EXIT_FAILURE);
    expect(c.err.join('\n')).toMatch(/private, loopback or link-local/);
  });

  it.each([[[]], [['audit']], [['scan', 'https://example.com']], [['audit', 'example.com']], [['audit', 'https://example.com', '--bogus']],
    [['audit', 'https://example.com', '--allowed-domains', 'cdn.example.com']],
    [['audit', 'https://example.com', '--health', '--allowed-domains', 'https://evil.example/']]])(
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
