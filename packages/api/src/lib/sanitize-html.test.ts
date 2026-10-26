import { describe, expect, it } from 'vitest';
import { autoExcerpt, computeReadingTime, sanitizeBlogHtml } from './sanitize-html.js';

// Synthetic post shaped like a real infographic article (div-wrapped comparison
// table, inline svg chart in a figure, callout section, ids/classes/data-*/style).
// Already in sanitiser-normalised form, so an edit round trip must return it unchanged.
const INFOGRAPHIC_POST = [
  '<p><em>Synthetic Example Co. - October 2026</em></p>',
  '<hr />',
  '<h2 id="what-sets-these-alloys-apart">What Sets These Alloys Apart?</h2>',
  '<p>Alloy <strong>A</strong> favours <em>wear resistance</em>; read the <a href="https://example.com/data" target="_blank" rel="noopener noreferrer">test data</a> before you buy.</p>',
  '<div class="compare" data-block="table" style="overflow-x:auto"><table class="spec"><thead><tr><th scope="col">Attribute</th><th scope="col">Alpha</th><th scope="col">Beta</th></tr></thead><tbody><tr><td>Edge retention</td><td colspan="2">Very good</td></tr><tr><td>Corrosion</td><td>Moderate</td><td>Excellent</td></tr></tbody></table></div>',
  '<figure class="chart" id="fig-edge"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 60" width="480" height="240" role="img" aria-label="Edge retention"><defs><linearGradient id="bar" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#b87333"></stop><stop offset="1" stop-color="#7a4a1f"></stop></linearGradient></defs><rect x="10" y="10" width="80" height="12" rx="2" fill="url(#bar)"></rect><rect x="10" y="30" width="55" height="12" rx="2" fill="#999"></rect><text x="10" y="8" font-size="6" text-anchor="start">Alpha vs Beta</text></svg><figcaption>Relative edge retention (synthetic).</figcaption></figure>',
  '<section class="callout"><h3>Takeaway</h3><ul><li>Pick Alpha for abrasion.</li><li>Pick Beta for rust resistance.</li></ul><blockquote><p>Maintain the edge.</p></blockquote></section>',
  '<p>Photo: <img src="https://example.com/knife.jpg" alt="Knife" width="640" loading="lazy" /></p>',
  '<p>H<sub>2</sub>O and x<sup>2</sup> with <mark>highlight</mark>, <u>underline</u> and <s>strike</s>.</p>',
].join('');

describe('sanitizeBlogHtml', () => {
  it('strips <script> tags entirely', () => {
    const out = sanitizeBlogHtml('<p>hi</p><script>alert(1)</script>');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('alert(1)');
    expect(out).toContain('<p>hi</p>');
  });

  it('strips onerror and other event handler attributes from img', () => {
    const out = sanitizeBlogHtml('<img src="x" onerror="alert(1)">');
    expect(out).not.toContain('onerror');
    expect(out).not.toContain('alert(1)');
    expect(out).toContain('<img');
    expect(out).toContain('src="x"');
  });

  it('neutralizes javascript: URLs in anchors', () => {
    const out = sanitizeBlogHtml('<a href="javascript:alert(1)">click</a>');
    expect(out).not.toContain('javascript:');
    expect(out).not.toContain('alert(1)');
  });

  it('strips <style> and <iframe> tags', () => {
    const out = sanitizeBlogHtml('<style>body{display:none}</style><iframe src="https://evil.example"></iframe>');
    expect(out).not.toContain('<style');
    expect(out).not.toContain('<iframe');
  });

  it('keeps allowed structural tags and safe link/image attributes', () => {
    const out = sanitizeBlogHtml(
      '<h2>Title</h2><p>Some <strong>bold</strong> and <em>italic</em> text.</p>' +
        '<ul><li>one</li><li>two</li></ul>' +
        '<a href="https://example.com" title="Example">link</a>' +
        '<img src="https://example.com/a.png" alt="alt text">',
    );
    expect(out).toContain('<h2>Title</h2>');
    expect(out).toContain('<strong>bold</strong>');
    expect(out).toContain('<em>italic</em>');
    expect(out).toContain('<ul>');
    expect(out).toContain('<li>one</li>');
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain('<img');
    expect(out).toContain('src="https://example.com/a.png"');
    expect(out).toContain('alt="alt text"');
  });
});

describe('sanitizeBlogHtml rich (previous-platform parity) allowlist', () => {
  it('returns an infographic post unchanged, and is idempotent', () => {
    expect(sanitizeBlogHtml(INFOGRAPHIC_POST)).toBe(INFOGRAPHIC_POST);
    const once = sanitizeBlogHtml(INFOGRAPHIC_POST + '<script>x()</script>');
    expect(sanitizeBlogHtml(once)).toBe(once);
  });

  it('keeps the camelCase svg viewBox and gradient/clipPath tags', () => {
    const out = sanitizeBlogHtml('<svg viewBox="0 0 4 4"><clipPath id="c"><rect x="0"/></clipPath><linearGradient id="g"/></svg>');
    expect(out).toContain('viewBox="0 0 4 4"');
    expect(out).toContain('<clipPath id="c">');
    expect(out).toContain('<linearGradient id="g">');
  });

  it('keeps class, style, id and data-* on layout tags', () => {
    const out = sanitizeBlogHtml('<div class="a" id="b" style="color:red" data-x-y="1">t</div>');
    expect(out).toBe('<div class="a" id="b" style="color:red" data-x-y="1">t</div>');
  });

  it('keeps u s mark b i sub sup', () => {
    const html = '<p><u>u</u><s>s</s><mark>m</mark><b>b</b><i>i</i><sub>1</sub><sup>2</sup></p>';
    expect(sanitizeBlogHtml(html)).toBe(html);
  });

  it('allows data: image URIs but not on javascript/svg-use vectors', () => {
    expect(sanitizeBlogHtml('<img src="data:image/png;base64,AAA=" alt="x">')).toContain('src="data:image/png;base64,AAA="');
    expect(sanitizeBlogHtml('<svg><use href="javascript:alert(1)"/></svg>')).not.toContain('javascript:');
  });

  it('prefixes bare-domain links with https:// and opens every link in a new tab', () => {
    const out = sanitizeBlogHtml('<a href="example.com/x">a</a><a href="/local">b</a><a href="#top">c</a><a href="mailto:a@b.co">d</a>');
    expect(out).toContain('href="https://example.com/x" target="_blank" rel="noopener noreferrer"');
    expect(out).toContain('href="/local" target="_blank"');
    expect(out).toContain('href="#top"');
    expect(out).toContain('href="mailto:a@b.co"');
  });

  it('still strips scripts, handlers, iframes and style tags from rich content', () => {
    const out = sanitizeBlogHtml('<div onclick="x()"><svg onload="x()"><script>x()</script></svg><iframe src="https://e.example"></iframe><style>*{}</style></div>');
    expect(out).not.toMatch(/onclick|onload|<script|<iframe|<style/);
  });
});

describe('blog text helpers (previous-platform parity)', () => {
  it('computes reading time at 225 wpm with a 1 minute floor', () => {
    expect(computeReadingTime('<p>short</p>')).toBe(1);
    expect(computeReadingTime('<p>' + 'w '.repeat(450) + '</p>')).toBe(2);
    expect(computeReadingTime('<p>' + 'w '.repeat(900) + '</p>')).toBe(4);
  });

  it('auto-excerpt keeps short text and cuts long text at a word boundary within 160 chars', () => {
    expect(autoExcerpt('<p>Tom &amp; <strong>Jerry</strong></p>')).toBe('Tom & Jerry');
    const out = autoExcerpt('<p>' + 'lorem '.repeat(80) + '</p>');
    expect(out.length).toBeLessThanOrEqual(160);
    expect(out.endsWith('lorem...')).toBe(true);
  });
});
