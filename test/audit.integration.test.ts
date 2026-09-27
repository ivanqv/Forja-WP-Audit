import { describe, expect, it } from 'vitest';
import { runAudit } from '../src/core/audit.js';
import { WordPressApiError } from '../src/core/wp-client.js';
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
});
