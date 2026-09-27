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
  /** Present only when duplicate detection was requested (`--duplicates`). */
  duplicates?: DuplicateReport;
}

/** Result of downloading and hashing one image URL. */
export type ImageInspection =
  | { url: string; ok: true; sha256: string; bytes: number; contentType: string }
  | { url: string; ok: false; error: string; httpStatus?: number };

/** An inventory image plus its inspection data (null when inspection failed). */
export interface ObservedImage {
  url: string;
  filename: string;
  hostname: string;
  sha256: string | null;
  bytes: number | null;
  references: ContentReference[];
}

/**
 * Different URLs whose downloaded content has the same SHA-256.
 * URLs with the same path on different hosts or with different query strings (e.g. CDN
 * aliases) are counted as one stored file, never as recoverable duplicates.
 */
export interface ExactDuplicateGroup {
  sha256: string;
  bytes: number;
  urlCount: number;
  /** Distinct file paths among the URLs (after collapsing likely aliases). */
  distinctPathCount: number;
  kind: 'same-file-aliases' | 'separate-files';
  /** bytes × (distinctPathCount − 1). Theoretical; see DuplicateReport.estimate. */
  theoreticalDuplicateBytes: number;
  files: ObservedImage[];
}

/** Filenames that look like repeated uploads (photo.jpg, photo-1.jpg, photo-final.jpg). Never a confirmation. */
export interface FilenameCandidateGroup {
  hostname: string;
  baseName: string;
  /** What the hashes say about the members' contents. */
  hashEvidence: 'all-identical' | 'partially-identical' | 'all-different' | 'incomplete';
  members: ObservedImage[];
}

export interface ResponsiveVariant extends ObservedImage {
  kind: 'size' | 'scaled';
  width: number | null;
  height: number | null;
}

/** WordPress-generated sizes (photo-300x200.jpg, photo-scaled.jpg) linked to their original. */
export interface ResponsiveFamily {
  hostname: string;
  directory: string;
  baseName: string;
  /** Why these files are considered one family. */
  evidence: 'original-referenced' | 'srcset-siblings';
  original: ObservedImage | null;
  variants: ResponsiveVariant[];
}

export interface DuplicateReport {
  inspection: { attempted: number; inspected: number; failed: number; bytesDownloaded: number };
  failures: { url: string; error: string; httpStatus?: number }[];
  exactDuplicates: ExactDuplicateGroup[];
  filenameCandidates: FilenameCandidateGroup[];
  responsiveFamilies: ResponsiveFamily[];
  estimate: {
    theoreticalDuplicateBytes: number;
    basis: 'downloaded-size-of-identical-files-at-distinct-paths';
    note: string;
  };
}
