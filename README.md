# Forja WP Audit

**Find duplicate images, broken media and external domain dependencies in your WordPress website.**

An open-source WordPress media auditing toolkit built with TypeScript. Analyze your media library, identify unnecessary duplicates and discover potential problems before migrating your website.

**Built for developers, agencies and WordPress migrations.**

[ForjaCMS](https://forjacms.com) · MIT License

---

## Why Forja WP Audit?

WordPress websites accumulate media over time.

The same image gets uploaded repeatedly under different filenames. Old domains remain referenced inside published content. Images disappear, leaving broken links across dozens of pages.

These problems often go unnoticed until it's time to migrate, redesign or optimize a website.

**Forja WP Audit helps you identify these issues before they become bigger problems.**

No WordPress plugin required. No database. No modifications to your website.

## Features

The following capabilities define the initial development roadmap.

### 1. Duplicate Image Detection

Find duplicate images, even when they have different filenames.

For example:

- `homepage-banner.jpg`
- `homepage-banner-1.jpg`
- `homepage-banner-2.jpg`
- `homepage-banner-final.jpg`

The toolkit will use filename analysis and SHA-256 hashing to distinguish potential duplicates from files that are exactly identical.

Results will be organized into groups with image previews, file sizes, original URLs and references to the pages where each image appears.

### 2. External Domain Detection

Discover images loaded from unexpected domains, including:

- Previous website domains.
- Development and staging environments.
- External servers and third-party websites.
- Unrecognized media hosts.

Configure your allowed domains and identify external dependencies before migrating your website.

### 3. Broken Media Detection

Identify images that are no longer accessible.

Detect HTTP errors, request failures and unexpected responses, and find the WordPress pages referencing each affected image.

### 4. Media Usage Mapping

Understand where your images are being used.

Associate discovered media with the posts and pages referencing them, making it easier to investigate duplicate files and plan a migration.

### 5. Visual HTML Reports

Generate a self-contained HTML report containing:

- Media inventory and summary statistics.
- Duplicate image groups with visual previews.
- External domain dependencies.
- Broken images.
- File sizes and estimated recoverable storage.
- References to affected pages.

Export structured JSON for additional processing or integration with other tools.

---

## Installation

**Status: early development (Sprint 01 — media discovery).** Not yet published to npm; run it from source.

Requirements: Node.js 22+ and pnpm.

```bash
git clone https://github.com/ivanqv/Forja-WP-Audit.git
cd Forja-WP-Audit
pnpm install
```

## Usage

```bash
pnpm dev audit <site-url> [--output <dir>]
```

| Option | Description |
|---|---|
| `-o, --output <dir>` | Directory for `inventory.json` (default: `./reports`). Created if missing. |
| `--allow-private-network` | Allow loopback/private/link-local targets. Only for local testing. |
| `-h, --help` | Show help. |

Example:

```bash
pnpm dev audit https://example.com --output ./reports
```

```text
Checking WordPress REST API...
Fetched posts page 1/2
Fetched posts page 2/2
Fetched pages page 1/1

Audit complete for https://example.com/
  Posts analyzed:    120
  Pages analyzed:    1
  Image references:  241
  Unique image URLs: 15
  Domains:           example.com (14), old.example.org (1)
Inventory written to /path/to/reports/inventory.json
```

Exit codes: `0` success, `1` audit failure (API unavailable, network error, blocked destination), `2` invalid arguments or URL.

Other scripts: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`.

### What it does

1. Detects the public WordPress REST API (`/wp-json/`, falling back to `?rest_route=`).
2. Fetches all published posts and pages (paginated, 100 per request, max 2 concurrent requests).
3. Extracts images from `<img src>`, `<img srcset>` and `<picture><source srcset>`, plus featured images via the media endpoint.
4. Resolves relative URLs, normalizes them and deduplicates them. Each srcset variant is kept as its own URL.
5. Writes `inventory.json`.

### Output: `inventory.json`

A full synthetic example is in [`examples/inventory.example.json`](examples/inventory.example.json). Shape:

```json
{
  "schemaVersion": 1,
  "siteUrl": "https://example.com/",
  "auditedAt": "2026-01-15T10:00:00.000Z",
  "stats": { "postsAnalyzed": 2, "pagesAnalyzed": 1, "totalImageReferences": 7, "uniqueImageUrls": 6 },
  "images": [
    {
      "url": "https://example.com/wp-content/uploads/2025/03/banner.jpg",
      "filename": "banner.jpg",
      "hostname": "example.com",
      "referenceCount": 2,
      "sources": ["img-src"],
      "references": [
        { "type": "post", "id": 12, "url": "https://example.com/hello-world/", "title": "Hello world" },
        { "type": "post", "id": 15, "url": "https://example.com/migration-notes/", "title": "Migration notes" }
      ]
    }
  ],
  "domains": [
    { "hostname": "example.com", "uniqueImageUrls": 4, "imageReferences": 5 },
    { "hostname": "staging.example.net", "uniqueImageUrls": 1, "imageReferences": 1 }
  ],
  "warnings": []
}
```

- `totalImageReferences` counts distinct (post/page, image URL) pairs. An image repeated inside one post counts once.
- `sources` records how the URL was found: `img-src`, `srcset` or `featured`.
- TypeScript types are in [`src/core/types.ts`](src/core/types.ts).

### Known limitations

- Only publicly available, published posts and pages are analyzed. Sites with the REST API disabled or restricted to logged-in users are reported as unavailable.
- Custom post types, widgets, menus, theme templates, CSS backgrounds and shortcodes that are not rendered into `content` are not scanned.
- Lazy-load attributes (`data-src`, `data-srcset`) are not read. Only standard `src`/`srcset`.
- Featured images that the public media endpoint does not return are skipped with a warning.
- No retries. Rate-limited (HTTP 429) or failing requests abort the audit.
- Private-network protection checks DNS before connecting. A DNS-rebinding race is not fully prevented.
- Images are not downloaded, hashed or checked. Duplicate and broken image detection are not implemented yet (see roadmap).

## How It Works

Forja WP Audit is designed to use the public WordPress REST API.

The auditing process consists of five steps:

1. Discover published WordPress posts and pages.
2. Extract media references and build an inventory.
3. Inspect images, detect duplicates and identify external domains.
4. Map media references to their original content.
5. Generate JSON and HTML reports.

The initial version will focus on publicly accessible content. Websites with restricted APIs or custom media implementations may require additional configuration or future integrations.

## Technology

- TypeScript
- Node.js
- WordPress REST API
- Vitest
- GitHub Actions

The project aims to maintain a small dependency footprint and a modular architecture.

Its auditing engine will be independent of the command-line interface, allowing future integrations with other applications.

## Safety First

Forja WP Audit is designed as a read-only auditing tool.

It will never automatically delete images, modify WordPress content or replace existing media references.

Duplicate detection results should always be reviewed before removing files. Different image sizes, formats and compression levels may serve legitimate purposes.

The goal is to provide actionable information, not make destructive decisions automatically.

---

## Built From Real-World Experience

Forja WP Audit was born from a real WordPress migration.

While migrating a production blog containing approximately 100 articles and their associated images, we encountered common problems: duplicated uploads, inconsistent media references and images hosted on previous domains.

These challenges inspired a reusable auditing tool that other developers could use before migrating their own websites.

The project is developed by **Iván Quintas**, a senior web developer and creator of [ForjaCMS](https://forjacms.com).

### About ForjaCMS

[ForjaCMS](https://forjacms.com) is a lightweight content management system built for modern websites, using Astro and SvelteKit.

It focuses on performance, maintainability and reducing the complexity associated with traditional plugin-heavy CMS architectures.

Forja WP Audit is an independent open-source project. You don't need ForjaCMS to use it.

Learn more:

- [ForjaCMS](https://forjacms.com)
- [Real-world migration case study](https://forjacms.com/casos-de-exito/seoginevrafodera)

---

## Roadmap

### v0.1 — Media Audit

- [x] WordPress REST API integration.
- [x] Media inventory.
- [ ] Filename-based duplicate detection.
- [ ] SHA-256 duplicate detection.
- [ ] External domain analysis.
- [ ] Broken image detection.
- [ ] HTML and JSON reports.
- [ ] Automated tests.

### Future Improvements

- [ ] Perceptual hashing for visually similar images.
- [ ] Advanced media usage analysis.
- [ ] Migration assistance for Astro.
- [ ] Integration with ForjaCMS.

The roadmap may evolve based on community feedback.

## Contributing

Contributions, bug reports and feature suggestions are welcome.

As the project evolves, contribution guidelines and development instructions will be added.

If you have encountered similar issues during WordPress migrations, feel free to open an issue and share your experience.

## License

Released under the MIT License.

See the LICENSE file for details.

---

**Built by [Iván Quintas](https://iqvmedia.com) · Creator of [ForjaCMS](https://forjacms.com)**
