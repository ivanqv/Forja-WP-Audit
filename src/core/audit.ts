import { buildInventory } from './inventory.js';
import { createSafeFetch, type SafeFetch } from './safe-fetch.js';
import type { ContentType, Inventory } from './types.js';
import { parseSiteUrl } from './url.js';
import { WpClient } from './wp-client.js';

export type AuditProgress =
  | { stage: 'detect' }
  | { stage: 'content'; type: ContentType; page: number; totalPages: number }
  | { stage: 'media'; count: number };

export interface AuditOptions {
  /** Custom fetcher (tests, alternative transports). Defaults to the SSRF-protected fetcher. */
  fetch?: SafeFetch;
  allowPrivateNetwork?: boolean;
  concurrency?: number;
  onProgress?: (event: AuditProgress) => void;
  now?: () => Date;
}

/** Discovers images referenced by a WordPress site's published posts and pages. Read-only. */
export async function runAudit(siteUrlInput: string, options: AuditOptions = {}): Promise<Inventory> {
  const siteUrl = parseSiteUrl(siteUrlInput);
  const fetch = options.fetch ?? createSafeFetch({ allowPrivateNetwork: options.allowPrivateNetwork });
  const onProgress = options.onProgress ?? (() => {});
  const client = new WpClient(siteUrl, {
    fetch,
    concurrency: options.concurrency,
    onPage: (type, page, totalPages) => onProgress({ stage: 'content', type, page, totalPages }),
  });

  onProgress({ stage: 'detect' });
  await client.detect();
  const posts = await client.fetchContent('post');
  const pages = await client.fetchContent('page');
  const items = [...posts, ...pages];

  const warnings: string[] = [];
  const featuredIds = items.flatMap((i) => (i.featuredMediaId ? [i.featuredMediaId] : []));
  let featuredMedia = new Map<number, string>();
  if (featuredIds.length > 0) {
    onProgress({ stage: 'media', count: new Set(featuredIds).size });
    try {
      featuredMedia = await client.fetchMediaUrls(featuredIds);
    } catch (err) {
      warnings.push(`Featured images could not be resolved: ${(err as Error).message}`);
    }
    const missing = new Set(featuredIds.filter((id) => !featuredMedia.has(id))).size;
    if (missing > 0 && featuredMedia.size > 0) {
      warnings.push(`${missing} featured media item(s) were not returned by the public media endpoint.`);
    }
  }

  return buildInventory({
    siteUrl: siteUrl.href,
    auditedAt: (options.now ?? (() => new Date()))(),
    items,
    featuredMedia,
    warnings,
  });
}
