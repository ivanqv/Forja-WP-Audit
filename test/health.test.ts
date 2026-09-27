import { describe, expect, it } from 'vitest';
import { buildMediaHealth, internalHostnames, matchesAllowedDomain, parseAllowedDomain } from '../src/core/health.js';
import { buildInventory } from '../src/core/inventory.js';
import type { ContentItem, ImageInspection } from '../src/core/types.js';

describe('allowed domains', () => {
  it('normalizes entries', () => {
    expect(parseAllowedDomain(' CDN.Example.com. ')).toBe('cdn.example.com');
    expect(parseAllowedDomain('*.wp.com')).toBe('*.wp.com');
    expect(parseAllowedDomain('bücher.de')).toBe('xn--bcher-kva.de');
  });
  it.each(['', 'https://cdn.example.com', 'cdn.example.com/path', 'cdn.example.com:8080', '*example.com', 'a.*.com', '.example.com', 'user@example.com', 'a..b'])(
    'rejects %j', (entry) => expect(() => parseAllowedDomain(entry)).toThrow(/Invalid allowed domain/),
  );
  it('matches exact hosts and explicit subdomain wildcards only', () => {
    expect(matchesAllowedDomain('example.com', 'example.com')).toBe(true);
    expect(matchesAllowedDomain('malicious-example.com', 'example.com')).toBe(false);
    expect(matchesAllowedDomain('cdn.example.com', 'example.com')).toBe(false);
    expect(matchesAllowedDomain('example.com.evil.net', 'example.com')).toBe(false);
    expect(matchesAllowedDomain('i0.wp.com', '*.wp.com')).toBe(true);
    expect(matchesAllowedDomain('wp.com', '*.wp.com')).toBe(false);
    expect(matchesAllowedDomain('evilwp.com', '*.wp.com')).toBe(false);
  });
  it('treats the site host and its www twin as internal', () => {
    expect(internalHostnames('https://example.com/')).toEqual(['example.com', 'www.example.com']);
    expect(internalHostnames('https://www.example.com/blog')).toEqual(['example.com', 'www.example.com']);
    expect(internalHostnames('http://127.0.0.1:8080/')).toEqual(['127.0.0.1']);
  });
});

const items: ContentItem[] = [
  { type: 'post', id: 1, url: 'https://example.com/a/', title: 'A', featuredMediaId: null,
    html: '<img src="/u/ok.jpg"><img src="/u/gone.jpg"><img src="https://old.example.org/logo.png"><img src="https://cdn.example.net/x.jpg">' },
  { type: 'post', id: 2, url: 'https://example.com/b/', title: 'B', featuredMediaId: null,
    html: '<img src="/u/gone.jpg"><img src="https://old.example.org/logo.png"><img src="https://old.example.org/banner.png">' },
  { type: 'page', id: 3, url: 'https://example.com/c/', title: 'C', featuredMediaId: null,
    html: '<img src="https://www.example.com/u/ok.jpg"><img src="https://i0.wp.com/example.com/u/ok.jpg">' },
];
const inventory = buildInventory({ siteUrl: 'https://example.com/', auditedAt: new Date(0), items, featuredMedia: new Map() });
const h = (url: string, rest: Partial<ImageInspection> = {}): ImageInspection => ({ url, status: 'healthy', method: 'HEAD', httpStatus: 200, ...rest });
const inspections = [
  h('https://example.com/u/ok.jpg'),
  h('https://example.com/u/gone.jpg', { status: 'missing', reason: 'http-status', httpStatus: 404, error: 'HTTP 404', method: 'GET' }),
  h('https://old.example.org/logo.png', { status: 'unreachable', reason: 'dns', error: 'ENOTFOUND', httpStatus: undefined }),
  h('https://old.example.org/banner.png', { status: 'inaccessible', reason: 'http-status', httpStatus: 403, error: 'HTTP 403' }),
  h('https://cdn.example.net/x.jpg'),
  h('https://www.example.com/u/ok.jpg'),
  h('https://i0.wp.com/example.com/u/ok.jpg', { status: 'timeout', reason: 'timeout', error: 'timed out', httpStatus: undefined }),
];

describe('buildMediaHealth', () => {
  const report = buildMediaHealth(inventory, inspections, { mode: 'head', allowedDomains: ['cdn.example.net', '*.wp.com'] });

  it('classifies and groups image hosts with their affected content', () => {
    expect(report.domains.map((d) => [d.hostname, d.classification, d.imageUrls, d.affectedPosts, d.affectedPages])).toEqual([
      ['old.example.org', 'external', 2, 2, 0],
      ['cdn.example.net', 'allowed', 1, 1, 0],
      ['i0.wp.com', 'allowed', 1, 0, 1],
      ['example.com', 'internal', 2, 2, 0],
      ['www.example.com', 'internal', 1, 0, 1],
    ]);
    const old = report.domains[0]!;
    expect(old.references.map((r) => r.id)).toEqual([1, 2]);
    expect(old.health).toMatchObject({ unreachable: 1, inaccessible: 1, healthy: 0 });
    expect(old.exampleUrls).toEqual(['https://old.example.org/banner.png', 'https://old.example.org/logo.png']);
  });

  it('keeps missing, inaccessible and unreachable apart and lists affected content', () => {
    expect(report.summary).toEqual({
      imageUrls: 7, healthy: 3, notHealthy: 4,
      byStatus: { healthy: 3, missing: 1, inaccessible: 1, unreachable: 1, timeout: 1, 'unexpected-content': 0, uninspectable: 0, unknown: 0 },
      affectedPosts: 2, affectedPages: 1,
      internalUrls: 3, allowedExternalUrls: 2, externalDependencyUrls: 2, externalDependencyDomains: 1,
    });
    expect(report.affectedContent.map((c) => [c.type, c.id, c.problems.map((p) => p.status)])).toEqual([
      ['page', 3, ['timeout']],
      ['post', 1, ['missing', 'unreachable']],
      ['post', 2, ['missing', 'inaccessible', 'unreachable']],
    ]);
    const gone = report.images.find((i) => i.url.endsWith('gone.jpg'))!;
    expect(gone).toMatchObject({ classification: 'internal', status: 'missing', httpStatus: 404, referenceCount: 2, method: 'GET' });
    expect(report.inspection).toEqual({ mode: 'head', attempted: 7, getFallbacks: 1 });
    expect(report.allowedDomains).toEqual(['*.wp.com', 'cdn.example.net']);
  });

  it('treats every non-site host as an external dependency without an allowlist', () => {
    const plain = buildMediaHealth(inventory, inspections, { mode: 'download' });
    expect(plain.summary.externalDependencyDomains).toBe(3);
    expect(plain.inspection.getFallbacks).toBe(0);
  });
});
