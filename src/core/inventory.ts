import { extractImageRefs } from './extract.js';
import { filenameFromUrl, hostnameFromUrl, normalizeImageUrl } from './url.js';
import type { ContentItem, ContentReference, DomainSummary, ImageRecord, ImageSource, Inventory } from './types.js';

export interface BuildInventoryInput {
  siteUrl: string;
  auditedAt: Date;
  items: ContentItem[];
  /** Featured media id -> source URL. */
  featuredMedia: Map<number, string>;
  warnings?: string[];
}

interface Entry {
  sources: Set<ImageSource>;
  refs: Map<string, ContentReference>;
}

/**
 * Aggregates image references from posts/pages into a deduplicated inventory.
 * Each distinct URL (including every srcset variant) is its own record; a post
 * referencing the same URL several times counts once.
 */
export function buildInventory(input: BuildInventoryInput): Inventory {
  const byUrl = new Map<string, Entry>();

  const add = (rawUrl: string, source: ImageSource, item: ContentItem) => {
    const url = normalizeImageUrl(rawUrl, item.url);
    if (!url) return;
    let entry = byUrl.get(url);
    if (!entry) {
      entry = { sources: new Set(), refs: new Map() };
      byUrl.set(url, entry);
    }
    entry.sources.add(source);
    entry.refs.set(`${item.type}:${item.id}`, { type: item.type, id: item.id, url: item.url, title: item.title });
  };

  for (const item of input.items) {
    for (const ref of extractImageRefs(item.html)) add(ref.url, ref.source, item);
    if (item.featuredMediaId) {
      const featured = input.featuredMedia.get(item.featuredMediaId);
      if (featured) add(featured, 'featured', item);
    }
  }

  const images: ImageRecord[] = [...byUrl.entries()]
    .map(([url, entry]) => ({
      url,
      filename: filenameFromUrl(url),
      hostname: hostnameFromUrl(url),
      referenceCount: entry.refs.size,
      sources: [...entry.sources].sort(),
      references: [...entry.refs.values()],
    }))
    .sort((a, b) => a.url.localeCompare(b.url));

  const domainMap = new Map<string, DomainSummary>();
  for (const img of images) {
    const d = domainMap.get(img.hostname) ?? { hostname: img.hostname, uniqueImageUrls: 0, imageReferences: 0 };
    d.uniqueImageUrls++;
    d.imageReferences += img.referenceCount;
    domainMap.set(img.hostname, d);
  }
  const domains = [...domainMap.values()].sort((a, b) => b.uniqueImageUrls - a.uniqueImageUrls || a.hostname.localeCompare(b.hostname));

  return {
    schemaVersion: 1,
    siteUrl: input.siteUrl,
    auditedAt: input.auditedAt.toISOString(),
    stats: {
      postsAnalyzed: input.items.filter((i) => i.type === 'post').length,
      pagesAnalyzed: input.items.filter((i) => i.type === 'page').length,
      totalImageReferences: images.reduce((n, i) => n + i.referenceCount, 0),
      uniqueImageUrls: images.length,
    },
    images,
    domains,
    warnings: input.warnings ?? [],
  };
}
