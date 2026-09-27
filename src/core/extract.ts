import { parse } from 'node-html-parser';
import type { ImageSource } from './types.js';

export interface RawImageRef {
  url: string;
  source: ImageSource;
}

/**
 * Parses a srcset attribute into its candidate URLs (descriptors dropped).
 * Follows the HTML candidate grammar: URLs are whitespace-delimited, so commas
 * inside a URL are preserved while trailing commas terminate a candidate.
 */
export function parseSrcset(srcset: string): string[] {
  const urls: string[] = [];
  let i = 0;
  while (i < srcset.length) {
    while (i < srcset.length && /[\s,]/.test(srcset[i]!)) i++;
    const start = i;
    while (i < srcset.length && !/\s/.test(srcset[i]!)) i++;
    let url = srcset.slice(start, i);
    if (url.endsWith(',')) {
      url = url.replace(/,+$/, '');
    } else {
      // Skip the descriptor (e.g. "300w", "2x") up to the next comma.
      while (i < srcset.length && srcset[i] !== ',') i++;
    }
    if (url) urls.push(url);
  }
  return urls;
}

/** Extracts raw (unresolved) image references from untrusted post/page HTML. */
export function extractImageRefs(html: string): RawImageRef[] {
  const root = parse(html);
  const refs: RawImageRef[] = [];
  for (const el of root.querySelectorAll('img, picture source')) {
    const src = el.getAttribute('src');
    if (src && el.tagName === 'IMG') refs.push({ url: src, source: 'img-src' });
    const srcset = el.getAttribute('srcset');
    if (srcset) for (const url of parseSrcset(srcset)) refs.push({ url, source: 'srcset' });
  }
  return refs;
}

/** Converts rendered HTML (e.g. a post title) to plain text. */
export function htmlToText(html: string): string {
  return parse(html).textContent.trim();
}
