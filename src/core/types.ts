/** Kind of WordPress content an image was found in. */
export type ContentType = 'post' | 'page';

/** How an image URL was discovered. `data-src`/`data-srcset` are lazy-loading attributes. */
export type ImageSource = 'img-src' | 'srcset' | 'data-src' | 'data-srcset' | 'featured';

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
  /** Present only when a health check was requested (`--health`). */
  mediaHealth?: MediaHealthReport;
}

/**
 * - `missing`: the server confirmed the resource does not exist (HTTP 404 or 410).
 * - `inaccessible`: the server answered but refused or failed (403, 401, 429, 5xx...), or the
 *   destination is blocked by the SSRF policy. The file may still exist.
 * - `unreachable`: no HTTP answer (DNS failure, connection refused/reset, redirect failure).
 * - `unexpected-content`: a successful response that is not an image (e.g. an HTML page).
 * - `uninspectable`: an image that exceeds the inspection size limit.
 */
export type HealthStatus =
  | 'healthy'
  | 'missing'
  | 'inaccessible'
  | 'unreachable'
  | 'timeout'
  | 'unexpected-content'
  | 'uninspectable'
  | 'unknown';

export type HealthReason = 'http-status' | 'blocked' | 'dns' | 'connection' | 'redirect' | 'timeout' | 'content-type' | 'too-large' | 'error';

/** Result of checking (HEAD) or downloading and hashing (GET) one image URL. */
export interface ImageInspection {
  url: string;
  status: HealthStatus;
  /** Request that produced the result. HEAD falls back to a GET whose body is not read. */
  method: 'HEAD' | 'GET';
  /** Absent when healthy. */
  reason?: HealthReason;
  error?: string;
  httpStatus?: number;
  contentType?: string;
  /** Streamed size when downloaded, otherwise Content-Length when sent. */
  bytes?: number;
  /** Only when the file was downloaded (`--duplicates`). */
  sha256?: string;
}

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

/** internal: the audited site's host (or its www./bare twin); allowed: matched --allowed-domains. */
export type DomainClassification = 'internal' | 'allowed' | 'external';

export interface ImageHealth {
  url: string;
  hostname: string;
  classification: DomainClassification;
  status: HealthStatus;
  method: 'HEAD' | 'GET';
  reason?: HealthReason;
  error?: string;
  httpStatus?: number;
  contentType?: string;
  bytes?: number;
  referenceCount: number;
}

export type HealthCounts = Record<HealthStatus, number>;

/** One image host and the content that depends on it. External does not mean problematic. */
export interface DomainDependency {
  hostname: string;
  classification: DomainClassification;
  imageUrls: number;
  affectedPosts: number;
  affectedPages: number;
  health: HealthCounts;
  exampleUrls: string[];
  references: ContentReference[];
}

/** A post or page that references at least one image that is not healthy. */
export interface AffectedContent extends ContentReference {
  problems: { url: string; status: HealthStatus; httpStatus?: number }[];
}

export interface MediaHealthReport {
  /** Hosts treated as internal: the audited site's host and its www./bare variant. */
  internalHostnames: string[];
  /** Normalized --allowed-domains entries (exact hosts or `*.suffix`). */
  allowedDomains: string[];
  inspection: {
    /** `head`: HEAD with a bounded GET fallback. `download`: full GET shared with --duplicates. */
    mode: 'head' | 'download';
    attempted: number;
    getFallbacks: number;
  };
  summary: {
    imageUrls: number;
    healthy: number;
    notHealthy: number;
    byStatus: HealthCounts;
    affectedPosts: number;
    affectedPages: number;
    internalUrls: number;
    allowedExternalUrls: number;
    externalDependencyUrls: number;
    externalDependencyDomains: number;
  };
  images: ImageHealth[];
  affectedContent: AffectedContent[];
  domains: DomainDependency[];
}
