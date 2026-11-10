// @vitest-environment node
// #446: backorder copy and the fail-closed readers. Absent fields mean "not backorder".
import { describe, expect, it } from 'vitest';
import {
	BACKORDER_FALLBACK_LABEL, BACKORDER_ORDER_NOTE, hasBackorderLine, lineBackorderNotice, orderHasBackorder, pdpBackorderNotice, shipTogetherNote, variantBackorder,
} from './backorder';

describe('lines and orders', () => {
	it('a line is a backorder line only on an explicit true; the label is the API\'s, else "Ships later"', () => {
		expect(lineBackorderNotice({ backorder: true, shipLabel: ' Ships in 3 weeks ' })).toBe('Ships in 3 weeks');
		expect(lineBackorderNotice({ backorder: true, shipLabel: null })).toBe(BACKORDER_FALLBACK_LABEL);
		expect(lineBackorderNotice({ backorder: true, shipLabel: '  ' })).toBe('Ships later');
		expect(lineBackorderNotice({ backorder: false, shipLabel: 'Ships in 3 weeks' })).toBeNull();
		expect(lineBackorderNotice({})).toBeNull();
		expect(lineBackorderNotice(undefined)).toBeNull();
		expect(lineBackorderNotice({ backorder: 'yes' as never })).toBeNull();
	});
	it('an order has a backorder when its flag or any line says so', () => {
		expect(orderHasBackorder({ hasBackorder: true, lines: [] })).toBe(true);
		expect(orderHasBackorder({ lines: [{ backorder: false }, { backorder: true }] })).toBe(true);
		expect(orderHasBackorder({ lines: [{}] })).toBe(false);
		expect(orderHasBackorder({})).toBe(false);
		expect(orderHasBackorder(null)).toBe(false);
		expect(hasBackorderLine(undefined)).toBe(false);
	});
	it('copy: plain, no exclamation marks', () => {
		expect(BACKORDER_ORDER_NOTE).toBe('Your whole order ships together when these items arrive.');
		for (const t of [BACKORDER_ORDER_NOTE, BACKORDER_FALLBACK_LABEL]) expect(t).not.toContain('!');
	});
});

describe('product page notice (live fields only)', () => {
	const live = { inStock: true, backorder: true, shipsNowQuantity: 0, backorderLabel: 'Ships in 3 weeks' };
	it('backorder: shows the label; no label falls back; not in stock, disabled or unchecked shows nothing', () => {
		expect(variantBackorder(live)).toEqual({ backorder: true, label: 'Ships in 3 weeks' });
		expect(pdpBackorderNotice({ ...live, backorderLabel: null })).toBe('Ships later');
		expect(pdpBackorderNotice({ ...live, backorderLabel: undefined })).toBe('Ships later');
		expect(pdpBackorderNotice({ ...live, inStock: false })).toBeNull();
		expect(pdpBackorderNotice({ ...live, enabled: false })).toBeNull();
		expect(pdpBackorderNotice({ inStock: false, backorder: false, backorderLabel: 'Ships in 3 weeks' })).toBeNull(); // the shell: label alone says nothing
		expect(pdpBackorderNotice({ inStock: true, backorderLabel: 'Ships in 3 weeks' })).toBeNull(); // older API: no backorder field
		expect(pdpBackorderNotice(undefined)).toBeNull();
	});
	it('while something ships now nothing changes; a chosen quantity above it says all ship together', () => {
		const some = { inStock: true, backorder: false, shipsNowQuantity: 2, backorderLabel: 'Ships in 3 weeks' };
		expect(pdpBackorderNotice(some, 1)).toBeNull();
		expect(pdpBackorderNotice(some, 2)).toBeNull();
		expect(pdpBackorderNotice(some, 3)).toBe('All 3 ship together. Ships in 3 weeks');
		expect(shipTogetherNote({ ...some, backorderLabel: null }, 3)).toBe('All 3 ship together when the rest arrives.');
		expect(shipTogetherNote({ ...some, shipsNowQuantity: null }, 3)).toBeNull();
		expect(shipTogetherNote({ ...some, shipsNowQuantity: 0 }, 3)).toBeNull();
		expect(shipTogetherNote({ ...some, inStock: false }, 3)).toBeNull();
	});
});

describe('trustStripFor', () => {
  const strip = ['Free Shipping $100+', 'Ships in 1-2 business days', 'Secure Checkout'];
  it('keeps every item when no line ships later', async () => {
    const { trustStripFor } = await import('./backorder');
    expect(trustStripFor(strip, [{ backorder: false }])).toEqual(strip);
    expect(trustStripFor(strip, [])).toEqual(strip);
  });
  it('drops the shipping-speed promise when a line ships later, and nothing else', async () => {
    const { trustStripFor } = await import('./backorder');
    expect(trustStripFor(strip, [{ backorder: false }, { backorder: true, shipLabel: 'Ships in 3 weeks' }])).toEqual(['Free Shipping $100+', 'Secure Checkout']);
  });
});

