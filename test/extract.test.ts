import { describe, expect, it } from 'vitest';
import { extractImageRefs, htmlToText, parseSrcset } from '../src/core/extract.js';

describe('parseSrcset', () => {
  it('parses width and density descriptors', () => {
    expect(parseSrcset('a-300.jpg 300w, a-1024.jpg 1024w,a-2x.jpg 2x')).toEqual(['a-300.jpg', 'a-1024.jpg', 'a-2x.jpg']);
  });
  it('keeps commas inside URLs and handles missing descriptors', () => {
    expect(parseSrcset('https://cdn.x/i.jpg?resize=300,200 300w, b.jpg')).toEqual(['https://cdn.x/i.jpg?resize=300,200', 'b.jpg']);
    expect(parseSrcset('a.jpg, b.jpg,')).toEqual(['a.jpg', 'b.jpg']);
    // Per the HTML spec, a comma without surrounding whitespace is part of the URL.
    expect(parseSrcset('a.jpg,b.jpg')).toEqual(['a.jpg,b.jpg']);
  });
  it('handles empty and whitespace-only input', () => {
    expect(parseSrcset('  ,  ')).toEqual([]);
  });
});

describe('extractImageRefs', () => {
  it('extracts img src, img srcset and picture source srcset', () => {
    const html = `
      <p>Text</p>
      <img src="/a.jpg" srcset="/a-300.jpg 300w, /a-600.jpg 600w" alt="">
      <picture><source srcset="/b.webp 1x"><img src="/b.jpg"></picture>
      <video><source src="/movie.mp4"></video>`;
    expect(extractImageRefs(html)).toEqual([
      { url: '/a.jpg', source: 'img-src' },
      { url: '/a-300.jpg', source: 'srcset' },
      { url: '/a-600.jpg', source: 'srcset' },
      { url: '/b.webp', source: 'srcset' },
      { url: '/b.jpg', source: 'img-src' },
    ]);
  });
  it('decodes HTML entities in attributes', () => {
    expect(extractImageRefs('<img src="/a.jpg?x=1&amp;y=2">')).toEqual([{ url: '/a.jpg?x=1&y=2', source: 'img-src' }]);
  });
  it('treats malformed and hostile HTML as data', () => {
    const html = '<img src="/ok.jpg"><script>document.write("<img src=/evil.jpg>")</script><img src=><img';
    expect(extractImageRefs(html).map((r) => r.url)).toEqual(['/ok.jpg']);
  });
});

describe('htmlToText', () => {
  it('strips tags and decodes entities', () => {
    expect(htmlToText('Caf&eacute; <em>&amp;</em> t&#8217;s')).toBe('Café & t’s');
  });
});
