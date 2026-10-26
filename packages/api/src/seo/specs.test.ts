import { describe, expect, it } from 'vitest';
import { htmlToPlainText, parseSpecBlock, specsToMaterial, specsToSchemaProperties, stripTags } from './specs.js';

describe('stripTags', () => {
  it('removes nested/reconstructed tags and stray angle brackets', () => {
    expect(stripTags('<scr<b>ipt>alert(1)</scr</b>ipt>')).not.toMatch(/[<>]/);
    expect(stripTags('a < b')).toBe('a  b');
  });
});

describe('htmlToPlainText', () => {
  it('drops tags, separates blocks, decodes text entities and keeps &lt; encoded', () => {
    expect(htmlToPlainText('<p>Fits 3&quot; &amp; up</p><p>Second&nbsp;line<br>Third</p>')).toBe('Fits 3" & up Second line Third');
    expect(htmlToPlainText('<p>a &lt;b&gt; c</p>')).toBe('a &lt;b&gt; c');
  });
});

describe('SPECS block', () => {
  const html = '<p>Intro</p><p>SPECS</p><p>Blade Material: 14C28N.<br>Weight: 3oz<br>Reversible clip</p>';

  it('parses label: value rows and ignores note lines', () => {
    expect(parseSpecBlock(html)?.rows).toEqual([['Blade Material', '14C28N'], ['Weight', '3oz']]);
    expect(specsToSchemaProperties(html)).toHaveLength(2);
    expect(specsToMaterial(html)).toBe('14C28N');
  });

  it('is empty without a SPECS block or without any label: value row', () => {
    expect(parseSpecBlock('<p>No specs here</p>')).toBeNull();
    expect(parseSpecBlock('<p>SPECS</p><p>just a note</p>')).toBeNull();
    expect(parseSpecBlock(null)).toBeNull();
    expect(specsToMaterial('<p>SPECS</p><p>Weight: 3oz</p>')).toBeUndefined();
  });
});
