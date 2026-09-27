import { describe, expect, it } from 'vitest';
import { buildInventory } from '../src/core/inventory.js';
import type { ContentItem } from '../src/core/types.js';

const item = (over: Partial<ContentItem>): ContentItem => ({
  type: 'post', id: 1, url: 'https://example.com/post-1/', title: 'Post 1', html: '', featuredMediaId: null, ...over,
});

describe('buildInventory', () => {
  const inventory = buildInventory({
    siteUrl: 'https://example.com',
    auditedAt: new Date('2026-01-01T00:00:00Z'),
    items: [
      item({ id: 1, html: '<img src="/u/a.jpg"><img src="https://example.com/u/a.jpg#x"><img src="/u/a.jpg" srcset="/u/a-300.jpg 300w">', featuredMediaId: 10 }),
      item({ id: 2, url: 'https://example.com/post-2/', title: 'Post 2', html: '<img src="https://old.example.org/b.png">' }),
      item({ type: 'page', id: 1, url: 'https://example.com/about/', title: 'About', html: '<img src="/u/a.jpg">' }),
    ],
    featuredMedia: new Map([[10, 'https://example.com/u/a.jpg']]),
  });

  it('deduplicates repeated URLs and counts each post/page once', () => {
    const a = inventory.images.find((i) => i.url === 'https://example.com/u/a.jpg')!;
    expect(a.referenceCount).toBe(2);
    expect(a.references.map((r) => `${r.type}:${r.id}`)).toEqual(['post:1', 'page:1']);
    expect(a.sources).toEqual(['featured', 'img-src']);
  });

  it('keeps responsive variants as separate records', () => {
    expect(inventory.images.map((i) => i.filename)).toEqual(['a-300.jpg', 'a.jpg', 'b.png']);
  });

  it('computes stats and domain summary', () => {
    expect(inventory.stats).toEqual({ postsAnalyzed: 2, pagesAnalyzed: 1, totalImageReferences: 4, uniqueImageUrls: 3 });
    expect(inventory.domains).toEqual([
      { hostname: 'example.com', uniqueImageUrls: 2, imageReferences: 3 },
      { hostname: 'old.example.org', uniqueImageUrls: 1, imageReferences: 1 },
    ]);
    expect(inventory.auditedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('deduplicates lazy-loaded and plain references while keeping every discovery source', () => {
    const inv = buildInventory({
      siteUrl: 'https://example.com',
      auditedAt: new Date(0),
      items: [
        item({ html: '<img src="/blank.gif" data-src="/u/a.jpg"><img src="/u/a.jpg"><img data-srcset="/u/a.jpg 1x">' }),
        item({ id: 2, url: 'https://example.com/post-2/', html: '<img src="/blank.gif" data-src="/u/a.jpg">' }),
      ],
      featuredMedia: new Map(),
    });
    expect(inv.images.map((i) => [i.filename, i.sources, i.referenceCount])).toEqual([['a.jpg', ['data-src', 'data-srcset', 'img-src'], 2]]);
  });

  it('distinguishes posts and pages with the same id', () => {
    const empty = buildInventory({ siteUrl: 'https://example.com', auditedAt: new Date(), items: [], featuredMedia: new Map() });
    expect(empty.stats.uniqueImageUrls).toBe(0);
    expect(empty.domains).toEqual([]);
  });
});
