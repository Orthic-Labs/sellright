import { describe, expect, it } from 'vitest';
import { sellableRaw, sellableQuantity, shipsNowQuantity, isBackorder, lineNeedsBackorder, minIncoming, normalizeBackorderLabel } from './availability.js';
import { availabilityOf } from '../feeds/feed.js';
import { seoConfigFromStore } from '../seo/config.js';
import { productSchema } from '../seo/jsonld.js';
import { orderConfirmation, BACKORDER_ORDER_NOTICE } from '../email/templates.js';
import { backorderSnapshot, orderHasBackorder } from '../routes/order-facts.js';

describe('availability maths (#446)', () => {
  it('sellable = on_hand + incoming - allocated; shipsNow floors at 0', () => {
    expect(sellableRaw({ onHand: 2, incoming: 5, allocated: 3 })).toBe(4);
    expect(shipsNowQuantity({ onHand: 2, incoming: 5, allocated: 3 })).toBe(0);
    expect(shipsNowQuantity({ onHand: 5, incoming: 0, allocated: 2 })).toBe(3);
    expect(sellableQuantity({ onHand: 0, incoming: 0, allocated: 3 })).toBe(0);
  });
  it('missing stock row fails closed', () => {
    expect(sellableQuantity({})).toBe(0);
    expect(sellableQuantity({ onHand: null, incoming: null, allocated: null })).toBe(0);
    expect(isBackorder({})).toBe(false);
  });
  it('backorder only when nothing ships now and sellable remains', () => {
    expect(isBackorder({ onHand: 2, incoming: 5, allocated: 2 })).toBe(true);
    expect(isBackorder({ onHand: 2, incoming: 5, allocated: 1 })).toBe(false);
    expect(isBackorder({ onHand: 2, incoming: 5, allocated: 7 })).toBe(false);
  });
  it('line needs backorder when quantity exceeds shipsNow', () => {
    const q = { onHand: 2, incoming: 5, allocated: 0 };
    expect(lineNeedsBackorder(q, 2)).toBe(false);
    expect(lineNeedsBackorder(q, 3)).toBe(true);
  });
  it('minIncoming is the sold backorder quantity', () => {
    expect(minIncoming({ onHand: 2, allocated: 6 })).toBe(4);
    expect(minIncoming({ onHand: 9, allocated: 6 })).toBe(0);
  });
  it('labels are trimmed; blank is null', () => {
    expect(normalizeBackorderLabel('  Ships in 3 weeks ')).toBe('Ships in 3 weeks');
    expect(normalizeBackorderLabel('   ')).toBeNull();
    expect(normalizeBackorderLabel(undefined)).toBeNull();
  });
});

describe('feed availability', () => {
  const base = { fulfillmentType: 'physical', isPreOrder: false };
  it('in stock / backorder / out of stock', () => {
    expect(availabilityOf({ ...base, stockAvailable: 7, stockShipsNow: 2 })).toBe('in stock');
    expect(availabilityOf({ ...base, stockAvailable: 5, stockShipsNow: 0 })).toBe('backorder');
    expect(availabilityOf({ ...base, stockAvailable: 0, stockShipsNow: 0 })).toBe('out of stock');
    expect(availabilityOf({ ...base, stockAvailable: null })).toBe('out of stock');
  });
  it('callers without stockShipsNow never report backorder; pre-order and digital unchanged', () => {
    expect(availabilityOf({ ...base, stockAvailable: 3 })).toBe('in stock');
    expect(availabilityOf({ fulfillmentType: 'physical', isPreOrder: true, stockAvailable: 0 })).toBe('preorder');
    expect(availabilityOf({ fulfillmentType: 'digital_download', isPreOrder: false, stockAvailable: null })).toBe('in stock');
  });
});

describe('JSON-LD availability', () => {
  const cfg = seoConfigFromStore({ name: 'Acme', config: { seo: { siteUrl: 'https://shop.example.net' } } });
  const p = (over: Record<string, unknown>) => JSON.stringify(productSchema(cfg, { slug: 's', name: 'n', description: null, images: [], currency: 'USD', price: 1000, sku: 'S', inStock: true, preOrder: false, updatedAt: null, ...over } as never));
  it('BackOrder only when in stock with backOrder set', () => {
    expect(p({ backOrder: true })).toContain('/BackOrder');
    expect(p({ backOrder: false })).toContain('/InStock');
    expect(p({})).toContain('/InStock');
    expect(p({ inStock: false, backOrder: true })).toContain('/OutOfStock');
  });
});

describe('order line snapshot helpers', () => {
  it('reads the snapshot, never the live variant', () => {
    expect(backorderSnapshot({ backorder: true, shipLabel: 'Soon' })).toEqual({ backorder: true, shipLabel: 'Soon' });
    expect(backorderSnapshot(null)).toEqual({ backorder: false, shipLabel: null });
    expect(backorderSnapshot({ vendure: { id: 1 } })).toEqual({ backorder: false, shipLabel: null });
    expect(orderHasBackorder([{ backorder: false }, { backorder: true }])).toBe(true);
    expect(orderHasBackorder([{}])).toBe(false);
  });
});

describe('confirmation email', () => {
  const store = { name: 'S', currency: 'USD', storefrontUrl: 'https://shop.example.net', fromEmail: 'a@b.c' } as never;
  it('per-line label and one order-level sentence; unchanged without backorder lines', () => {
    const r = orderConfirmation(store, { code: 'X1', grandTotal: 4000, currency: 'USD', lines: [
      { name: 'A', quantity: 3, lineTotal: 3000, backorder: true, shipLabel: 'Ships in 3 weeks' }, { name: 'B', quantity: 1, lineTotal: 1000 }] });
    expect(r.html).toContain('Ships in 3 weeks');
    expect(r.html.split(BACKORDER_ORDER_NOTICE).length - 1).toBe(1);
    expect(r.text).toContain('Ships in 3 weeks');
    expect(BACKORDER_ORDER_NOTICE).toBe('Your whole order ships together when these items arrive.');
    for (const out of [r.html, r.text]) { expect(out).not.toMatch(/backorder/i); expect(out).toContain('Your whole order ships together when these items arrive.'); }
    const fb = orderConfirmation(store, { code: 'X3', grandTotal: 1000, currency: 'USD', lines: [{ name: 'C', quantity: 1, lineTotal: 1000, backorder: true, shipLabel: null }] });
    expect(fb.html).toContain('Ships later');
    expect(fb.html).not.toMatch(/backorder/i);
    const plain = orderConfirmation(store, { code: 'X2', grandTotal: 1000, currency: 'USD', lines: [{ name: 'B', quantity: 1, lineTotal: 1000 }] });
    expect(plain.html).not.toContain('Backorder');
    expect(plain.html).not.toContain(BACKORDER_ORDER_NOTICE);
  });
});
