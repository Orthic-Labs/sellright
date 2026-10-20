import { describe, expect, it } from 'vitest';
import { enhanceDescription } from '~/routes/products/[...slug]/product-options';
import { parseSpecBlock, renderSpecBlock } from './product-specs';

const basilisk =
  '<p>A compact fixed blade.</p><p>SPECS</p><p>Blade thickness: 4mm<br>Blade Length: 4.7"<br>Overall Length: 9.5"<br>Blade Material: 14C28N<br>Handle: G10<br>Weight: 5.1oz</p>';

describe('parseSpecBlock', () => {
  it('parses a staged block into rows, keeps intro, no notes', () => {
    const p = parseSpecBlock(basilisk)!;
    expect(p.rows).toHaveLength(6);
    expect(p.rows[0]).toEqual(['Blade thickness', '4mm']);
    expect(p.intro).toBe('<p>A compact fixed blade.</p>');
    expect(p.notes).toEqual([]);
  });
  it('returns null without a SPECS marker or rows', () => {
    expect(parseSpecBlock('<p>Plain</p>')).toBeNull();
    expect(parseSpecBlock('<p>SPECS</p><p>nothing here</p>')).toBeNull();
    expect(parseSpecBlock('')).toBeNull();
  });
  it('puts lines without a colon in notes', () => {
    const p = parseSpecBlock('<p>SPECS</p><p>Handle: G10<br>Reversible pocket clip.</p>')!;
    expect(p.notes).toEqual(['Reversible pocket clip']);
  });
});

describe('renderSpecBlock / enhanceDescription', () => {
  it('escapes HTML in labels, values and notes', () => {
    const out = renderSpecBlock({ intro: '', rows: [['<b>k</b>', '<script>x</script>']], notes: ['<i>n</i>'] });
    expect(out).not.toContain('<script>');
    expect(out).not.toContain('<b>');
    expect(out).toContain('&lt;script&gt;');
    expect(out).toContain('<span>&lt;i&gt;n&lt;/i&gt;</span>');
  });
  it('renders sr-specs markup for any product with a block', () => {
    const out = enhanceDescription('Basilisk', basilisk);
    expect(out).toContain('<dl class="sr-specs-grid">');
    expect(out).toContain('<dt>Blade Length</dt><dd>4.7&quot;</dd>'.replace('&quot;', '"'));
    expect(out.startsWith('<p>A compact fixed blade.</p>')).toBe(true);
  });
  it('leaves descriptions without SPECS unchanged', () => {
    expect(enhanceDescription('Basilisk', '<p>Hello</p>')).toBe('<p>Hello</p>');
  });
});
