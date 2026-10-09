import { describe, expect, it } from 'vitest';
import { renderPackingSlipHtml, type PackingSlipDoc } from './order-documents';

const doc: PackingSlipDoc = {
  type: 'packing_slip', number: 'PS-1001', date: '2026-10-09', store: { name: 'Acme <Co>', slug: 'acme' },
  shipTo: ['Ann "A" Smith', '1 Main St'], lines: [{ sku: 'TEE-M', name: 'Tee & Co', quantity: 2 }],
};

describe('renderPackingSlipHtml', () => {
  it('lists the lines and address with no prices', () => {
    const html = renderPackingSlipHtml(doc);
    expect(html).toContain('PS-1001');
    expect(html).toContain('TEE-M');
    expect(html).toContain('1 Main St');
    expect(html).not.toContain('$');
  });
  it('escapes every interpolated value', () => {
    const html = renderPackingSlipHtml(doc);
    expect(html).toContain('Acme &lt;Co&gt;');
    expect(html).toContain('Tee &amp; Co');
    expect(html).toContain('Ann &quot;A&quot; Smith');
    expect(html).not.toContain('<Co>');
  });
});
