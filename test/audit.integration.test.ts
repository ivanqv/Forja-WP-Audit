import { describe, expect, it } from 'vitest';
import { runAudit } from '../src/core/audit.js';
import { WordPressApiError } from '../src/core/wp-client.js';
import { fakeImage, mockStream } from './fixtures.js';
import { mockFetch, type MockPost } from './wp-mock.js';

const posts: MockPost[] = Array.from({ length: 250 }, (_, i) => ({
  id: i + 1,
  link: `https://example.com/post-${i + 1}/`,
  title: `Post ${i + 1}`,
  content: i % 2 === 0 ? `<img src="/wp-content/uploads/shared.jpg"><img src="img-${i}.jpg">` : '<p>No images</p>',
  featured_media: i === 0 ? 900 : 0,
}));
const pages: MockPost[] = [
  { id: 1, link: 'https://example.com/about/', title: 'About &amp; Us', content: '<img src="https://old.example.org/logo.png" srcset="https://old.example.org/logo-2x.png 2x">' },
];
const media = [{ id: 900, source_url: 'https://example.com/wp-content/uploads/featured.jpg' }];
const now = () => new Date('2026-01-01T00:00:00Z');

describe('runAudit with mocked WordPress API', () => {
  it('paginates posts and pages and builds the inventory', async () => {
    const log: string[] = [];
    const inv = await runAudit('https://example.com', { fetch: mockFetch({ posts, pages, media }, log), now });

    expect(inv.stats).toEqual({ postsAnalyzed: 250, pagesAnalyzed: 1, totalImageReferences: 125 + 125 + 1 + 2, uniqueImageUrls: 1 + 125 + 1 + 2 });
    expect(log.filter((u) => u.includes('/posts?') && u.includes('&page='))).toHaveLength(3);
    expect(log.every((u) => u.startsWith('https://example.com/wp-json/'))).toBe(true);

    const shared = inv.images.find((i) => i.filename === 'shared.jpg')!;
    expect(shared.referenceCount).toBe(125);
    const featured = inv.images.find((i) => i.filename === 'featured.jpg')!;
    expect(featured.sources).toEqual(['featured']);
    expect(featured.references).toEqual([{ type: 'post', id: 1, url: 'https://example.com/post-1/', title: 'Post 1' }]);
    expect(inv.images.find((i) => i.filename === 'img-0.jpg')!.url).toBe('https://example.com/post-1/img-0.jpg');
    expect(inv.images.find((i) => i.filename === 'logo.png')!.references[0]!.title).toBe('About & Us');
    expect(inv.domains.map((d) => d.hostname)).toEqual(['example.com', 'old.example.org']);
    expect(inv.warnings).toEqual([]);
  });

  it('falls back to ?rest_route= when /wp-json/ is unavailable', async () => {
    const log: string[] = [];
    const inv = await runAudit('https://example.com/blog/', { fetch: mockFetch({ posts: posts.slice(0, 1), plainOnly: true }, log), now });
    expect(inv.stats.postsAnalyzed).toBe(1);
    expect(log.slice(1).every((u) => u.startsWith('https://example.com/blog/?rest_route=%2Fwp%2Fv2%2F'))).toBe(true);
  });

  it('explains when the REST API is restricted', async () => {
    const run = runAudit('https://example.com', { fetch: mockFetch({ forceStatus: 401 }), now });
    await expect(run).rejects.toBeInstanceOf(WordPressApiError);
    await expect(run).rejects.toThrow(/REST API is not available.*HTTP 401/);
  });

  it('warns instead of failing when featured media cannot be resolved', async () => {
    const inv = await runAudit('https://example.com', { fetch: mockFetch({ posts: posts.slice(0, 1), media: [] }), now });
    expect(inv.images.map((i) => i.filename)).toEqual(['img-0.jpg', 'shared.jpg']);
  });

  it('inspects images and records failures without aborting the audit', async () => {
    const site = {
      posts: [{ id: 1, link: 'https://example.com/a/', title: 'A', content: '<img src="/u/x.jpg"><img src="/u/x-1.jpg"><img src="https://ext.example.org/x.jpg"><img src="/u/missing.jpg">' }],
    };
    const log: string[] = [];
    const inv = await runAudit('https://example.com', {
      fetch: mockFetch(site),
      stream: mockStream({
        'https://example.com/u/x.jpg': { body: fakeImage('x') },
        'https://example.com/u/x-1.jpg': { body: fakeImage('x') },
        'https://ext.example.org/x.jpg': { body: fakeImage('x') },
      }, log),
      duplicates: true,
      now,
    });
    const d = inv.duplicates!;
    expect(log).toHaveLength(4);
    expect(d.inspection).toMatchObject({ attempted: 4, inspected: 3, failed: 1 });
    expect(d.failures[0]).toMatchObject({ url: 'https://example.com/u/missing.jpg', httpStatus: 404 });
    expect(d.exactDuplicates[0]).toMatchObject({ urlCount: 3, distinctPathCount: 3, theoreticalDuplicateBytes: 128 });
    expect(d.filenameCandidates[0]).toMatchObject({ baseName: 'x.jpg', hashEvidence: 'all-identical' });
    expect(d.exactDuplicates[0]!.files[0]!.references).toEqual([{ type: 'post', id: 1, url: 'https://example.com/a/', title: 'A' }]);
  });

  const healthSite = {
    posts: [
      { id: 1, link: 'https://example.com/a/', title: 'A', content: '<img src="/u/x.jpg"><img src="/blank.gif" data-src="/u/lazy.jpg"><img src="https://cdn.example.net/c.jpg"><img src="https://old.example.org/o.jpg">' },
      { id: 2, link: 'https://example.com/b/', title: 'B', content: '<img src="/u/missing.jpg"><img src="https://old.example.org/o.jpg">' },
    ],
  };
  const healthFiles = {
    'https://example.com/u/x.jpg': { body: fakeImage('x') },
    'https://example.com/u/lazy.jpg': { body: fakeImage('x') },
    'https://cdn.example.net/c.jpg': { body: fakeImage('c'), head: { status: 405 } },
    'https://old.example.org/o.jpg': { status: 403 },
  };

  it('checks media health with HEAD only, never downloading bodies', async () => {
    const log: string[] = [];
    const read: string[] = [];
    const inv = await runAudit('https://example.com', {
      fetch: mockFetch(healthSite), stream: mockStream(healthFiles, log, read), health: true, allowedDomains: ['cdn.example.net'], now,
    });
    expect(inv).not.toHaveProperty('duplicates');
    const h = inv.mediaHealth!;
    expect(h.inspection).toEqual({ mode: 'head', attempted: 5, getFallbacks: 3 });
    expect(read).toEqual([]);
    expect(Object.fromEntries(h.images.map((i) => [i.url.split('/').pop(), i.status]))).toEqual({
      'c.jpg': 'healthy', 'o.jpg': 'inaccessible', 'lazy.jpg': 'healthy', 'missing.jpg': 'missing', 'x.jpg': 'healthy',
    });
    expect(h.domains.map((d) => [d.hostname, d.classification])).toEqual([['old.example.org', 'external'], ['cdn.example.net', 'allowed'], ['example.com', 'internal']]);
    expect(h.domains[0]).toMatchObject({ affectedPosts: 2, health: { inaccessible: 1 } });
    expect(h.summary).toMatchObject({ affectedPosts: 2, affectedPages: 0, externalDependencyDomains: 1 });
    expect(inv.images.some((i) => i.filename === 'blank.gif')).toBe(false);
  });

  it('shares one download per URL between --health and --duplicates', async () => {
    const log: string[] = [];
    const read: string[] = [];
    const inv = await runAudit('https://example.com', {
      fetch: mockFetch(healthSite), stream: mockStream(healthFiles, log, read), health: true, duplicates: true, now,
    });
    expect(log).toHaveLength(5);
    expect(new Set(log).size).toBe(5);
    expect(log.some((l) => l.startsWith('HEAD'))).toBe(false);
    expect(inv.mediaHealth!.inspection).toEqual({ mode: 'download', attempted: 5, getFallbacks: 0 });
    expect(inv.mediaHealth!.summary.byStatus).toMatchObject({ healthy: 3, missing: 1, inaccessible: 1 });
    expect(inv.duplicates!.exactDuplicates[0]!.files.map((f) => f.filename)).toEqual(['lazy.jpg', 'x.jpg']);
    expect(inv.duplicates!.inspection).toMatchObject({ attempted: 5, inspected: 3, failed: 2 });
  });

  it('rejects unsafe allowed-domain entries before any request', async () => {
    const log: string[] = [];
    await expect(runAudit('https://example.com', { fetch: mockFetch(healthSite, log), health: true, allowedDomains: ['https://cdn.example.net/'] }))
      .rejects.toThrow(/Invalid allowed domain/);
    expect(log).toEqual([]);
  });
});
