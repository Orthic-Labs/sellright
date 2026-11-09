import { describe, expect, it } from 'vitest';
import { sanitizeImportedBlogHtml } from './business.js';

describe('sanitizeImportedBlogHtml', () => {
  it('strips scripts, event handlers and script URLs but keeps ordinary markup', () => {
    const out = sanitizeImportedBlogHtml('<p onclick="x()">Hello <a href="javascript:alert(1)">link</a></p><script>alert(1)</script><strong>ok</strong>')!;
    expect(out).not.toContain('<script');
    expect(out).not.toContain('onclick');
    expect(out).not.toContain('javascript:');
    expect(out).toContain('<strong>ok</strong>');
  });
  it('keeps null and non-string values as null', () => {
    expect(sanitizeImportedBlogHtml(null)).toBeNull();
    expect(sanitizeImportedBlogHtml(undefined)).toBeNull();
  });
});
