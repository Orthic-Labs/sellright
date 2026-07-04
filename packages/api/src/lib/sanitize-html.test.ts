import { describe, expect, it } from 'vitest';
import { sanitizeBlogHtml } from './sanitize-html.js';

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
