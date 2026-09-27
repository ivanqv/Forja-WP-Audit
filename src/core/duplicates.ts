import type {
  DuplicateReport,
  ExactDuplicateGroup,
  FilenameCandidateGroup,
  ImageInspection,
  ImageRecord,
  Inventory,
  ObservedImage,
  ResponsiveFamily,
  ResponsiveVariant,
} from './types.js';

export const ESTIMATE_NOTE =
  'Theoretical estimate: downloaded (transfer) size of files with identical SHA-256 content served from distinct paths. ' +
  'It does not prove the files are stored separately and is not guaranteed recoverable disk space. ' +
  'Verify manually before removing anything; this tool never deletes files.';

// WordPress intermediate sizes: name-300x200.jpg. Big-image downscale: name-scaled.jpg.
const SIZE_SUFFIX = /^(.+)-(\d{2,5})x(\d{2,5})$/;
const SCALED_SUFFIX = /^(.+)-scaled$/;
// Upload collisions (name-1) and manual re-uploads. Kept narrow on purpose: no years, no long numbers.
const REPEAT_SUFFIX = /^(.+?)-(\d{1,2}|final|copy|copia|new|old|v\d{1,2})$/i;

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

interface Parsed {
  image: ImageRecord;
  path: string;
  directory: string;
  stem: string;
  ext: string;
}

function parse(image: ImageRecord): Parsed {
  const path = new URL(image.url).pathname;
  const directory = path.slice(0, path.lastIndexOf('/') + 1);
  const dot = image.filename.lastIndexOf('.');
  const stem = dot > 0 ? image.filename.slice(0, dot) : image.filename;
  const ext = dot > 0 ? image.filename.slice(dot).toLowerCase() : '';
  return { image, path, directory, stem, ext };
}

/**
 * Classifies inspected inventory images into exact duplicates (hash evidence),
 * filename-based candidates (review only) and WordPress responsive families.
 * Pure and deterministic: same inputs, same output order.
 */
export function detectDuplicates(inventory: Inventory, inspections: ImageInspection[]): DuplicateReport {
  const byUrl = new Map(inspections.map((i) => [i.url, i]));
  const observe = (image: ImageRecord): ObservedImage => {
    const i = byUrl.get(image.url);
    return {
      url: image.url,
      filename: image.filename,
      hostname: image.hostname,
      sha256: i?.ok ? i.sha256 : null,
      bytes: i?.ok ? i.bytes : null,
      references: image.references,
    };
  };

  const parsed = inventory.images.map(parse);
  const { families, variantUrls } = findResponsiveFamilies(parsed, observe);
  const exactDuplicates = findExactDuplicates(inventory.images, observe);
  const filenameCandidates = findFilenameCandidates(parsed.filter((p) => !variantUrls.has(p.image.url)), observe);

  const ok = inspections.filter((i) => i.ok);
  const failed = inspections.filter((i) => !i.ok);
  return {
    inspection: {
      attempted: inspections.length,
      inspected: ok.length,
      failed: failed.length,
      bytesDownloaded: ok.reduce((n, i) => n + i.bytes, 0),
    },
    failures: failed
      .map((f) => ({ url: f.url, error: f.error, ...(f.httpStatus ? { httpStatus: f.httpStatus } : {}) }))
      .sort((a, b) => cmp(a.url, b.url)),
    exactDuplicates,
    filenameCandidates,
    responsiveFamilies: families,
    estimate: {
      theoreticalDuplicateBytes: exactDuplicates.reduce((n, g) => n + g.theoreticalDuplicateBytes, 0),
      basis: 'downloaded-size-of-identical-files-at-distinct-paths',
      note: ESTIMATE_NOTE,
    },
  };
}

function findExactDuplicates(images: ImageRecord[], observe: (i: ImageRecord) => ObservedImage): ExactDuplicateGroup[] {
  const byHash = new Map<string, ObservedImage[]>();
  for (const image of images) {
    const o = observe(image);
    if (o.sha256) byHash.set(o.sha256, [...(byHash.get(o.sha256) ?? []), o]);
  }
  return [...byHash.entries()]
    .filter(([, files]) => files.length > 1)
    .map(([sha256, files]) => {
      const bytes = files[0]!.bytes!;
      const distinctPathCount = countDistinctPaths(files);
      return {
        sha256,
        bytes,
        urlCount: files.length,
        distinctPathCount,
        kind: distinctPathCount > 1 ? ('separate-files' as const) : ('same-file-aliases' as const),
        theoreticalDuplicateBytes: bytes * (distinctPathCount - 1),
        files: files.sort((a, b) => cmp(a.url, b.url)),
      };
    })
    .sort((a, b) => b.theoreticalDuplicateBytes - a.theoreticalDuplicateBytes || cmp(a.sha256, b.sha256));
}

/**
 * Collapses URLs that most likely point at one stored file: same path with a different
 * host or query string (CDN / cookieless domains), or a proxy that embeds the origin
 * host in its path (e.g. i0.wp.com/example.com/wp-content/...).
 */
function countDistinctPaths(files: ObservedImage[]): number {
  const keys = new Set<string>();
  const hosts = new Set(files.map((f) => f.hostname));
  for (const f of files) {
    let path = new URL(f.url).pathname;
    for (const host of hosts) {
      if (path.startsWith(`/${host}/`)) path = path.slice(host.length + 1);
    }
    keys.add(path);
  }
  return keys.size;
}

function findResponsiveFamilies(parsed: Parsed[], observe: (i: ImageRecord) => ObservedImage) {
  const byPath = new Map(parsed.map((p) => [`${p.image.hostname}${p.directory}${p.stem}${p.ext}`, p]));
  const candidates = new Map<string, { p: Parsed; base: string; variant: Omit<ResponsiveVariant, keyof ObservedImage> }[]>();
  for (const p of parsed) {
    const size = SIZE_SUFFIX.exec(p.stem);
    const scaled = size ? null : SCALED_SUFFIX.exec(p.stem);
    const base = size?.[1] ?? scaled?.[1];
    if (!base) continue;
    const variant = size
      ? { kind: 'size' as const, width: Number(size[2]), height: Number(size[3]) }
      : { kind: 'scaled' as const, width: null, height: null };
    const key = `${p.image.hostname}${p.directory}${base}${p.ext}`;
    candidates.set(key, [...(candidates.get(key) ?? []), { p, base, variant }]);
  }

  const families: ResponsiveFamily[] = [];
  const variantUrls = new Set<string>();
  for (const [key, members] of candidates) {
    const original = byPath.get(key) ?? null;
    const viaSrcset = members.length > 1 && members.some((m) => m.p.image.sources.includes('srcset'));
    // Dimensions in a filename alone are not evidence: require the original or srcset siblings.
    if (!original && !viaSrcset) continue;
    const first = members[0]!.p;
    families.push({
      hostname: first.image.hostname,
      directory: first.directory,
      baseName: `${members[0]!.base}${first.ext}`,
      evidence: original ? 'original-referenced' : 'srcset-siblings',
      original: original ? observe(original.image) : null,
      variants: members
        .map((m) => ({ ...observe(m.p.image), ...m.variant }))
        .sort((a, b) => (a.width ?? Infinity) - (b.width ?? Infinity) || cmp(a.url, b.url)),
    });
    for (const m of members) variantUrls.add(m.p.image.url);
  }
  families.sort((a, b) => cmp(`${a.hostname}${a.directory}${a.baseName}`, `${b.hostname}${b.directory}${b.baseName}`));
  return { families, variantUrls };
}

function findFilenameCandidates(parsed: Parsed[], observe: (i: ImageRecord) => ObservedImage): FilenameCandidateGroup[] {
  const groups = new Map<string, { base: string; ext: string; hostname: string; members: Map<string, Parsed> }>();
  for (const p of parsed) {
    let base = p.stem;
    for (let n = 0, m; n < 2 && (m = REPEAT_SUFFIX.exec(base)); n++) base = m[1]!;
    const key = `${p.image.hostname}|${base.toLowerCase()}${p.ext}`;
    const group = groups.get(key) ?? { base, ext: p.ext, hostname: p.image.hostname, members: new Map() };
    if (!group.members.has(p.path)) group.members.set(p.path, p); // same path, other query → one file
    groups.set(key, group);
  }

  return [...groups.values()]
    // Needs 2+ files and the unsuffixed original: gallery-1.jpg + gallery-2.jpg alone are not suspicious.
    .filter((g) => g.members.size > 1 && [...g.members.values()].some((p) => p.stem.toLowerCase() === g.base.toLowerCase()))
    .map((g) => {
      const members = [...g.members.values()].map((p) => observe(p.image)).sort((a, b) => cmp(a.url, b.url));
      return { hostname: g.hostname, baseName: `${g.base}${g.ext}`, hashEvidence: hashEvidence(members), members };
    })
    .sort((a, b) => cmp(`${a.hostname}/${a.baseName}`, `${b.hostname}/${b.baseName}`));
}

function hashEvidence(members: ObservedImage[]): FilenameCandidateGroup['hashEvidence'] {
  if (members.some((m) => !m.sha256)) return 'incomplete';
  const unique = new Set(members.map((m) => m.sha256)).size;
  if (unique === 1) return 'all-identical';
  return unique === members.length ? 'all-different' : 'partially-identical';
}
