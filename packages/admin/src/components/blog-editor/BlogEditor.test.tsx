// @vitest-environment jsdom
// Blog rich-text editor: schema parity with the API sanitiser allowlist,
// lossless open/re-save, URL validation, and toolbar wiring.
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
      '<h1>One</h1><h4>Four</h4><h5>Five</h5><h6>Six</h6>',
    ];
    for (const c of cases) {
      const out = roundTrip(c);
      const again = roundTrip(out);
      expect(again).toBe(out); // idempotent after first normalisation
      expect(out.replace(/ (target|rel)="[^"]*"/g, '')).toContain(c.replace(/ (target|rel)="[^"]*"/g, ''));
    }
  });
  it('emits empty string for an empty document', () => { expect(roundTrip('')).toBe(''); });
  it('never emits tags outside the API allowlist (no u/s)', () => {
    expect(roundTrip('<p><u>u</u> <s>s</s></p>')).toBe('<p>u s</p>');
  });
  it('normalizeUrl accepts http(s) (+mailto for links) and rejects the rest', () => {
    expect(normalizeUrl('https://a.com/x', false)).toBe('https://a.com/x');
    expect(normalizeUrl('javascript:alert(1)', true)).toBeNull();
    expect(normalizeUrl('data:image/png;base64,AAA', false)).toBeNull();
    expect(normalizeUrl('mailto:a@b.com', true)).toBe('mailto:a@b.com');
    expect(normalizeUrl('mailto:a@b.com', false)).toBeNull();
    expect(normalizeUrl('//evil.com', true)).toBeNull();
    expect(normalizeUrl('  ', true)).toBeNull();
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
    for (const l of ['Heading 2', 'Heading 3', 'Bold', 'Italic', 'Link', 'Bulleted list', 'Numbered list', 'Blockquote', 'Image by URL', 'Undo', 'Redo', 'Edit HTML source']) {
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
