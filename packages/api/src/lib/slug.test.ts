import { describe, expect, it } from 'vitest';
import { slugify } from './slug.js';

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('EDC Folder')).toBe('edc-folder');
  });
  it('strips non-alphanumerics and trims leading/trailing hyphens', () => {
    expect(slugify('  --Steel: M390!! --')).toBe('steel-m390');
  });
  it('caps length at 80 chars', () => {
    expect(slugify('a'.repeat(200)).length).toBe(80);
  });
  it('falls back to "item" for an empty/unslugable input', () => {
    expect(slugify('')).toBe('item');
    expect(slugify('★★★')).toBe('item');
  });
});
