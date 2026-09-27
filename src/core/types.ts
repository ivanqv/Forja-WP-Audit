/** Kind of WordPress content an image was found in. */
export type ContentType = 'post' | 'page';

/** How an image URL was discovered. */
export type ImageSource = 'img-src' | 'srcset' | 'featured';

/** A published post or page as returned by the WordPress REST API (only the fields we use). */
export interface ContentItem {
  type: ContentType;
  id: number;
  url: string;
  title: string;
  html: string;
  featuredMediaId: number | null;
}

/** A post or page that references an image. */
export interface ContentReference {
  type: ContentType;
  id: number;
  url: string;
  title: string;
}

/** One unique, normalized image URL and everywhere it appears. */
export interface ImageRecord {
  url: string;
  filename: string;
  hostname: string;
  /** Number of distinct posts/pages referencing this URL. */
  referenceCount: number;
  sources: ImageSource[];
  references: ContentReference[];
}

export interface DomainSummary {
  hostname: string;
  uniqueImageUrls: number;
  imageReferences: number;
}

export interface InventoryStats {
  postsAnalyzed: number;
  pagesAnalyzed: number;
  /** Distinct (post/page, image URL) pairs. */
  totalImageReferences: number;
  uniqueImageUrls: number;
}

export interface Inventory {
  schemaVersion: 1;
  siteUrl: string;
  auditedAt: string;
  stats: InventoryStats;
  images: ImageRecord[];
  domains: DomainSummary[];
  warnings: string[];
}
