import { isIP } from 'node:net';
import type {
  AffectedContent,
  ContentReference,
  DomainClassification,
  DomainDependency,
  HealthCounts,
  HealthStatus,
  ImageHealth,
  ImageInspection,
  Inventory,
  MediaHealthReport,
} from './types.js';

export class InvalidAllowedDomainError extends Error {}

const STATUSES: HealthStatus[] = ['healthy', 'missing', 'inaccessible', 'unreachable', 'timeout', 'unexpected-content', 'uninspectable', 'unknown'];
const ORDER: Record<DomainClassification, number> = { external: 0, allowed: 1, internal: 2 };
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const refKey = (r: ContentReference) => `${r.type}:${r.id}`;
const zero = (): HealthCounts => Object.fromEntries(STATUSES.map((s) => [s, 0])) as HealthCounts;

/**
 * Normalizes an --allowed-domains entry. Accepts a bare hostname (exact match only)
 * or `*.example.com` (subdomains only, not example.com itself). Schemes, paths, ports
 * and other wildcards are rejected so an entry can never match more than it says.
 */
export function parseAllowedDomain(raw: string): string {
  const entry = raw.trim().toLowerCase().replace(/\.$/, '');
  const wildcard = entry.startsWith('*.');
  const host = wildcard ? entry.slice(2) : entry;
  const invalid = () => new InvalidAllowedDomainError(
    `Invalid allowed domain "${raw}". Use a hostname such as cdn.example.com, or *.example.com for its subdomains.`,
  );
  if (!host || /[^a-z0-9.\-\u0080-￿]/.test(host) || host.startsWith('.') || host.includes('..')) throw invalid();
  let hostname: string;
  try {
    hostname = new URL(`http://${host}`).hostname; // IDN → punycode, like image hostnames
  } catch {
    throw invalid();
  }
  return wildcard ? `*.${hostname}` : hostname;
}

/** Exact match, or a strict subdomain for `*.` entries: `*.example.com` never matches `badexample.com`. */
export function matchesAllowedDomain(hostname: string, entry: string): boolean {
  return entry.startsWith('*.') ? hostname.endsWith(entry.slice(1)) : hostname === entry;
}

/** The audited host plus its www./bare twin (example.com ↔ www.example.com). */
export function internalHostnames(siteUrl: string): string[] {
  const host = new URL(siteUrl).hostname;
  if (isIP(host.replace(/^\[|\]$/g, ''))) return [host];
  return [host, host.startsWith('www.') ? host.slice(4) : `www.${host}`].sort(cmp);
}

/**
 * Combines inspection results with the inventory: per-URL health, content affected
 * by unhealthy images, and image hosts grouped as internal / allowed / external.
 * Pure and deterministic.
 */
export function buildMediaHealth(
  inventory: Inventory,
  inspections: ImageInspection[],
  options: { mode: 'head' | 'download'; allowedDomains?: string[] },
): MediaHealthReport {
  const internal = internalHostnames(inventory.siteUrl);
  const allowedDomains = [...new Set(options.allowedDomains ?? [])].sort(cmp);
  const classify = (host: string): DomainClassification =>
    internal.includes(host) ? 'internal' : allowedDomains.some((e) => matchesAllowedDomain(host, e)) ? 'allowed' : 'external';
  const byUrl = new Map(inspections.map((i) => [i.url, i]));

  const images: ImageHealth[] = [];
  const affected = new Map<string, AffectedContent>();
  const domains = new Map<string, DomainDependency & { refs: Map<string, ContentReference>; urls: ImageHealth[] }>();
  for (const img of inventory.images) {
    const i: ImageInspection = byUrl.get(img.url) ?? { url: img.url, status: 'unknown', method: 'GET', reason: 'error', error: 'Not inspected' };
    const h: ImageHealth = {
      url: img.url,
      hostname: img.hostname,
      classification: classify(img.hostname),
      status: i.status,
      method: i.method,
      reason: i.reason,
      error: i.error,
      httpStatus: i.httpStatus,
      contentType: i.contentType,
      bytes: i.bytes,
      referenceCount: img.referenceCount,
    };
    images.push(h);

    if (h.status !== 'healthy') {
      for (const ref of img.references) {
        const entry = affected.get(refKey(ref)) ?? { ...ref, problems: [] };
        entry.problems.push({ url: h.url, status: h.status, httpStatus: h.httpStatus });
        affected.set(refKey(ref), entry);
      }
    }

    const d: DomainDependency & { refs: Map<string, ContentReference>; urls: ImageHealth[] } = domains.get(h.hostname) ?? {
      hostname: h.hostname, classification: h.classification, imageUrls: 0, affectedPosts: 0, affectedPages: 0,
      health: zero(), exampleUrls: [], references: [], refs: new Map(), urls: [],
    };
    d.imageUrls++;
    d.health[h.status]++;
    d.urls.push(h);
    for (const ref of img.references) d.refs.set(refKey(ref), ref);
    domains.set(h.hostname, d);
  }

  const byRef = (a: ContentReference, b: ContentReference) => cmp(a.type, b.type) || a.id - b.id;
  const domainList: DomainDependency[] = [...domains.values()]
    .map(({ refs, urls, ...d }) => {
      const references = [...refs.values()].sort(byRef);
      // Problems first: they are the most useful examples.
      const exampleUrls = urls
        .sort((a, b) => Number(a.status === 'healthy') - Number(b.status === 'healthy') || cmp(a.url, b.url))
        .slice(0, 3)
        .map((u) => u.url);
      return {
        ...d,
        affectedPosts: references.filter((r) => r.type === 'post').length,
        affectedPages: references.filter((r) => r.type === 'page').length,
        exampleUrls,
        references,
      };
    })
    .sort((a, b) => ORDER[a.classification] - ORDER[b.classification] || b.imageUrls - a.imageUrls || cmp(a.hostname, b.hostname));

  const affectedContent = [...affected.values()].sort(byRef);
  const byStatus = zero();
  for (const h of images) byStatus[h.status]++;
  const count = (c: DomainClassification) => images.filter((h) => h.classification === c).length;
  return {
    internalHostnames: internal,
    allowedDomains,
    inspection: {
      mode: options.mode,
      attempted: inspections.length,
      getFallbacks: options.mode === 'head' ? inspections.filter((i) => i.method === 'GET').length : 0,
    },
    summary: {
      imageUrls: images.length,
      healthy: byStatus.healthy,
      notHealthy: images.length - byStatus.healthy,
      byStatus,
      affectedPosts: affectedContent.filter((c) => c.type === 'post').length,
      affectedPages: affectedContent.filter((c) => c.type === 'page').length,
      internalUrls: count('internal'),
      allowedExternalUrls: count('allowed'),
      externalDependencyUrls: count('external'),
      externalDependencyDomains: domainList.filter((d) => d.classification === 'external').length,
    },
    images,
    affectedContent,
    domains: domainList,
  };
}
