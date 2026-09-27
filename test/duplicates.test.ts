import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { detectDuplicates } from '../src/core/duplicates.js';
import { buildInventory } from '../src/core/inventory.js';
import type { ContentItem, ImageInspection } from '../src/core/types.js';

const up = 'https://example.com/wp-content/uploads/2025/03/';
const sha = (seed: string) => createHash('sha256').update(seed).digest('hex');
const ok = (url: string, seed: string, bytes = 1000): ImageInspection => ({ url, status: 'healthy', method: 'GET', sha256: sha(seed), bytes, contentType: 'image/jpeg' });

function detect(items: { id: number; html: string }[], inspections: ImageInspection[]) {
  const content: ContentItem[] = items.map(({ id, html }) => ({ type: 'post', id, url: `https://example.com/p${id}/`, title: `P${id}`, html, featuredMediaId: null }));
  const inventory = buildInventory({ siteUrl: 'https://example.com/', auditedAt: new Date(0), items: content, featuredMedia: new Map() });
  return { inventory, report: detectDuplicates(inventory, inspections) };
}

describe('exact duplicates', () => {
  it('groups identical content with different filenames and computes theoretical bytes', () => {
    const { report } = detect(
      [{ id: 1, html: `<img src="${up}beach.jpg">` }, { id: 2, html: `<img src="${up}IMG_0042.jpg"><img src="${up}other.jpg">` }],
      [ok(`${up}beach.jpg`, 'same', 5000), ok(`${up}IMG_0042.jpg`, 'same', 5000), ok(`${up}other.jpg`, 'different')],
    );
    expect(report.exactDuplicates).toHaveLength(1);
    const g = report.exactDuplicates[0]!;
    expect(g).toMatchObject({ sha256: sha('same'), bytes: 5000, urlCount: 2, distinctPathCount: 2, kind: 'separate-files', theoreticalDuplicateBytes: 5000 });
    expect(g.files.map((f) => [f.filename, f.references.map((r) => r.id)])).toEqual([['IMG_0042.jpg', [2]], ['beach.jpg', [1]]]);
    expect(report.estimate.theoreticalDuplicateBytes).toBe(5000);
    expect(report.estimate.note).toMatch(/not guaranteed recoverable/);
  });

  it('treats CDN aliases and query variants of one path as one stored file', () => {
    const urls = [`${up}logo.png`, `https://cdn.example.net/wp-content/uploads/2025/03/logo.png`, `${up}logo.png?ver=2`, `https://i0.wp.com/example.com/wp-content/uploads/2025/03/logo.png`];
    const { report } = detect([{ id: 1, html: urls.map((u) => `<img src="${u}">`).join('') }], urls.map((u) => ok(u, 'logo', 800)));
    expect(report.exactDuplicates[0]).toMatchObject({ urlCount: 4, distinctPathCount: 1, kind: 'same-file-aliases', theoreticalDuplicateBytes: 0 });
    expect(report.estimate.theoreticalDuplicateBytes).toBe(0);
  });

  it('counts bytes once per extra distinct path, including external domains', () => {
    const urls = [`${up}a.jpg`, `${up}b.jpg`, 'https://old.example.org/uploads/c.jpg'];
    const { report } = detect([{ id: 1, html: urls.map((u) => `<img src="${u}">`).join('') }], urls.map((u) => ok(u, 'x', 300)));
    expect(report.exactDuplicates[0]).toMatchObject({ distinctPathCount: 3, theoreticalDuplicateBytes: 600 });
    expect(report.exactDuplicates[0]!.files.map((f) => f.hostname)).toContain('old.example.org');
  });
});

describe('filename candidates', () => {
  it('groups repeated uploads but never confirms them without matching hashes', () => {
    const names = ['photo.jpg', 'photo-1.jpg', 'photo-2.jpg', 'photo-final.jpg'];
    const { report } = detect([{ id: 1, html: names.map((n) => `<img src="${up}${n}">`).join('') }], names.map((n) => ok(`${up}${n}`, n)));
    expect(report.filenameCandidates).toHaveLength(1);
    expect(report.filenameCandidates[0]).toMatchObject({ baseName: 'photo.jpg', hashEvidence: 'all-different' });
    expect(report.filenameCandidates[0]!.members.map((m) => m.filename)).toEqual(['photo-1.jpg', 'photo-2.jpg', 'photo-final.jpg', 'photo.jpg']);
    expect(report.exactDuplicates).toEqual([]);
  });

  it('reports hash evidence when some candidates are identical', () => {
    const { report } = detect(
      [{ id: 1, html: `<img src="${up}team.jpg"><img src="${up}team-1.jpg"><img src="${up}team-copy.jpg">` }],
      [ok(`${up}team.jpg`, 'same'), ok(`${up}team-1.jpg`, 'same'), ok(`${up}team-copy.jpg`, 'other')],
    );
    expect(report.filenameCandidates[0]!.hashEvidence).toBe('partially-identical');
  });

  it('does not group unrelated or numbered-only names', () => {
    const names = ['gallery-1.jpg', 'gallery-2.jpg', 'report.jpg', 'report-2024.jpg', 'photo.jpg', 'photograph.jpg', 'photo.png'];
    const { report } = detect([{ id: 1, html: names.map((n) => `<img src="${up}${n}">`).join('') }], []);
    expect(report.filenameCandidates).toEqual([]);
  });
});

describe('responsive families', () => {
  it('links WordPress sizes to a referenced original and keeps them out of duplicate candidates', () => {
    const html = `<img src="${up}photo.jpg" srcset="${up}photo-300x200.jpg 300w, ${up}photo-1024x683.jpg 1024w, ${up}photo-150x150.jpg 150w">`;
    const { report } = detect([{ id: 1, html }], []);
    expect(report.responsiveFamilies).toHaveLength(1);
    const f = report.responsiveFamilies[0]!;
    expect(f).toMatchObject({ baseName: 'photo.jpg', evidence: 'original-referenced', directory: '/wp-content/uploads/2025/03/' });
    expect(f.original!.url).toBe(`${up}photo.jpg`);
    expect(f.variants.map((v) => [v.width, v.height])).toEqual([[150, 150], [300, 200], [1024, 683]]);
    expect(report.filenameCandidates).toEqual([]);
    expect(report.exactDuplicates).toEqual([]);
  });

  it('accepts srcset siblings and -scaled, but not a lone dimension-suffixed file', () => {
    const html = `<img src="${up}hero-1920x1080.jpg"><img srcset="${up}cover-300x200.jpg 300w, ${up}cover-768x512.jpg 768w"><img src="${up}big.jpg"><img src="${up}big-scaled.jpg">`;
    const { report } = detect([{ id: 1, html }], []);
    expect(report.responsiveFamilies.map((f) => [f.baseName, f.evidence, f.variants.map((v) => v.kind)])).toEqual([
      ['big.jpg', 'original-referenced', ['scaled']],
      ['cover.jpg', 'srcset-siblings', ['size', 'size']],
    ]);
  });
});

describe('determinism and inspection stats', () => {
  it('produces identical output regardless of input order', () => {
    const names = ['b.jpg', 'a.jpg', 'photo.jpg', 'photo-1.jpg', 'x-300x200.jpg', 'x.jpg'];
    const insp = names.map((n) => ok(`${up}${n}`, n.startsWith('photo') || n === 'a.jpg' || n === 'b.jpg' ? 'dup' : n));
    const one = detect([{ id: 1, html: names.map((n) => `<img src="${up}${n}">`).join('') }], insp).report;
    const two = detect([{ id: 1, html: [...names].reverse().map((n) => `<img src="${up}${n}">`).join('') }], [...insp].reverse()).report;
    expect(JSON.stringify(two)).toBe(JSON.stringify(one));
    expect(one.exactDuplicates[0]!.files.map((f) => f.filename)).toEqual(['a.jpg', 'b.jpg', 'photo-1.jpg', 'photo.jpg']);
  });

  it('summarizes inspections and lists failures', () => {
    const { report } = detect(
      [{ id: 1, html: `<img src="${up}a.jpg"><img src="${up}a-1.jpg">` }],
      [ok(`${up}a.jpg`, 'a', 120), { url: `${up}a-1.jpg`, status: 'missing', method: 'GET', reason: 'http-status', error: 'HTTP 404', httpStatus: 404 }],
    );
    expect(report.inspection).toEqual({ attempted: 2, inspected: 1, failed: 1, bytesDownloaded: 120 });
    expect(report.failures).toEqual([{ url: `${up}a-1.jpg`, error: 'HTTP 404', httpStatus: 404 }]);
    expect(report.filenameCandidates[0]!.hashEvidence).toBe('incomplete');
  });
});
