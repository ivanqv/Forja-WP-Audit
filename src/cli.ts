#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { runAudit, type AuditOptions, type AuditProgress } from './core/audit.js';
import { InvalidAllowedDomainError } from './core/health.js';
import type { Inventory } from './core/types.js';
import { InvalidSiteUrlError } from './core/url.js';
import { writeJsonReport } from './report/json.js';

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

const USAGE = `Usage: forja-wp-audit audit <site-url> [options]

Discovers images referenced by a public WordPress site's published posts and pages
and writes an inventory.json file. Read-only: no content is modified or deleted.

Options:
  -o, --output <dir>          Output directory (default: ./reports)
      --duplicates            Download and hash images to detect duplicates (slower)
      --health                Check every image URL: missing (404/410), inaccessible (403, 5xx...),
                              unreachable, timeout, unexpected content. Uses HEAD unless
                              --duplicates already downloads the files
      --allowed-domains <host>
                              Expected image host besides the site itself (repeatable).
                              Exact host, or *.example.com for its subdomains. Requires --health
      --allow-private-network Allow loopback/private/link-local targets (local testing only)
  -h, --help                  Show this help`;

export interface CliIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

const consoleIo: CliIo = { stdout: (l) => console.log(l), stderr: (l) => console.error(l) };

export async function main(argv: string[], io: CliIo = consoleIo, auditOptions: AuditOptions = {}): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        output: { type: 'string', short: 'o', default: './reports' },
        'allow-private-network': { type: 'boolean', default: false },
        duplicates: { type: 'boolean', default: false },
        health: { type: 'boolean', default: false },
        'allowed-domains': { type: 'string', multiple: true, default: [] },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (err) {
    io.stderr(`Error: ${(err as Error).message}\n\n${USAGE}`);
    return EXIT_USAGE;
  }

  const { values, positionals } = parsed;
  if (values.help) {
    io.stdout(USAGE);
    return EXIT_OK;
  }
  const [command, siteUrl, ...extra] = positionals;
  if (command !== 'audit' || !siteUrl || extra.length > 0) {
    io.stderr(`${command && command !== 'audit' ? `Error: unknown command "${command}"\n\n` : ''}${USAGE}`);
    return EXIT_USAGE;
  }
  if (values['allowed-domains'].length > 0 && !values.health) {
    io.stderr(`Error: --allowed-domains requires --health\n\n${USAGE}`);
    return EXIT_USAGE;
  }

  try {
    const inventory = await runAudit(siteUrl, {
      allowPrivateNetwork: values['allow-private-network'],
      duplicates: values.duplicates,
      health: values.health,
      allowedDomains: values['allowed-domains'],
      onProgress: (e) => {
        const line = formatProgress(e);
        if (line) io.stderr(line);
      },
      ...auditOptions,
    });
    const file = await writeJsonReport(inventory, values.output);
    const { stats } = inventory;
    io.stdout(
      [
        '',
        `Audit complete for ${inventory.siteUrl}`,
        `  Posts analyzed:    ${stats.postsAnalyzed}`,
        `  Pages analyzed:    ${stats.pagesAnalyzed}`,
        `  Image references:  ${stats.totalImageReferences}`,
        `  Unique image URLs: ${stats.uniqueImageUrls}`,
        `  Domains:           ${inventory.domains.map((d) => `${d.hostname} (${d.uniqueImageUrls})`).join(', ') || 'none'}`,
        ...formatDuplicateSummary(inventory),
        ...formatHealthSummary(inventory),
        ...inventory.warnings.map((w) => `  Warning: ${w}`),
        `Inventory written to ${file}`,
      ].join('\n'),
    );
    return EXIT_OK;
  } catch (err) {
    io.stderr(`Error: ${(err as Error).message}`);
    return err instanceof InvalidSiteUrlError || err instanceof InvalidAllowedDomainError ? EXIT_USAGE : EXIT_FAILURE;
  }
}

function formatDuplicateSummary({ duplicates: d }: Inventory): string[] {
  if (!d) return [];
  const exactFiles = d.exactDuplicates.filter((g) => g.kind === 'separate-files').length;
  return [
    `  Images inspected:  ${d.inspection.inspected}/${d.inspection.attempted} (${d.inspection.failed} failed)`,
    `  Exact duplicates:  ${d.exactDuplicates.length} group(s), ${exactFiles} with separate file paths`,
    `  Theoretical duplicate bytes: ${d.estimate.theoreticalDuplicateBytes} (estimate, not guaranteed recoverable; verify manually)`,
    `  Filename candidates: ${d.filenameCandidates.length} group(s) (for review, not confirmed)`,
    `  Responsive families: ${d.responsiveFamilies.length}`,
  ];
}

function formatHealthSummary({ mediaHealth: h }: Inventory): string[] {
  if (!h) return [];
  const problems = Object.entries(h.summary.byStatus)
    .filter(([status, n]) => status !== 'healthy' && n > 0)
    .map(([status, n]) => `${n} ${status}`);
  const external = h.domains.filter((d) => d.classification === 'external');
  return [
    `  Media health:      ${h.summary.healthy}/${h.summary.imageUrls} healthy${problems.length ? ` (${problems.join(', ')})` : ''}`,
    `  Affected content:  ${h.summary.affectedPosts} post(s), ${h.summary.affectedPages} page(s) reference images that are not healthy`,
    `  External image domains: ${external.map((d) => `${d.hostname} (${d.imageUrls})`).join(', ') || 'none'} (dependencies to review, not necessarily problems)`,
  ];
}

function formatProgress(e: AuditProgress): string | null {
  switch (e.stage) {
    case 'detect':
      return 'Checking WordPress REST API...';
    case 'content':
      return `Fetched ${e.type}s page ${e.page}/${e.totalPages}`;
    case 'media':
      return `Resolving ${e.count} featured image(s)...`;
    case 'inspect':
      if (e.done === 0) return `Inspecting ${e.total} image(s)...`;
      return e.done % 10 === 0 || e.done === e.total ? `Inspected ${e.done}/${e.total} images` : null;
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(realpathSync(invokedPath)).href) {
  process.exitCode = await main(process.argv.slice(2));
}
