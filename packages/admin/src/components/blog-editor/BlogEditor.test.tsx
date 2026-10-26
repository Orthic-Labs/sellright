// @vitest-environment jsdom
// Blog rich-text editor: schema parity with the API sanitiser allowlist (Vendure
// blog allowlist), lossless open/re-save incl. div/table/svg infographic blocks,
// URL validation, and toolbar wiring.
import { describe, expect, it, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { Editor } from '@tiptap/core';
import { blogExtensions, htmlOut, normalizeUrl } from './blog-editor-core.js';
import BlogEditor from './BlogEditor.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no layout; ProseMirror's scrollIntoView calls these.
const zeroRect = { x: 0, y: 0, top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, toJSON: () => ({}) } as DOMRect;
const noRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as unknown as DOMRectList;
for (const proto of [Range.prototype, Element.prototype, Text.prototype] as { getClientRects?: unknown; getBoundingClientRect?: unknown }[]) {
  proto.getClientRects ??= noRects;
  proto.getBoundingClientRect ??= () => zeroRect;
}

// Synthetic infographic post (same fixture as api/src/lib/sanitize-html.test.ts): div-wrapped
// table, inline svg chart in a figure, callout section, ids/classes/data-*/style, marks.
const INFOGRAPHIC_POST = [
  '<p><em>Synthetic Example Co. - October 2026</em></p>',
  '<hr />',
  '<h2 id="what-sets-these-alloys-apart">What Sets These Alloys Apart?</h2>',
  '<p>Alloy <strong>A</strong> favours <em>wear resistance</em>; read the <a href="https://example.com/data" target="_blank" rel="noopener noreferrer">test data</a> before you buy.</p>',
  '<div class="compare" data-block="table" style="overflow-x:auto"><table class="spec"><thead><tr><th scope="col">Attribute</th><th scope="col">Alpha</th><th scope="col">Beta</th></tr></thead><tbody><tr><td>Edge retention</td><td colspan="2">Very good</td></tr><tr><td>Corrosion</td><td>Moderate</td><td>Excellent</td></tr></tbody></table></div>',
  '<figure class="chart" id="fig-edge"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 60" width="480" height="240" role="img" aria-label="Edge retention"><defs><linearGradient id="bar" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#b87333"></stop><stop offset="1" stop-color="#7a4a1f"></stop></linearGradient></defs><rect x="10" y="10" width="80" height="12" rx="2" fill="url(#bar)"></rect><rect x="10" y="30" width="55" height="12" rx="2" fill="#999"></rect><text x="10" y="8" font-size="6" text-anchor="start">Alpha vs Beta</text></svg><figcaption>Relative edge retention (synthetic).</figcaption></figure>',
  '<section class="callout"><h3>Takeaway</h3><ul><li>Pick Alpha for abrasion.</li><li>Pick Beta for rust resistance.</li></ul><blockquote><p>Maintain the edge.</p></blockquote></section>',
  '<img src="https://example.com/knife.jpg" alt="Knife" width="640" loading="lazy" />',
  '<p>H<sub>2</sub>O and x<sup>2</sup> with <mark>highlight</mark>, <u>underline</u> and <s>strike</s>.</p>',
].join('');

/** DOM-normalised form with attributes sorted, so only real content changes show up. */
function canon(html: string): string {
  const box = document.createElement('div');
  box.innerHTML = html;
  for (const el of box.querySelectorAll('*')) {
    const attrs = [...el.attributes].map((a) => [a.name, a.value] as const).sort(([a], [b]) => a.localeCompare(b));
    for (const [n] of attrs) el.removeAttribute(n);
    for (const [n, v] of attrs) el.setAttribute(n, v);
  }
  return box.innerHTML;
}

function roundTrip(html: string): string {
  const ed = new Editor({ extensions: blogExtensions(), content: html });
  const out = htmlOut(ed);
  ed.destroy();
  return out;
}

describe('blog editor schema', () => {
  it('round-trips every allowlisted construct unchanged', () => {
    const cases = [
      '<h2>Title</h2><h3>Sub</h3><p>Hello <strong>bold</strong> and <em>italic</em></p>',
      '<ul><li><p>one</p></li><li><p>two</p></li></ul><ol><li><p>a</p></li></ol>',
      '<blockquote><p>quoted</p></blockquote><hr>',
      '<p><a target="_blank" rel="noopener noreferrer" href="https://example.com/x">link</a></p>',
      '<img src="https://example.com/a.jpg" alt="A">',
      '<pre><code>const a = 1;</code></pre><p>text with <code>code</code></p>',
      '<h2>Two</h2><h3>Three</h3><h4>Four</h4>',
    ];
    for (const c of cases) {
      const out = roundTrip(c);
      const again = roundTrip(out);
      expect(again).toBe(out); // idempotent after first normalisation
      expect(out.replace(/ (target|rel)="[^"]*"/g, '')).toContain(c.replace(/ (target|rel)="[^"]*"/g, ''));
    }
  });
  it('emits empty string for an empty document', () => { expect(roundTrip('')).toBe(''); });
  it('keeps the inline marks the allowlist permits (u s mark sub sup) and class/style spans', () => {
    const html = '<p><u>u</u> <s>s</s> <mark>m</mark> H<sub>2</sub>O x<sup>2</sup> <span class="tag" style="color: red;">badge</span></p>';
    expect(canon(roundTrip(html))).toBe(canon(html));
  });
  it('drops tags outside the allowlist and plain spans (text kept)', () => {
    expect(roundTrip('<p>a <span>plain</span> b</p>')).toBe('<p>a plain b</p>');
  });
  it('round-trips an infographic post (div/table/figure/svg/section + ids/classes/data-*/style) unchanged', () => {
    const out = roundTrip(INFOGRAPHIC_POST);
    expect(canon(out)).toBe(canon(INFOGRAPHIC_POST));
    expect(out).toContain('viewBox="0 0 120 60"');
    expect(out).toContain('<div class="compare" data-block="table" style="overflow-x:auto">');
    expect(canon(roundTrip(out))).toBe(canon(out)); // stable on a second open/save
  });
  it('keeps a Raw HTML block as one verbatim element, and emits nothing for an empty one', () => {
    const ed = new Editor({ extensions: blogExtensions(), content: '<p>before</p>' });
    ed.commands.insertContentAt(ed.state.doc.content.size, { type: 'rawHtml', attrs: { html: '<div class="x"><table><tbody><tr><td>1</td></tr></tbody></table></div>' } });
    expect(htmlOut(ed)).toBe('<p>before</p><div class="x"><table><tbody><tr><td>1</td></tr></tbody></table></div>');
    ed.commands.setContent({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }, { type: 'rawHtml', attrs: { html: '' } }] });
    expect(htmlOut(ed)).toBe('<p>a</p>');
    ed.commands.setContent({ type: 'doc', content: [{ type: 'rawHtml', attrs: { html: '<svg viewBox="0 0 1 1"></svg>' } }] });
    expect(htmlOut(ed)).toBe('<svg viewBox="0 0 1 1"></svg>');
    ed.destroy();
  });
  it('wraps multi-element raw HTML in a marker div that reopens as the same block', () => {
    const ed = new Editor({ extensions: blogExtensions(), content: '' });
    ed.commands.setContent({ type: 'doc', content: [{ type: 'rawHtml', attrs: { html: '<div>a</div><div>b</div>' } }] });
    const out = htmlOut(ed);
    expect(out).toBe('<div data-raw-html=""><div>a</div><div>b</div></div>');
    ed.commands.setContent(out);
    expect(htmlOut(ed)).toBe(out);
    ed.destroy();
  });
  it('keeps data: images and image attributes already stored in a post', () => {
    const html = '<img src="data:image/png;base64,AAA=" alt="d" width="10" height="10" loading="lazy">';
    expect(canon(roundTrip(html))).toBe(canon(html));
  });
  it('normalizeUrl accepts http(s) (+mailto for links) and rejects the rest', () => {
    expect(normalizeUrl('https://a.com/x', false)).toBe('https://a.com/x');
    expect(normalizeUrl('javascript:alert(1)', true)).toBeNull();
    expect(normalizeUrl('data:image/png;base64,AAA', false)).toBeNull();
    expect(normalizeUrl('mailto:a@b.com', true)).toBe('mailto:a@b.com');
    expect(normalizeUrl('mailto:a@b.com', false)).toBeNull();
    expect(normalizeUrl('//evil.com', true)).toBeNull();
    expect(normalizeUrl('  ', true)).toBeNull();
    // Links match Vendure's addLink: bare domains get https://, /relative and #anchor pass.
    expect(normalizeUrl('example.com/x', true)).toBe('https://example.com/x');
    expect(normalizeUrl('/local', true)).toBe('/local');
    expect(normalizeUrl('#top', true)).toBe('#top');
    expect(normalizeUrl('example.com', false)).toBeNull();
  });
});

describe('BlogEditor component', () => {
  it('does not call onChange (so stored body is untouched) until the author edits; source toggle edits raw HTML', async () => {
    const onChange = vi.fn();
    const original = '<p>legacy <span>span</span> body</p>';
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => { root.render(<BlogEditor value={original} onChange={onChange} />); });
    expect(container.querySelector('[role="toolbar"]')).not.toBeNull();
    for (const l of ['Heading 2', 'Heading 3', 'Bold', 'Italic', 'Link', 'Bulleted list', 'Numbered list', 'Blockquote', 'Image by URL', 'Insert raw HTML block', 'Undo', 'Redo', 'Edit HTML source']) {
      expect(container.querySelector(`button[aria-label="${l}"]`), l).not.toBeNull();
    }
    expect(onChange).not.toHaveBeenCalled();

    const sourceBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Edit HTML source"]')!;
    await act(async () => { sourceBtn.click(); });
    const ta = container.querySelector<HTMLTextAreaElement>('textarea')!;
    expect(ta.value).toBe(original); // raw original, not the normalised form
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => { setter.call(ta, '<p>edited</p>'); ta.dispatchEvent(new Event('input', { bubbles: true })); });
    expect(onChange).toHaveBeenLastCalledWith('<p>edited</p>');

    // Heading toggle through the toolbar changes the doc and emits HTML.
    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="Back to visual editor"]')!.click(); });
    expect(container.querySelector('.ProseMirror')!.innerHTML).toContain('edited');
    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="Heading 2"]')!.click(); });
    expect(onChange).toHaveBeenLastCalledWith('<h2>edited</h2>');

    // Image URL bar rejects unsafe URLs.
    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="Image by URL"]')!.click(); });
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Image URL"]')!;
    const inSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => { inSetter.call(input, 'javascript:alert(1)'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => { [...container.querySelectorAll('button')].find((b) => b.textContent === 'Insert')!.click(); });
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    await act(async () => { inSetter.call(input, 'https://example.com/p.png'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => { [...container.querySelectorAll('button')].find((b) => b.textContent === 'Insert')!.click(); });
    expect(onChange.mock.calls.at(-1)![0]).toContain('<img src="https://example.com/p.png">');

    await act(async () => { root.unmount(); });
    container.remove();
  });
});
