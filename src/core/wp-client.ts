import { htmlToText } from './extract.js';
import type { SafeFetch } from './safe-fetch.js';
import type { ContentItem, ContentType } from './types.js';

export class WordPressApiError extends Error {}

type ApiMode = 'pretty' | 'plain';

export interface WpClientOptions {
  fetch: SafeFetch;
  /** Maximum parallel requests. Default 2. */
  concurrency?: number;
  /** Items per page (WordPress caps this at 100). */
  perPage?: number;
  onPage?: (type: ContentType, page: number, totalPages: number) => void;
}

interface WpContent {
  id: number;
  link: string;
  title?: { rendered?: string };
  content?: { rendered?: string };
  featured_media?: number;
}

/** Read-only client for the public WordPress REST API (wp/v2). */
export class WpClient {
  private mode: ApiMode | null = null;
  private readonly concurrency: number;
  private readonly perPage: number;

  constructor(
    private readonly siteUrl: URL,
    private readonly options: WpClientOptions,
  ) {
    this.concurrency = options.concurrency ?? 2;
    this.perPage = options.perPage ?? 100;
  }

  /** Detects whether the API is reachable via /wp-json/ or ?rest_route= (sites without pretty permalinks). */
  async detect(): Promise<void> {
    const failures: string[] = [];
    for (const mode of ['pretty', 'plain'] as const) {
      const res = await this.options.fetch(this.buildUrl(mode, 'posts', { per_page: '1', _fields: 'id' }));
      if (res.status === 200 && Array.isArray(safeJson(res.body))) {
        this.mode = mode;
        return;
      }
      failures.push(`${mode === 'pretty' ? '/wp-json/' : '?rest_route='} → HTTP ${res.status}`);
    }
    throw new WordPressApiError(
      `The public WordPress REST API is not available at ${this.siteUrl.href} (${failures.join(', ')}). ` +
        'The site may not be WordPress, or its REST API may be disabled or restricted to logged-in users.',
    );
  }

  async fetchContent(type: ContentType): Promise<ContentItem[]> {
    const route = type === 'post' ? 'posts' : 'pages';
    const params = (page: number) => ({
      status: 'publish',
      per_page: String(this.perPage),
      page: String(page),
      _fields: 'id,link,title,content,featured_media',
    });

    const first = await this.getJson(route, params(1));
    const totalPages = Math.max(1, Number(first.headers.get('x-wp-totalpages')) || 1);
    this.options.onPage?.(type, 1, totalPages);

    const rest = await mapLimit(range(2, totalPages), this.concurrency, async (page) => {
      const res = await this.getJson(route, params(page));
      this.options.onPage?.(type, page, totalPages);
      return res.data;
    });
    return [first.data, ...rest].flatMap((batch) => asArray(batch, route).map((raw) => toContentItem(type, raw)));
  }

  /** Resolves featured media ids to their source URLs. Ids the API does not return are omitted. */
  async fetchMediaUrls(ids: number[]): Promise<Map<number, string>> {
    const unique = [...new Set(ids)].filter((id) => id > 0);
    const chunks: number[][] = [];
    for (let i = 0; i < unique.length; i += this.perPage) chunks.push(unique.slice(i, i + this.perPage));

    const batches = await mapLimit(chunks, this.concurrency, async (chunk) => {
      const res = await this.getJson('media', {
        include: chunk.join(','),
        per_page: String(this.perPage),
        _fields: 'id,source_url',
      });
      return asArray(res.data, 'media') as { id?: unknown; source_url?: unknown }[];
    });
    const map = new Map<number, string>();
    for (const m of batches.flat()) {
      if (typeof m.id === 'number' && typeof m.source_url === 'string') map.set(m.id, m.source_url);
    }
    return map;
  }

  private buildUrl(mode: ApiMode, route: string, params: Record<string, string>): string {
    const base = this.siteUrl.href.replace(/\/?$/, '/');
    const url = mode === 'pretty' ? new URL(`wp-json/wp/v2/${route}`, base) : new URL(base);
    if (mode === 'plain') url.searchParams.set('rest_route', `/wp/v2/${route}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return url.href;
  }

  private async getJson(route: string, params: Record<string, string>) {
    if (!this.mode) throw new Error('detect() must be called first');
    const res = await this.options.fetch(this.buildUrl(this.mode, route, params));
    const data = safeJson(res.body);
    if (res.status !== 200) {
      const code = isRecord(data) && typeof data.code === 'string' ? ` (${data.code})` : '';
      throw new WordPressApiError(`WordPress API request for "${route}" failed with HTTP ${res.status}${code}.`);
    }
    if (data === undefined) throw new WordPressApiError(`WordPress API returned invalid JSON for "${route}".`);
    return { data, headers: res.headers };
  }
}

function toContentItem(type: ContentType, raw: unknown): ContentItem {
  const r = raw as WpContent;
  if (!isRecord(raw) || typeof r.id !== 'number' || typeof r.link !== 'string') {
    throw new WordPressApiError(`Unexpected ${type} object in WordPress API response.`);
  }
  return {
    type,
    id: r.id,
    url: r.link,
    title: htmlToText(r.title?.rendered ?? ''),
    html: r.content?.rendered ?? '',
    featuredMediaId: typeof r.featured_media === 'number' && r.featured_media > 0 ? r.featured_media : null,
  };
}

function asArray(data: unknown, route: string): unknown[] {
  if (!Array.isArray(data)) throw new WordPressApiError(`Expected a list from WordPress API "${route}".`);
  return data;
}

function safeJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function range(from: number, to: number): number[] {
  return Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i);
}

/** Maps items with at most `limit` promises in flight, preserving order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
