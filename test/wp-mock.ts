import type { HttpResponse, SafeFetch } from '../src/core/safe-fetch.js';

export interface MockPost {
  id: number;
  link: string;
  title: string;
  content: string;
  featured_media?: number;
}

export interface MockSite {
  posts?: MockPost[];
  pages?: MockPost[];
  media?: { id: number; source_url: string }[];
  /** Serve only via ?rest_route= (no pretty permalinks). */
  plainOnly?: boolean;
  /** Respond with this status to every API request. */
  forceStatus?: number;
}

/** Minimal synthetic WordPress REST API: routing, pagination and `include` filtering. */
export function handleWpRequest(site: MockSite, rawUrl: string): HttpResponse {
  const url = new URL(rawUrl);
  const json = (status: number, data: unknown, headers: Record<string, string> = {}): HttpResponse => ({
    status,
    url: rawUrl,
    headers: new Headers({ 'content-type': 'application/json', ...headers }),
    body: JSON.stringify(data),
  });
  if (site.forceStatus) return json(site.forceStatus, { code: 'rest_cannot_access' });

  const pretty = url.pathname.match(/\/wp-json\/wp\/v2\/(\w+)$/)?.[1];
  const plain = url.searchParams.get('rest_route')?.match(/^\/wp\/v2\/(\w+)$/)?.[1];
  const route = site.plainOnly ? plain : (pretty ?? plain);
  if (!route) return { status: 404, url: rawUrl, headers: new Headers({ 'content-type': 'text/html' }), body: '<h1>Not found</h1>' };

  const perPage = Number(url.searchParams.get('per_page') ?? 10);
  const page = Number(url.searchParams.get('page') ?? 1);
  if (route === 'media') {
    const ids = (url.searchParams.get('include') ?? '').split(',').map(Number);
    return json(200, (site.media ?? []).filter((m) => ids.includes(m.id)));
  }
  const all = route === 'posts' ? (site.posts ?? []) : route === 'pages' ? (site.pages ?? []) : null;
  if (!all) return json(404, { code: 'rest_no_route' });
  const totalPages = Math.max(1, Math.ceil(all.length / perPage));
  if (page > totalPages) return json(400, { code: 'rest_post_invalid_page_number' });
  const slice = all.slice((page - 1) * perPage, page * perPage).map((p) => ({
    id: p.id,
    link: p.link,
    title: { rendered: p.title },
    content: { rendered: p.content },
    featured_media: p.featured_media ?? 0,
  }));
  return json(200, slice, { 'x-wp-total': String(all.length), 'x-wp-totalpages': String(totalPages) });
}

export function mockFetch(site: MockSite, log: string[] = []): SafeFetch {
  return async (url) => {
    log.push(url);
    return handleWpRequest(site, url);
  };
}
