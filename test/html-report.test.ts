import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, type HTMLElement } from 'node-html-parser';
import { describe, expect, it } from 'vitest';
import type { ContentReference, DuplicateReport, ImageHealth, Inventory, MediaHealthReport, ObservedImage } from '../src/core/types.js';
import { esc, renderHtmlReport, safeUrl, writeHtmlReport } from '../src/report/html.js';

const up = (name: string, host = 'example.com') => `https://${host}/wp-content/uploads/${name}`;
const post: ContentReference = { type: 'post', id: 12, url: 'https://example.com/hello/', title: 'Hello world' };
const page: ContentReference = { type: 'page', id: 2, url: 'https://example.com/about/', title: 'About' };

function baseInventory(): Inventory {
  return {
    schemaVersion: 1,
    siteUrl: 'https://example.com/',
    auditedAt: '2026-01-15T10:00:00.000Z',
    stats: { postsAnalyzed: 3, pagesAnalyzed: 1, totalImageReferences: 5, uniqueImageUrls: 4 },
    images: [
      { url: up('a.jpg'), filename: 'a.jpg', hostname: 'example.com', referenceCount: 1, sources: ['img-src'], references: [post] },
      { url: up('gone.jpg'), filename: 'gone.jpg', hostname: 'example.com', referenceCount: 1, sources: ['img-src'], references: [post] },
      { url: up('locked.jpg', 'partner.example'), filename: 'locked.jpg', hostname: 'partner.example', referenceCount: 1, sources: ['img-src'], references: [page] },
      { url: up('old.jpg', 'old.example.org'), filename: 'old.jpg', hostname: 'old.example.org', referenceCount: 1, sources: ['data-src'], references: [page] },
    ],
    domains: [
      { hostname: 'example.com', uniqueImageUrls: 2, imageReferences: 2 },
      { hostname: 'partner.example', uniqueImageUrls: 1, imageReferences: 1 },
      { hostname: 'old.example.org', uniqueImageUrls: 1, imageReferences: 1 },
    ],
    warnings: [],
  };
}

const zero = { healthy: 0, missing: 0, inaccessible: 0, unreachable: 0, timeout: 0, 'unexpected-content': 0, uninspectable: 0, unknown: 0 };
const img = (url: string, hostname: string, extra: Partial<ImageHealth>): ImageHealth =>
  ({ url, hostname, classification: 'internal', status: 'healthy', method: 'HEAD', referenceCount: 1, ...extra });

function mediaHealth(): MediaHealthReport {
  return {
    internalHostnames: ['example.com', 'www.example.com'],
    allowedDomains: ['cdn.example.com'],
    inspection: { mode: 'head', attempted: 4, getFallbacks: 1 },
    summary: {
      imageUrls: 4, healthy: 1, notHealthy: 3,
      byStatus: { ...zero, healthy: 1, missing: 1, inaccessible: 1, unreachable: 1 },
      affectedPosts: 1, affectedPages: 1, internalUrls: 2, allowedExternalUrls: 0, externalDependencyUrls: 2, externalDependencyDomains: 2,
    },
    images: [
      img(up('a.jpg'), 'example.com', { httpStatus: 200 }),
      img(up('gone.jpg'), 'example.com', { status: 'missing', reason: 'http-status', error: 'HTTP 404', httpStatus: 404, method: 'GET' }),
      img(up('locked.jpg', 'partner.example'), 'partner.example', { classification: 'external', status: 'inaccessible', reason: 'http-status', error: 'HTTP 403', httpStatus: 403 }),
      img(up('old.jpg', 'old.example.org'), 'old.example.org', { classification: 'external', status: 'unreachable', reason: 'dns', error: 'getaddrinfo ENOTFOUND old.example.org' }),
    ],
    affectedContent: [
      { ...page, problems: [{ url: up('locked.jpg', 'partner.example'), status: 'inaccessible', httpStatus: 403 }, { url: up('old.jpg', 'old.example.org'), status: 'unreachable' }] },
      { ...post, problems: [{ url: up('gone.jpg'), status: 'missing', httpStatus: 404 }] },
    ],
    domains: [
      { hostname: 'partner.example', classification: 'external', imageUrls: 1, affectedPosts: 0, affectedPages: 1, health: { ...zero, inaccessible: 1 }, exampleUrls: [up('locked.jpg', 'partner.example')], references: [page] },
      { hostname: 'old.example.org', classification: 'external', imageUrls: 1, affectedPosts: 0, affectedPages: 1, health: { ...zero, unreachable: 1 }, exampleUrls: [up('old.jpg', 'old.example.org')], references: [page] },
      { hostname: 'cdn.example.com', classification: 'allowed', imageUrls: 1, affectedPosts: 1, affectedPages: 0, health: { ...zero, healthy: 1 }, exampleUrls: [up('c.jpg', 'cdn.example.com')], references: [post] },
      { hostname: 'example.com', classification: 'internal', imageUrls: 2, affectedPosts: 1, affectedPages: 0, health: { ...zero, healthy: 1, missing: 1 }, exampleUrls: [up('gone.jpg'), up('a.jpg')], references: [post] },
    ],
  };
}

const obs = (name: string, sha: string | null, host = 'example.com', bytes: number | null = 4000): ObservedImage =>
  ({ url: up(name, host), filename: name.split('/').pop()!, hostname: host, sha256: sha, bytes: sha ? bytes : null, references: [post] });
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

function duplicates(): DuplicateReport {
  return {
    inspection: { attempted: 8, inspected: 7, failed: 1, bytesDownloaded: 30000 },
    failures: [{ url: up('gone.jpg'), error: 'HTTP 404', httpStatus: 404 }],
    exactDuplicates: [
      { sha256: SHA_A, bytes: 4000, urlCount: 2, distinctPathCount: 2, kind: 'separate-files', theoreticalDuplicateBytes: 4000, files: [obs('photo.jpg', SHA_A), obs('photo-1.jpg', SHA_A)] },
      { sha256: SHA_B, bytes: 9000, urlCount: 2, distinctPathCount: 1, kind: 'same-file-aliases', theoreticalDuplicateBytes: 0, files: [obs('logo.png', SHA_B, 'example.com', 9000), obs('logo.png', SHA_B, 'cdn.example.com', 9000)] },
    ],
    filenameCandidates: [
      { hostname: 'example.com', baseName: 'team.jpg', hashEvidence: 'all-different', members: [obs('team.jpg', 'c'.repeat(64)), obs('team-final.jpg', 'd'.repeat(64))] },
    ],
    responsiveFamilies: [{
      hostname: 'example.com', directory: '/wp-content/uploads/', baseName: 'hero.jpg', evidence: 'original-referenced',
      original: obs('hero.jpg', 'e'.repeat(64)),
      variants: [
        { ...obs('hero-300x200.jpg', 'f'.repeat(64)), kind: 'size', width: 300, height: 200 },
        { ...obs('hero-scaled.jpg', '1'.repeat(64)), kind: 'scaled', width: null, height: null },
      ],
    }],
    estimate: { theoreticalDuplicateBytes: 4000, basis: 'downloaded-size-of-identical-files-at-distinct-paths', note: 'Theoretical estimate, not guaranteed recoverable disk space.' },
  };
}

const render = (inv: Inventory) => parse(renderHtmlReport(inv));
const sectionIds = (root: HTMLElement) => root.querySelectorAll('main > section').map((s) => s.id);
const navTargets = (root: HTMLElement) => root.querySelectorAll('nav.toc a').map((a) => a.getAttribute('href'));
const text = (el: HTMLElement | null) => el?.textContent.replace(/\s+/g, ' ') ?? '';

describe('esc / safeUrl', () => {
  it('escapes HTML metacharacters', () => {
    expect(esc(`<a href="x" onclick='y'>&</a>`)).toBe('&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  });

  it('accepts only absolute http(s) URLs and escapes them for attributes', () => {
    expect(safeUrl('https://example.com/a.jpg?x=1&y="2"')).toBe('https://example.com/a.jpg?x=1&amp;y=%222%22');
    expect(safeUrl("https://example.com/it's.jpg")).toBe('https://example.com/it&#39;s.jpg');
    for (const bad of ['javascript:alert(1)', ' JaVaScRiPt:alert(1)', 'data:text/html,<script>', 'vbscript:x', 'file:///etc/passwd', '/relative.jpg', '//evil.example/x', 'not a url']) {
      expect(safeUrl(bad)).toBeNull();
    }
  });
});

describe('renderHtmlReport', () => {
  it('renders an inventory-only report without health or duplicate sections', () => {
    const root = render(baseInventory());
    expect(sectionIds(root)).toEqual(['overview', 'images']);
    expect(navTargets(root)).toEqual(['#overview', '#images']);
    expect(root.querySelector('h1')!.textContent).toBe('Media audit · example.com');
    expect(root.querySelector('time')!.getAttribute('datetime')).toBe('2026-01-15T10:00:00.000Z');
    expect(text(root.querySelector('.lede'))).toMatch(/read-only/);
    const cards = root.querySelectorAll('.card').map((c) => text(c.querySelector('.card-label')));
    expect(cards).toEqual(['Posts analysed', 'Pages analysed', 'Unique image URLs', 'Image references', 'Image hosts']);
    expect(root.querySelectorAll('#image-list [data-item]')).toHaveLength(4);
    expect(root.querySelectorAll('.thumb')).toHaveLength(0);
  });

  it('renders media health and external domains when mediaHealth exists', () => {
    const root = render({ ...baseInventory(), mediaHealth: mediaHealth() });
    expect(sectionIds(root)).toEqual(['overview', 'health', 'domains', 'images']);
    expect(navTargets(root)).toEqual(['#overview', '#health', '#domains', '#images']);
    expect(root.querySelectorAll('.status-grid .status')).toHaveLength(8);
    expect(text(root.querySelector('#overview'))).toContain('Confirmed missing');
    // External domains first, then allowed, then internal, with the disclaimer.
    const domains = root.querySelector('#domains')!;
    expect(domains.querySelectorAll('h3').map((h) => text(h))).toEqual(['External (2)', 'Allowed (1)', 'Internal (1)']);
    expect(text(domains)).toContain('External dependencies are not necessarily errors.');
    expect(domains.querySelectorAll('.domain .host').map((h) => h.textContent)).toEqual(['partner.example', 'old.example.org', 'cdn.example.com', 'example.com']);
  });

  it('shows confirmed missing images apart from inaccessible and unreachable ones', () => {
    const root = render({ ...baseInventory(), mediaHealth: mediaHealth() });
    const missing = root.querySelectorAll('.problems-missing .problem');
    expect(missing.map((p) => text(p.querySelector('strong')))).toEqual(['gone.jpg']);
    expect(text(missing[0]!)).toContain('404');
    expect(text(missing[0]!.querySelector('.refs'))).toContain('Hello world');

    const other = root.querySelectorAll('#health-other-list .problem');
    expect(other.map((p) => text(p.querySelector('.badge')))).toEqual(['Inaccessible', 'Unreachable']);
    for (const p of other) expect(text(p.querySelector('.badge'))).not.toMatch(/missing/i);
    expect(text(other[1]!)).toContain('DNS lookup failed');
    expect(text(root.querySelector('#health'))).toContain('not confirmed missing');
    // Referring content is clickable.
    expect(other[0]!.querySelector('.refs a')!.getAttribute('href')).toBe('https://example.com/about/');
  });

  it('renders the duplicate sections when duplicates exist', () => {
    const root = render({ ...baseInventory(), duplicates: duplicates() });
    expect(sectionIds(root)).toEqual(['overview', 'duplicates', 'candidates', 'responsive', 'images']);
    const groups = root.querySelectorAll('#exact-list > .group');
    expect(groups).toHaveLength(2);
    expect(text(groups[0]!.querySelector('code'))).toBe(`${SHA_A.slice(0, 12)}…`);
    expect(text(groups[0]!)).toContain('Separate files');
    expect(groups[0]!.querySelectorAll('.member')).toHaveLength(2);
    expect(text(root.querySelector('#candidates'))).toContain('Possible duplicate uploads — manual review recommended');
    expect(text(root.querySelector('#candidates'))).toContain('all-different');
    expect(text(root.querySelector('#candidates'))).not.toMatch(/confirmed duplicates(?!;)/);
    const variants = root.querySelectorAll('#responsive tbody tr');
    expect(variants.map((r) => text(r.querySelectorAll('td')[2]!))).toEqual(['Size', '-scaled']);
    expect(variants.map((r) => text(r.querySelectorAll('td')[3]!))).toEqual(['300 × 200', '—']);
    expect(text(root.querySelector('#responsive'))).toContain('original-referenced');
  });

  it('labels theoretical duplicate bytes as an estimate everywhere', () => {
    const html = renderHtmlReport({ ...baseInventory(), duplicates: duplicates() });
    const root = parse(html);
    // "recoverable" only ever appears negated.
    for (const m of html.match(/.{0,40}recoverable/gi) ?? []) expect(m).toMatch(/not guaranteed recoverable/);
    expect(html).not.toMatch(/(savings|wasted|reclaim)/i);
    const card = root.querySelectorAll('.card').find((c) => text(c).includes('Theoretical duplicate bytes'))!;
    expect(text(card)).toContain('Estimate, not guaranteed recoverable space');
    expect(text(root.querySelector('#duplicates .callout'))).toContain('Theoretical duplicate bytes (estimate)');
    expect(text(root.querySelector('#duplicates .callout'))).toContain('not guaranteed recoverable disk space');
  });

  it('does not claim duplicate bytes for alias groups or responsive families', () => {
    const root = render({ ...baseInventory(), duplicates: duplicates() });
    const alias = root.querySelectorAll('#exact-list > .group')[1]!;
    expect(text(alias)).toContain('Same file, different URLs');
    expect(text(alias)).toContain('No duplicate bytes counted');
    expect(text(alias)).not.toMatch(/Theoretical duplicate bytes/);
    const responsive = root.querySelector('#responsive')!;
    expect(text(responsive)).toContain('not duplicates');
    expect(text(responsive)).not.toMatch(/Theoretical duplicate bytes|Separate files|wasted/i);
  });

  it('renders every section when both health and duplicates exist', () => {
    const root = render({ ...baseInventory(), mediaHealth: mediaHealth(), duplicates: duplicates() });
    expect(sectionIds(root)).toEqual(['overview', 'health', 'domains', 'duplicates', 'candidates', 'responsive', 'images']);
    expect(navTargets(root)).toEqual(sectionIds(root).map((id) => `#${id}`));
    expect(root.querySelectorAll('.cards')).toHaveLength(3);
    // Thumbnails only for duplicate groups and families, lazy and without referrer.
    const thumbs = root.querySelectorAll('.thumb img');
    expect(thumbs.length).toBeGreaterThan(0);
    for (const t of thumbs) {
      expect(t.getAttribute('loading')).toBe('lazy');
      expect(t.getAttribute('referrerpolicy')).toBe('no-referrer');
      expect(t.getAttribute('onerror')).toBeUndefined();
      expect(t.closest('#health, #domains, #images')).toBeNull();
    }
  });

  it('caps the number of remote thumbnails', () => {
    const d = duplicates();
    d.exactDuplicates = Array.from({ length: 50 }, (_, i) => ({ ...d.exactDuplicates[0]!, files: [obs(`p${i}.jpg`, SHA_A), obs(`p${i}-1.jpg`, SHA_A)] }));
    expect(render({ ...baseInventory(), duplicates: d }).querySelectorAll('.thumb img')).toHaveLength(60);
  });
});

describe('renderHtmlReport safety', () => {
  const hostile = '<script>alert(1)</script><img src=x onerror=alert(2)>"\'&';

  function hostileInventory(): Inventory {
    const inv = { ...baseInventory(), mediaHealth: mediaHealth(), duplicates: duplicates() };
    const evil: ContentReference = { type: 'post', id: 66, url: 'javascript:alert(document.cookie)', title: hostile };
    inv.siteUrl = 'https://example.com/';
    inv.warnings = [hostile];
    inv.images = [{ url: `https://example.com/wp-content/uploads/${encodeURIComponent('"><svg onload=alert(3)>')}.jpg`, filename: hostile, hostname: 'example.com', referenceCount: 1, sources: ['img-src'], references: [evil] },
      { url: 'javascript:alert(4)', filename: 'x.jpg', hostname: hostile, referenceCount: 1, sources: ['img-src'], references: [evil] }];
    inv.mediaHealth!.allowedDomains = [hostile];
    inv.mediaHealth!.images[2]!.error = hostile;
    inv.mediaHealth!.affectedContent[0] = { ...evil, problems: [{ url: inv.mediaHealth!.images[2]!.url, status: 'inaccessible' }] };
    inv.mediaHealth!.domains[0]!.exampleUrls = ['javascript:alert(5)', 'data:text/html,<script>alert(6)</script>'];
    inv.mediaHealth!.domains[0]!.hostname = hostile;
    inv.duplicates!.exactDuplicates[0]!.files[0] = { ...obs('a.jpg', SHA_A), url: 'javascript:alert(7)', filename: hostile, references: [evil] };
    inv.duplicates!.failures[0]!.error = hostile;
    return inv;
  }

  it('escapes untrusted values so they cannot inject markup', () => {
    const html = renderHtmlReport(hostileInventory());
    const root = parse(html);
    // Only the report's own script and no element or attribute injected from site data.
    expect(root.querySelectorAll('script')).toHaveLength(1);
    expect(root.querySelectorAll('svg')).toHaveLength(0);
    expect(root.querySelectorAll('img').every((i) => i.parentNode?.classList.contains('thumb'))).toBe(true);
    expect(root.querySelectorAll('*').some((el) => Object.keys(el.attributes).some((a) => a.startsWith('on')))).toBe(false);
    expect(html).not.toContain('<script>alert(1)');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;&lt;img src=x onerror=alert(2)&gt;&quot;&#39;&amp;');
    // The hostile title is shown as text.
    expect(root.querySelectorAll('.refs li').some((li) => li.textContent.includes('<script>alert(1)</script>'))).toBe(true);
  });

  it('never creates javascript:, data: or other non-http links or image sources', () => {
    const root = render(hostileInventory());
    const urls = [
      ...root.querySelectorAll('a[href]').map((a) => a.getAttribute('href')!),
      ...root.querySelectorAll('img').map((i) => i.getAttribute('src')!),
    ];
    expect(urls.length).toBeGreaterThan(10);
    for (const u of urls) expect(u).toMatch(/^(https?:\/\/|#)/);
    // Unsafe URLs stay visible as plain text.
    expect(root.querySelectorAll('.unsafe-url').map((s) => s.textContent)).toEqual(expect.arrayContaining(['javascript:alert(4)', 'javascript:alert(5)', 'javascript:alert(7)']));
  });

  it('adds safe attributes to every external link', () => {
    const root = render({ ...baseInventory(), mediaHealth: mediaHealth(), duplicates: duplicates() });
    const external = root.querySelectorAll('a[href^="http"]');
    expect(external.length).toBeGreaterThan(10);
    for (const a of external) {
      expect(a.getAttribute('rel')).toBe('noopener noreferrer');
      expect(a.getAttribute('target')).toBe('_blank');
    }
  });

  it('is self-contained: no external CSS/JS, no inline handlers or styles, hash-based CSP', () => {
    const html = renderHtmlReport({ ...baseInventory(), mediaHealth: mediaHealth(), duplicates: duplicates() });
    const root = parse(html);
    expect(root.querySelectorAll('link')).toHaveLength(0);
    expect(root.querySelectorAll('script[src]')).toHaveLength(0);
    expect(root.querySelectorAll('[style]')).toHaveLength(0);
    expect(html).not.toMatch(/@import|url\(/);
    const style = root.querySelector('style')!.textContent;
    const script = root.querySelector('script')!.textContent;
    const b64 = (s: string) => createHash('sha256').update(s).digest('base64');
    const csp = root.querySelector('meta[http-equiv="Content-Security-Policy"]')!.getAttribute('content')!;
    expect(csp.split('; ')).toEqual([
      "default-src 'none'",
      `style-src 'sha256-${b64(style)}'`,
      `script-src 'sha256-${b64(script)}'`,
      'img-src http: https:',
      "base-uri 'none'",
      "form-action 'none'",
    ]);
    expect(csp).not.toMatch(/unsafe/);
    expect(root.querySelector('meta[name="referrer"]')!.getAttribute('content')).toBe('no-referrer');
  });

  it('keeps filters hidden until the script enables them and has an accessible structure', () => {
    const root = render({ ...baseInventory(), mediaHealth: mediaHealth(), duplicates: duplicates() });
    const filters = root.querySelectorAll('.filter');
    expect(filters.length).toBeGreaterThan(0);
    for (const f of filters) {
      expect(f.hasAttribute('hidden')).toBe(true);
      const input = f.querySelector('input')!;
      expect(f.querySelector(`label[for="${input.id}"]`)).not.toBeNull();
      expect(root.getElementById(input.getAttribute('data-filter')!)).not.toBeNull();
    }
    expect(root.querySelector('html')!.getAttribute('lang')).toBe('en');
    expect(root.querySelector('a.skip')!.getAttribute('href')).toBe('#main');
    expect(root.querySelector('nav')!.getAttribute('aria-label')).toBe('Report sections');
  });
});

describe('writeHtmlReport', () => {
  it('writes report.html into the output directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forja-html-'));
    try {
      const file = await writeHtmlReport(baseInventory(), join(dir, 'nested'));
      expect(file).toBe(join(dir, 'nested', 'report.html'));
      expect(await readFile(file, 'utf8')).toMatch(/^<!doctype html>/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
