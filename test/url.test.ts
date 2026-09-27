import { describe, expect, it } from 'vitest';
import { filenameFromUrl, hostnameFromUrl, InvalidSiteUrlError, normalizeImageUrl, parseSiteUrl } from '../src/core/url.js';

describe('parseSiteUrl', () => {
  it('canonicalizes the site URL', () => {
    expect(parseSiteUrl('https://Example.com/blog/?x=1#top').href).toBe('https://example.com/blog');
  });
  it.each(['example.com', 'ftp://example.com', 'https://user:pass@example.com', ''])('rejects %s', (input) => {
    expect(() => parseSiteUrl(input)).toThrow(InvalidSiteUrlError);
  });
  it('does not echo credentials in the error', () => {
    expect(() => parseSiteUrl('https://user:secret@example.com')).toThrow(/^(?!.*secret)/);
  });
});

describe('normalizeImageUrl', () => {
  const base = 'https://example.com/blog/my-post/';
  it.each([
    ['/wp-content/uploads/a.jpg', 'https://example.com/wp-content/uploads/a.jpg'],
    ['../uploads/a.jpg', 'https://example.com/blog/uploads/a.jpg'],
    ['a.jpg', 'https://example.com/blog/my-post/a.jpg'],
    ['//cdn.example.net/a.jpg', 'https://cdn.example.net/a.jpg'],
    ['HTTPS://EXAMPLE.COM:443/a.jpg#frag', 'https://example.com/a.jpg'],
    ['  https://example.com/a b.jpg ', 'https://example.com/a%20b.jpg'],
    ['https://example.com/a.jpg?resize=300,200', 'https://example.com/a.jpg?resize=300,200'],
  ])('%s -> %s', (raw, expected) => {
    expect(normalizeImageUrl(raw, base)).toBe(expected);
  });
  it.each(['data:image/png;base64,AAA', 'javascript:alert(1)', 'blob:https://x/1', '', 'http://[bad'])('ignores %s', (raw) => {
    expect(normalizeImageUrl(raw, base)).toBeNull();
  });
});

describe('filename and hostname', () => {
  it('extracts decoded filename and hostname', () => {
    const url = 'https://cdn.example.net/uploads/caf%C3%A9-300x200.jpg?v=2';
    expect(filenameFromUrl(url)).toBe('café-300x200.jpg');
    expect(hostnameFromUrl(url)).toBe('cdn.example.net');
  });
});
