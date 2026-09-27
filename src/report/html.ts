import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type {
  ContentReference,
  DomainClassification,
  DomainDependency,
  DuplicateReport,
  ExactDuplicateGroup,
  FilenameCandidateGroup,
  HealthReason,
  HealthStatus,
  ImageHealth,
  Inventory,
  MediaHealthReport,
  ObservedImage,
  ResponsiveFamily,
} from '../core/types.js';

/**
 * Standalone HTML report rendered from an Inventory. Presentation only: no network
 * requests, no audit logic. Every value from the audited site is untrusted and goes
 * through esc() (text) or safeUrl() (href/src). No site HTML is ever inserted.
 */

/** Remote thumbnails are optional previews; cap them so large reports stay light. */
const MAX_THUMBNAILS = 60;

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escapes a value for HTML text and quoted attribute contexts. */
export function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

/** Returns the URL escaped for an attribute when it is absolute http(s), otherwise null. */
export function safeUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  return url.protocol === 'http:' || url.protocol === 'https:' ? esc(url.href) : null;
}

const nf = new Intl.NumberFormat('en-US');
const num = (n: number) => nf.format(n);
const plural = (n: number, word: string) => `${num(n)} ${word}${n === 1 ? '' : 's'}`;

function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return '—';
  if (bytes < 1024) return `${num(bytes)} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${units[i]}`;
}

/** External link, or plain text when the URL is not http(s). */
function link(url: string, text: string = url): string {
  const href = safeUrl(url);
  return href
    ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${esc(text)}</a>`
    : `<span class="unsafe-url" title="Not an http(s) URL; link disabled">${esc(text)}</span>`;
}

function refList(refs: ContentReference[]): string {
  if (refs.length === 0) return '<span class="muted">No references</span>';
  const items = refs.map((r) => `<li><span class="tag">${r.type === 'post' ? 'Post' : 'Page'} #${esc(r.id)}</span> ${link(r.url, r.title || '(untitled)')}</li>`).join('');
  const list = `<ul class="refs">${items}</ul>`;
  return refs.length <= 3 ? list : `<details><summary>${num(refs.length)} referring posts/pages</summary>${list}</details>`;
}

const STATUS_INFO: Record<HealthStatus, { label: string; tone: 'ok' | 'bad' | 'warn' | 'info'; text: string }> = {
  healthy: { label: 'Healthy', tone: 'ok', text: 'Answered with an image within the inspection limits.' },
  missing: { label: 'Missing', tone: 'bad', text: 'Confirmed missing: the server answered 404 Not Found or 410 Gone.' },
  inaccessible: { label: 'Inaccessible', tone: 'warn', text: 'The server answered but refused or failed (403, 5xx…), or the destination was blocked by the network safety policy. The file may still exist.' },
  unreachable: { label: 'Unreachable', tone: 'warn', text: 'No HTTP answer: DNS failure, connection error or redirect failure. Not confirmed missing.' },
  timeout: { label: 'Timeout', tone: 'warn', text: 'No complete answer in time. Possibly transient; not confirmed missing.' },
  'unexpected-content': { label: 'Unexpected content', tone: 'warn', text: 'A successful response that is not an image, e.g. an HTML page.' },
  uninspectable: { label: 'Uninspectable', tone: 'info', text: 'Larger than the inspection size limit, so it was not checked further.' },
  unknown: { label: 'Unknown', tone: 'info', text: 'The result could not be classified. See the error detail.' },
};

const REASON_LABEL: Record<HealthReason, string> = {
  'http-status': 'HTTP status',
  blocked: 'Blocked by network safety policy',
  dns: 'DNS lookup failed',
  connection: 'Connection failed',
  redirect: 'Redirect failed',
  timeout: 'Timed out',
  'content-type': 'Not an image content type',
  'too-large': 'Over the size limit',
  error: 'Other error',
};

const CLASS_INFO: Record<DomainClassification, { label: string; text: string }> = {
  external: { label: 'External', text: 'Hosts outside the audited site and the allowed list. Review whether the site should depend on them (old domains, staging servers, third parties).' },
  allowed: { label: 'Allowed', text: 'Hosts you declared as expected with --allowed-domains, such as a CDN.' },
  internal: { label: 'Internal', text: 'The audited site itself (including its www./bare variant).' },
};

const HASH_EVIDENCE: Record<FilenameCandidateGroup['hashEvidence'], string> = {
  'all-identical': 'All members have identical content (same SHA-256).',
  'partially-identical': 'Some members have identical content; others differ.',
  'all-different': 'Contents differ: probably different images with similar names.',
  incomplete: 'Some members could not be downloaded, so the content comparison is incomplete.',
};

const EVIDENCE: Record<ResponsiveFamily['evidence'], string> = {
  'original-referenced': 'The original file is referenced and the variants follow WordPress size naming.',
  'srcset-siblings': 'The original is not referenced; several sizes appear together in srcset attributes.',
};

const badge = (tone: string, text: string) => `<span class="badge badge-${tone}">${esc(text)}</span>`;
const statusBadge = (s: HealthStatus) => badge(STATUS_INFO[s].tone, STATUS_INFO[s].label);
const card = (value: string, label: string, note = '') =>
  `<div class="card"><div class="card-value">${value}</div><div class="card-label">${esc(label)}</div>${note ? `<div class="card-note">${note}</div>` : ''}</div>`;

function filter(id: string, target: string, label: string): string {
  // Hidden until the script runs: without JavaScript the full lists are shown.
  return `<div class="filter" hidden><label for="${id}">${esc(label)}</label><input type="search" id="${id}" data-filter="${target}" autocomplete="off" spellcheck="false"><span class="filter-status" id="${id}-status" role="status" aria-live="polite"></span></div>`;
}

const section = (id: string, title: string, body: string) =>
  `<section id="${id}" aria-labelledby="${id}-title"><h2 id="${id}-title">${esc(title)}</h2>${body}</section>`;

export function renderHtmlReport(inventory: Inventory): string {
  let thumbnails = 0;
  const thumb = (url: string) => {
    const src = safeUrl(url);
    if (!src || thumbnails >= MAX_THUMBNAILS) return '';
    thumbnails++;
    return `<span class="thumb"><img src="${src}" alt="" width="72" height="72" loading="lazy" decoding="async" referrerpolicy="no-referrer"></span>`;
  };
  const member = (m: ObservedImage, extra = '') =>
    `<li class="member">${thumb(m.url)}<div class="member-body"><div class="member-title"><strong>${esc(m.filename)}</strong> <span class="muted">${esc(m.hostname)}</span>${extra}</div><div class="url">${link(m.url)}</div><div class="meta">${formatBytes(m.bytes)}</div>${refList(m.references)}</div></li>`;

  const site = hostnameOf(inventory.siteUrl);
  const { duplicates: dup, mediaHealth: health } = inventory;
  const sections: { id: string; title: string; html: string }[] = [
    { id: 'overview', title: 'Overview', html: overview(inventory) },
  ];
  if (health) {
    sections.push({ id: 'health', title: 'Media health', html: healthSection(health) });
    sections.push({ id: 'domains', title: 'External domains', html: domainsSection(health) });
  }
  if (dup) {
    sections.push({ id: 'duplicates', title: 'Exact duplicates', html: exactSection(dup, member) });
    sections.push({ id: 'candidates', title: 'Possible duplicates', html: candidatesSection(dup, member) });
    sections.push({ id: 'responsive', title: 'Responsive families', html: responsiveSection(dup, member, thumb) });
  }
  sections.push({ id: 'images', title: 'Image inventory', html: imagesSection(inventory) });

  const nav = sections.map((s) => `<li><a href="#${s.id}">${esc(s.title)}</a></li>`).join('');
  const body = sections.map((s) => section(s.id, s.title, s.html)).join('\n');
  const csp = [
    "default-src 'none'",
    `style-src '${hash(CSS)}'`,
    `script-src '${hash(SCRIPT)}'`,
    // Optional remote thumbnails only; the layout needs no external resource.
    'img-src http: https:',
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="generator" content="Forja WP Audit">
<title>Media audit · ${esc(site)} · Forja WP Audit</title>
<style>${CSS}</style>
<script>${SCRIPT}</script>
</head>
<body>
<a class="skip" href="#main">Skip to report</a>
<header class="masthead">
<div class="wrap">
<p class="brand">Forja WP Audit</p>
<h1>Media audit · ${esc(site)}</h1>
<p class="subtitle">${link(inventory.siteUrl)} · audited <time datetime="${esc(inventory.auditedAt)}">${esc(formatDate(inventory.auditedAt))}</time></p>
<p class="lede">A read-only audit of images referenced by published posts and pages. Nothing on the website was changed or deleted; every finding is information to verify before acting.</p>
</div>
</header>
<nav class="toc" aria-label="Report sections"><div class="wrap"><ul>${nav}</ul></div></nav>
<main id="main" class="wrap">
${body}
</main>
<footer class="wrap footer">
<p>Generated by Forja WP Audit from inventory schema version ${esc(inventory.schemaVersion)}. Image previews are loaded from the audited website when this file is opened; they are optional, limited to ${MAX_THUMBNAILS}, and disappear if the site is offline or blocks them. All other content is contained in this file.</p>
</footer>
</body>
</html>
`;
}

function overview(inv: Inventory): string {
  const { stats, mediaHealth: h, duplicates: d } = inv;
  const groups = [
    `<div class="cards">${[
      card(num(stats.postsAnalyzed), 'Posts analysed'),
      card(num(stats.pagesAnalyzed), 'Pages analysed'),
      card(num(stats.uniqueImageUrls), 'Unique image URLs'),
      card(num(stats.totalImageReferences), 'Image references'),
      card(num(inv.domains.length), 'Image hosts'),
    ].join('')}</div>`,
  ];
  if (h) {
    groups.push(`<h3>Media health</h3><div class="cards">${[
      card(num(h.summary.healthy), 'Healthy images'),
      card(num(h.summary.notHealthy), 'Images needing review', 'Any status other than healthy'),
      card(num(h.summary.byStatus.missing), 'Confirmed missing', '404 / 410 only'),
      card(num(h.summary.externalDependencyDomains), 'External dependency domains', 'To review, not necessarily errors'),
    ].join('')}</div>`);
  }
  if (d) {
    groups.push(`<h3>Duplicates</h3><div class="cards">${[
      card(num(d.exactDuplicates.length), 'Exact duplicate groups'),
      card(num(d.filenameCandidates.length), 'Possible duplicate groups', 'Filename pattern, manual review'),
      card(num(d.responsiveFamilies.length), 'Responsive families', 'Not duplicates'),
      card(formatBytes(d.estimate.theoreticalDuplicateBytes), 'Theoretical duplicate bytes', 'Estimate, not guaranteed recoverable space'),
    ].join('')}</div>`);
  }
  if (inv.warnings.length) {
    groups.push(`<div class="callout callout-warn"><h3>Warnings</h3><ul>${inv.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>`);
  }
  return groups.join('');
}

function healthSection(h: MediaHealthReport): string {
  const statuses = Object.keys(STATUS_INFO) as HealthStatus[];
  const grid = `<ul class="status-grid">${statuses.map((s) =>
    `<li class="status status-${STATUS_INFO[s].tone}"><div class="status-head">${statusBadge(s)}<span class="status-count">${num(h.summary.byStatus[s])}</span></div><p>${esc(STATUS_INFO[s].text)}</p></li>`).join('')}</ul>`;
  const mode = h.inspection.mode === 'head'
    ? `Checked with HEAD requests (no image downloaded); ${plural(h.inspection.getFallbacks, 'header-only GET fallback')}.`
    : 'Checked while downloading images for duplicate detection.';
  const intro = `<p>${plural(h.summary.imageUrls, 'image URL')} checked. ${esc(mode)} ${plural(h.summary.affectedPosts, 'post')} and ${plural(h.summary.affectedPages, 'page')} reference at least one image that is not healthy.</p>`;

  const missing = h.images.filter((i) => i.status === 'missing');
  const other = h.images.filter((i) => i.status !== 'healthy' && i.status !== 'missing');
  const refsByUrl = new Map<string, ContentReference[]>();
  for (const c of h.affectedContent) for (const p of c.problems) refsByUrl.set(p.url, [...(refsByUrl.get(p.url) ?? []), c]);
  const row = (i: ImageHealth) =>
    `<li class="problem" data-item><div class="problem-head">${statusBadge(i.status)} <strong>${esc(filenameOf(i.url))}</strong> <span class="muted">${esc(i.hostname)}</span></div><div class="url">${link(i.url)}</div><dl class="facts"><div><dt>HTTP status</dt><dd>${i.httpStatus ?? '—'}</dd></div><div><dt>Reason</dt><dd>${i.reason ? esc(REASON_LABEL[i.reason]) : '—'}</dd></div>${i.error && i.error !== `HTTP ${i.httpStatus}` ? `<div class="wide"><dt>Detail</dt><dd>${esc(i.error)}</dd></div>` : ''}</dl>${refList(refsByUrl.get(i.url) ?? [])}</li>`;

  const parts = [intro, grid];
  parts.push(`<h3 id="health-missing">Confirmed missing images (404/410)</h3>`);
  parts.push(missing.length
    ? `<div class="callout callout-bad"><p>The server confirmed these files do not exist. The posts and pages listed show a broken image.</p></div><ul class="problems problems-missing">${missing.map(row).join('')}</ul>`
    : '<p class="empty">No image was confirmed missing.</p>');
  parts.push(`<h3 id="health-other">Other images needing review</h3>`);
  parts.push(other.length
    ? `<p class="muted">These could not be verified as healthy but are <strong>not confirmed missing</strong>: the cause may be access rules, network conditions or a temporary outage.</p>${filter('filter-health', 'health-other-list', 'Filter by URL, host, status or title')}<ul class="problems" id="health-other-list">${other.map(row).join('')}</ul>`
    : '<p class="empty">No other problems.</p>');
  return parts.join('');
}

function domainsSection(h: MediaHealthReport): string {
  const parts = [
    `<div class="callout"><p><strong>External dependencies are not necessarily errors.</strong> They may be legitimate CDNs or services. They are listed so you can decide whether the site should keep depending on them, for example before a migration.</p></div>`,
    `<p class="muted">Internal hosts: ${h.internalHostnames.map((d) => `<code>${esc(d)}</code>`).join(', ')}. Allowed domains: ${h.allowedDomains.length ? h.allowedDomains.map((d) => `<code>${esc(d)}</code>`).join(', ') : 'none declared'}.</p>`,
    filter('filter-domains', 'domain-list', 'Filter by host, URL or title'),
    '<div id="domain-list">',
  ];
  for (const cls of ['external', 'allowed', 'internal'] as const) {
    const list = h.domains.filter((d) => d.classification === cls);
    if (!list.length) continue;
    parts.push(`<h3>${esc(CLASS_INFO[cls].label)} <span class="muted">(${list.length})</span></h3><p class="muted">${esc(CLASS_INFO[cls].text)}</p><ul class="domains">${list.map(domainCard).join('')}</ul>`);
  }
  parts.push('</div>');
  return parts.join('');
}

function domainCard(d: DomainDependency): string {
  const health = (Object.keys(d.health) as HealthStatus[]).filter((s) => d.health[s] > 0)
    .map((s) => `${statusBadge(s)} ${num(d.health[s])}`).join(' ');
  return `<li class="domain" data-item><div class="domain-head"><strong class="host">${esc(d.hostname)}</strong> ${badge(d.classification === 'external' ? 'info' : 'neutral', CLASS_INFO[d.classification].label)}</div>
<dl class="facts"><div><dt>Image URLs</dt><dd>${num(d.imageUrls)}</dd></div><div><dt>Posts</dt><dd>${num(d.affectedPosts)}</dd></div><div><dt>Pages</dt><dd>${num(d.affectedPages)}</dd></div><div class="wide"><dt>Health</dt><dd>${health || '—'}</dd></div></dl>
<div class="examples"><span class="muted">Example URLs</span><ul>${d.exampleUrls.map((u) => `<li class="url">${link(u)}</li>`).join('')}</ul></div>${refList(d.references)}</li>`;
}

type MemberFn = (m: ObservedImage, extra?: string) => string;

function exactSection(d: DuplicateReport, member: MemberFn): string {
  const parts = [
    `<p>URLs whose downloaded content is byte-for-byte identical (same SHA-256). ${plural(d.inspection.inspected, 'image')} of ${num(d.inspection.attempted)} could be downloaded and compared.</p>`,
    `<div class="callout"><p><strong>Theoretical duplicate bytes (estimate): ${esc(formatBytes(d.estimate.theoreticalDuplicateBytes))}</strong> <span class="muted">(${num(d.estimate.theoreticalDuplicateBytes)} bytes)</span></p><p>${esc(d.estimate.note)}</p></div>`,
  ];
  if (!d.exactDuplicates.length) parts.push('<p class="empty">No exact duplicates found.</p>');
  else parts.push(`${filter('filter-exact', 'exact-list', 'Filter by filename, URL or title')}<ul class="groups" id="exact-list">${d.exactDuplicates.map((g) => exactGroup(g, member)).join('')}</ul>`);
  if (d.failures.length) {
    parts.push(`<details class="failures"><summary>${plural(d.failures.length, 'image')} could not be downloaded for comparison</summary><ul>${d.failures.map((f) =>
      `<li><span class="url">${link(f.url)}</span> <span class="muted">${esc(f.error)}</span></li>`).join('')}</ul></details>`);
  }
  return parts.join('');
}

function exactGroup(g: ExactDuplicateGroup, member: MemberFn): string {
  const aliases = g.kind === 'same-file-aliases';
  const kind = aliases
    ? `${badge('neutral', 'Same file, different URLs')} <span class="muted">Likely one stored file served under several URLs (CDN, host or query variants). No duplicate bytes counted.</span>`
    : `${badge('warn', 'Separate files')} <span class="muted">Theoretical duplicate bytes (estimate): ${esc(formatBytes(g.theoreticalDuplicateBytes))}</span>`;
  return `<li class="group" data-item><div class="group-head"><h4>SHA-256 <code title="${esc(g.sha256)}">${esc(g.sha256.slice(0, 12))}…</code></h4><div>${kind}</div>
<dl class="facts"><div><dt>URLs</dt><dd>${num(g.urlCount)}</dd></div><div><dt>Distinct file paths</dt><dd>${num(g.distinctPathCount)}</dd></div><div><dt>File size</dt><dd>${formatBytes(g.bytes)}</dd></div></dl></div>
<ul class="members">${g.files.map((m) => member(m)).join('')}</ul></li>`;
}

function candidatesSection(d: DuplicateReport, member: MemberFn): string {
  const intro = '<div class="callout callout-warn"><p><strong>Possible duplicate uploads — manual review recommended.</strong> These files are grouped by filename pattern only (photo.jpg, photo-1.jpg, photo-final.jpg). They are not confirmed duplicates; the hash evidence shows whether their contents match.</p></div>';
  if (!d.filenameCandidates.length) return `${intro}<p class="empty">No filename candidates found.</p>`;
  const groups = d.filenameCandidates.map((g) => {
    const shaCount = new Map<string, number>();
    for (const m of g.members) if (m.sha256) shaCount.set(m.sha256, (shaCount.get(m.sha256) ?? 0) + 1);
    const hashNote = (m: ObservedImage) =>
      m.sha256 === null ? ` ${badge('info', 'Not downloaded')}` : (shaCount.get(m.sha256) ?? 0) > 1 ? ` ${badge('warn', 'Identical content in group')}` : ` ${badge('neutral', 'Unique content')}`;
    return `<li class="group" data-item><div class="group-head"><h4>${esc(g.baseName)} <span class="muted">${esc(g.hostname)}</span></h4><p>Hash evidence: ${badge(g.hashEvidence === 'all-different' ? 'neutral' : g.hashEvidence === 'incomplete' ? 'info' : 'warn', g.hashEvidence)} ${esc(HASH_EVIDENCE[g.hashEvidence])}</p></div><ul class="members">${g.members.map((m) => member(m, hashNote(m))).join('')}</ul></li>`;
  }).join('');
  return `${intro}${filter('filter-candidates', 'candidate-list', 'Filter by filename, URL or title')}<ul class="groups" id="candidate-list">${groups}</ul>`;
}

function responsiveSection(d: DuplicateReport, member: MemberFn, thumb: (url: string) => string): string {
  const intro = '<p>WordPress automatically generates resized copies of each upload (for example <code>photo-300x200.jpg</code>) and a <code>-scaled</code> version of very large images. These variants are expected, are <strong>not duplicates</strong>, and are never counted in duplicate byte estimates.</p>';
  if (!d.responsiveFamilies.length) return `${intro}<p class="empty">No responsive families identified.</p>`;
  const families = d.responsiveFamilies.map((f) => {
    const variants = f.variants.map((v) =>
      `<tr><td>${thumb(v.url)}</td><td><div><strong>${esc(v.filename)}</strong></div><div class="url">${link(v.url)}</div></td><td>${v.kind === 'scaled' ? '-scaled' : 'Size'}</td><td>${v.width != null && v.height != null ? `${num(v.width)} × ${num(v.height)}` : '—'}</td><td>${formatBytes(v.bytes)}</td></tr>`).join('');
    return `<li class="group" data-item><div class="group-head"><h4>${esc(f.baseName)} <span class="muted">${esc(f.hostname)}${esc(f.directory)}</span></h4><p>Evidence: ${badge('neutral', f.evidence)} ${esc(EVIDENCE[f.evidence])}</p></div>
${f.original ? `<p class="muted">Original</p><ul class="members">${member(f.original)}</ul>` : '<p class="muted">Original not referenced in content.</p>'}
<div class="table-wrap"><table><caption>Generated variants of ${esc(f.baseName)}</caption><thead><tr><th scope="col"><span class="sr-only">Preview</span></th><th scope="col">Variant</th><th scope="col">Kind</th><th scope="col">Width × height</th><th scope="col">Size</th></tr></thead><tbody>${variants}</tbody></table></div></li>`;
  }).join('');
  return `${intro}${filter('filter-responsive', 'responsive-list', 'Filter by filename or URL')}<ul class="groups" id="responsive-list">${families}</ul>`;
}

function imagesSection(inv: Inventory): string {
  const hosts = `<div class="table-wrap"><table><caption>Image hosts</caption><thead><tr><th scope="col">Host</th><th scope="col">Unique image URLs</th><th scope="col">Image references</th></tr></thead><tbody>${inv.domains.map((d) =>
    `<tr><td class="host">${esc(d.hostname)}</td><td>${num(d.uniqueImageUrls)}</td><td>${num(d.imageReferences)}</td></tr>`).join('')}</tbody></table></div>`;
  if (!inv.images.length) return `${hosts}<p class="empty">No images were found in the analysed content.</p>`;
  const rows = inv.images.map((i) =>
    `<li class="image-row" data-item><div><strong>${esc(i.filename)}</strong> <span class="muted">${esc(i.hostname)} · ${esc(i.sources.join(', '))}</span></div><div class="url">${link(i.url)}</div>${refList(i.references)}</li>`).join('');
  return `<p>Every unique image URL found in published posts and pages, and where it is used. No previews are loaded here.</p>${hosts}${filter('filter-images', 'image-list', 'Filter by filename, URL or title')}<ul class="image-list" id="image-list">${rows}</ul>`;
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function filenameOf(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').pop() || url);
  } catch {
    return url;
  }
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

const hash = (text: string) => `sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}`;

/** Writes report.html into `outputDir` (created if missing) and returns its absolute path. */
export async function writeHtmlReport(inventory: Inventory, outputDir: string): Promise<string> {
  const dir = resolve(outputDir);
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'report.html');
  await writeFile(file, renderHtmlReport(inventory), 'utf8');
  return file;
}

// Static assets. Their SHA-256 hashes are allowed by the Content-Security-Policy; no inline
// style attributes or event handlers exist anywhere in the document.
const SCRIPT = `
// Thumbnails are optional: hide failed previews (offline, blocked, missing) without breaking layout.
// A capturing listener in <head> sees errors that happen before the body finishes parsing.
document.addEventListener('error', function (e) {
  var img = e.target;
  if (img && img.tagName === 'IMG' && img.parentNode && img.parentNode.classList) img.parentNode.classList.add('thumb-failed');
}, true);
document.addEventListener('DOMContentLoaded', function () {
  document.querySelectorAll('input[data-filter]').forEach(function (input) {
    var list = document.getElementById(input.getAttribute('data-filter'));
    if (!list) return;
    var items = list.querySelectorAll('[data-item]');
    var status = document.getElementById(input.id + '-status');
    input.addEventListener('input', function () {
      var q = input.value.trim().toLowerCase();
      var shown = 0;
      items.forEach(function (el) {
        var match = !q || el.textContent.toLowerCase().indexOf(q) !== -1;
        el.classList.toggle('filtered-out', !match);
        if (match) shown++;
      });
      status.textContent = q ? shown + ' of ' + items.length + ' shown' : '';
    });
    input.parentNode.hidden = false;
  });
});
// Print everything: expand collapsed reference lists.
window.addEventListener('beforeprint', function () {
  document.querySelectorAll('details').forEach(function (d) { d.open = true; });
});
`;

const CSS = `
:root{--bg:#f6f7f6;--surface:#fff;--text:#1a1f1c;--muted:#56605b;--border:#dce1de;--accent:#1d7248;--accent-soft:#e5f1ea;--bad:#a1262b;--bad-soft:#fbe8e9;--warn:#7a4f00;--warn-soft:#fbf1dc;--info:#304a6b;--info-soft:#e9eef5;--neutral-soft:#eceeed;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#111412;--surface:#191d1b;--text:#e5eae7;--muted:#a0aaa5;--border:#2e3632;--accent:#62c794;--accent-soft:#16301f;--bad:#f39a9e;--bad-soft:#3b1a1c;--warn:#e8bd6a;--warn-soft:#342810;--info:#a9c2e6;--info-soft:#1d2733;--neutral-soft:#262c29}}
*{box-sizing:border-box}
html{scroll-behavior:smooth;scroll-padding-top:4rem}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;-webkit-text-size-adjust:100%}
.wrap{max-width:1080px;margin:0 auto;padding:0 16px}
a{color:var(--accent);text-underline-offset:2px}
a:focus-visible,input:focus-visible,summary:focus-visible{outline:3px solid var(--accent);outline-offset:2px;border-radius:3px}
code{font:13px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--neutral-soft);padding:1px 5px;border-radius:4px;overflow-wrap:anywhere}
.skip{position:absolute;left:-999px;top:8px;background:var(--surface);padding:8px 12px;z-index:10}
.skip:focus{left:8px}
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.muted{color:var(--muted)}
.masthead{background:var(--surface);border-bottom:1px solid var(--border);padding:28px 0 20px}
.brand{margin:0 0 6px;font-size:13px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--accent)}
.brand::before{content:"";display:inline-block;width:10px;height:10px;margin-right:8px;border-radius:2px;background:var(--accent);vertical-align:0}
h1{margin:0 0 4px;font-size:clamp(22px,4vw,30px);line-height:1.2;overflow-wrap:anywhere}
.subtitle{margin:0 0 12px;color:var(--muted);overflow-wrap:anywhere}
.lede{margin:0;max-width:70ch}
.toc{position:sticky;top:0;z-index:5;background:var(--surface);border-bottom:1px solid var(--border)}
.toc ul{display:flex;gap:4px;margin:0;padding:6px 0;list-style:none;overflow-x:auto}
.toc a{display:block;padding:6px 10px;border-radius:6px;text-decoration:none;white-space:nowrap;color:var(--text)}
.toc a:hover{background:var(--accent-soft)}
section{padding:32px 0 8px;border-bottom:1px solid var(--border)}
section:last-child{border-bottom:0}
h2{margin:0 0 12px;font-size:22px}
h3{margin:24px 0 10px;font-size:17px}
h4{margin:0 0 6px;font-size:15px;overflow-wrap:anywhere}
p{max-width:80ch}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:12px;margin:12px 0}
.card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px 16px}
.card-value{font-size:26px;font-weight:650;font-variant-numeric:tabular-nums;line-height:1.2}
.card-label{font-weight:550}
.card-note{font-size:13px;color:var(--muted)}
.callout{background:var(--accent-soft);border-left:4px solid var(--accent);border-radius:6px;padding:10px 16px;margin:14px 0}
.callout p{margin:6px 0}
.callout-warn{background:var(--warn-soft);border-color:var(--warn)}
.callout-bad{background:var(--bad-soft);border-color:var(--bad)}
.badge{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;font-weight:600;line-height:1.6;white-space:nowrap;border:1px solid transparent}
.badge-ok{background:var(--accent-soft);color:var(--accent)}
.badge-bad{background:var(--bad-soft);color:var(--bad);border-color:var(--bad)}
.badge-warn{background:var(--warn-soft);color:var(--warn)}
.badge-info{background:var(--info-soft);color:var(--info)}
.badge-neutral{background:var(--neutral-soft);color:var(--text)}
.tag{font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums}
.status-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:10px;margin:12px 0;padding:0;list-style:none}
.status{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:10px 14px}
.status p{margin:6px 0 0;font-size:13px;color:var(--muted)}
.status-head{display:flex;justify-content:space-between;align-items:center}
.status-count{font-size:20px;font-weight:650;font-variant-numeric:tabular-nums}
.problems,.domains,.groups,.members,.image-list,.refs{list-style:none;margin:0;padding:0}
.problem,.domain,.group,.image-row{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px 16px;margin:10px 0}
.problems-missing .problem{border-left:4px solid var(--bad)}
.group-head{margin-bottom:8px}
.group-head p{margin:4px 0}
.member{display:flex;gap:12px;padding:10px 0;border-top:1px solid var(--border)}
.member-body{min-width:0;flex:1}
.url{font-size:13px;overflow-wrap:anywhere;word-break:break-word}
.meta{font-size:13px;color:var(--muted)}
.refs li{margin:2px 0;overflow-wrap:anywhere}
details{margin:4px 0}
summary{cursor:pointer;color:var(--accent)}
.facts{display:flex;flex-wrap:wrap;gap:4px 20px;margin:8px 0}
.facts div{min-width:0}
.facts .wide{flex-basis:100%}
.facts dt{font-size:12px;color:var(--muted)}
.facts dd{margin:0;overflow-wrap:anywhere}
.host{overflow-wrap:anywhere}
.examples ul{margin:2px 0 6px;padding-left:18px}
.thumb{flex:none;display:inline-flex;align-items:center;justify-content:center;width:72px;height:72px;border-radius:8px;overflow:hidden;background:var(--neutral-soft);border:1px solid var(--border)}
.thumb img{width:100%;height:100%;object-fit:cover}
.thumb-failed img{display:none}
.thumb-failed::after{content:"No preview";font-size:11px;color:var(--muted);text-align:center}
.table-wrap{overflow-x:auto;margin:10px 0}
table{border-collapse:collapse;width:100%;font-size:14px}
caption{text-align:left;font-weight:600;padding:4px 0}
th,td{text-align:left;padding:8px;border-bottom:1px solid var(--border);vertical-align:top}
th{font-size:12px;color:var(--muted);font-weight:600}
td .thumb{width:48px;height:48px}
.filter{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;margin:12px 0}
.filter label{font-weight:550}
.filter input{flex:1 1 220px;max-width:420px;padding:8px 10px;font:inherit;color:var(--text);background:var(--surface);border:1px solid var(--muted);border-radius:6px}
.filter-status{font-size:13px;color:var(--muted)}
.empty{color:var(--muted);font-style:italic}
.unsafe-url{overflow-wrap:anywhere}
.footer{padding:24px 16px 40px;font-size:13px;color:var(--muted)}
@media screen{.filtered-out{display:none}}
@media (max-width:560px){.member{flex-direction:column}.card-value{font-size:22px}}
@media print{:root{--bg:#fff;--surface:#fff;--text:#000;--muted:#444;--border:#bbb}
.toc,.filter,.skip,.thumb{display:none}
body{font-size:11pt}
section{break-inside:auto;padding-top:16px}
.problem,.domain,.group,.card,.status{break-inside:avoid}
a{color:inherit}}
`;
