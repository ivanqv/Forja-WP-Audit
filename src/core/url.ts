export class InvalidSiteUrlError extends Error {}

/**
 * Validates user input as a WordPress site URL and returns its canonical base
 * (no query, no fragment, no trailing slash).
 */
export function parseSiteUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new InvalidSiteUrlError(`"${input}" is not a valid URL. Include the scheme, e.g. https://example.com`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new InvalidSiteUrlError(`Only http and https URLs are supported (got ${url.protocol}).`);
  }
  if (url.username || url.password) {
    throw new InvalidSiteUrlError('URLs with embedded credentials are not supported.');
  }
  url.search = '';
  url.hash = '';
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url;
}

/**
 * Resolves a possibly relative image reference against the page it appears on
 * and normalizes it. Returns null for non-http(s) or unparsable references
 * (data:, blob:, javascript:, ...).
 */
export function normalizeImageUrl(raw: string, baseUrl: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed, baseUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  // WHATWG URL already lowercases the host, drops default ports and resolves dot segments.
  url.hash = '';
  url.username = '';
  url.password = '';
  return url.href;
}

export function filenameFromUrl(url: string): string {
  const last = new URL(url).pathname.split('/').pop() ?? '';
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

export function hostnameFromUrl(url: string): string {
  return new URL(url).hostname;
}
