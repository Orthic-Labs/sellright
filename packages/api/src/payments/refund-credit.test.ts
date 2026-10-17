import { describe, expect, it } from 'vitest';
import { refundLineCashAmount, refundUnitBases, proveCreditMerchandiseReturn, refundCreditProjection } from './refund-credit.js';
import { buildOrderPricingSnapshot } from '../money/pricing-snapshot.js';
import { calculatePromotionStack, type StackInput } from '../money/promotion-stack.js';

const id = '11111111-1111-4111-8111-111111111111';
const secondId = '22222222-2222-4222-8222-222222222222';
const imported = (overrides: Record<string, unknown> = {}) => ({ id, quantity: 3, unitPrice: 100, lineTotal: 299,
  metadata: { vendure: { quantity: 3, placedQuantity: 3, listPrice: 100, listPriceIncludesTax: true,
    adjustments: [{ amount: -1, type: 'PROMOTION' }], taxLines: [], ...overrides } } });
const redeem = { id: 'redeem', accountCreditId: 'credit', amount: 101, delta: -101, operationalAllocation: { [id]: [0, 50, 51] } };
const selection = (quantity = 1) => [{ orderLineId: id, quantity }];
const currentSnapshot = (lines: Array<{ id: string; unitListPrice: number; quantity: number }>) => {
  const input: StackInput = { currency: 'USD', pricesIncludeTax: true, couponCodes: [], phase: 'PaymentSettled',
    lines: lines.map(line => ({ key: line.id, quantity: line.quantity, placedQuantity: line.quantity, unitListPrice: line.unitListPrice,
      priceIncludesTax: true, taxRateBps: 0 })), promotions: [], shipping: 0, shippingTaxRateBps: 0,
    shippingIncludesTax: true, couponContext: { activeVerifications: [] } };
  return buildOrderPricingSnapshot(input, calculatePromotionStack(input), new Map(lines.map(line => [line.id, line.id])));
};

describe('refund cash unit & independent credit unit authority', () => {
  it('rounds imported gross UNIT before multiplying selected quantity', () => {
    const line = imported(); const unit = refundUnitBases({ currency: 'USD', pricingSnapshot: null }, [line]).get(id)!;
    expect(unit).toBe(100);
    expect(refundLineCashAmount(line, 3, unit, true)).toBe(300); // line projection is 299
  });
  it('uses placed quantity after source cancellation & source gross tax conversion', () => {
    const line = { ...imported({ quantity: 1, placedQuantity: 3, listPriceIncludesTax: false, adjustments: [{ amount: -30 }], taxLines: [{ taxRate: 10 }] }), quantity: 1 };
    expect(refundUnitBases({ currency: 'USD', pricingSnapshot: null }, [line]).get(id)).toBe(99);
    expect(refundUnitBases({ currency: 'USD', pricingSnapshot: null }, [imported({ placedQuantity: 0 })]).get(id)).toBe(0);
  });
  it('uses validated native frozen units & refuses a changed economic hash', () => {
    const input: StackInput = { currency: 'USD', pricesIncludeTax: true, couponCodes: [], phase: 'PaymentSettled',
      lines: [{ key: 'line', quantity: 3, placedQuantity: 3, unitListPrice: 100, priceIncludesTax: true, taxRateBps: 0,
        priorAdjustments: [{ kind: 'order', amount: -1 }] }], promotions: [], shipping: 0, shippingTaxRateBps: 0,
      shippingIncludesTax: true, couponContext: { activeVerifications: [] } };
    const snapshot = buildOrderPricingSnapshot(input, calculatePromotionStack(input), new Map([['line', id]]));
    const line = { id, quantity: 2, unitPrice: 100, lineTotal: 199 };
    expect(refundUnitBases({ currency: 'USD', pricingSnapshot: snapshot }, [line]).get(id)).toBe(100);
    snapshot.lines[0]!.proratedUnitPriceWithTax = 99;
    expect(() => refundUnitBases({ currency: 'USD', pricingSnapshot: snapshot }, [line])).toThrow();
  });
  it('uses validated current snapshot for every all-imported line over retained source units', () => {
    const lines = [imported(), { ...imported(), id: secondId }];
    const snapshot = currentSnapshot([{ id, quantity: 3, unitListPrice: 200 }, { id: secondId, quantity: 3, unitListPrice: 300 }]);
    expect(refundUnitBases({ currency: 'USD', pricingSnapshot: snapshot }, lines)).toEqual(new Map([[id, 200], [secondId, 300]]));
  });
  it('uses one validated current snapshot across mixed imported & native lines', () => {
    const lines = [imported(), { id: secondId, quantity: 3, unitPrice: 1000, lineTotal: 3000 }];
    const snapshot = currentSnapshot([{ id, quantity: 3, unitListPrice: 250 }, { id: secondId, quantity: 3, unitListPrice: 400 }]);
    expect(refundUnitBases({ currency: 'USD', pricingSnapshot: snapshot }, lines)).toEqual(new Map([[id, 250], [secondId, 400]]));
  });
  it('refuses malformed nonnull all-imported snapshots & incomplete order-line closure', () => {
    const lines = [imported(), { ...imported(), id: secondId }];
    const snapshot = currentSnapshot([{ id, quantity: 3, unitListPrice: 200 }, { id: secondId, quantity: 3, unitListPrice: 300 }]);
    expect(() => refundUnitBases({ currency: 'USD', pricingSnapshot: snapshot }, [lines[0]!])).toThrow(/line closure/);
    snapshot.quoteHash = 'changed';
    expect(() => refundUnitBases({ currency: 'USD', pricingSnapshot: snapshot }, lines)).toThrow(/economic hash/);
    expect(() => refundUnitBases({ currency: 'USD', pricingSnapshot: {} }, lines)).toThrow();
  });
  it('preserves generic legacy fallback but never treats it as credit proof', () => {
    const line = { id, quantity: 3, unitPrice: 100, lineTotal: 299 };
    expect(refundUnitBases({ currency: 'USD', pricingSnapshot: null }, [line]).get(id)).toBeNull();
    expect(refundLineCashAmount(line, 2, null, false)).toBe(199);
    expect(() => refundLineCashAmount(line, 2, null, true)).toThrow();
    expect(() => refundUnitBases({ currency: 'USD', pricingSnapshot: null }, [imported({ listPrice: '100' })])).toThrow();
  });
  it('accepts a zero-valued selected credit unit & advances exact posted prefix', () => {
    expect(proveCreditMerchandiseReturn(redeem, [], selection())).toEqual({ redemptionId: 'redeem', accountId: 'credit' });
    const prior = { accountCreditId: 'credit', relatedTransactionId: 'redeem', orderLineId: id, quantity: 1, amount: 0, delta: 0 };
    expect(proveCreditMerchandiseReturn(redeem, [prior], selection(2))).toEqual({ redemptionId: 'redeem', accountId: 'credit' });
    expect(() => proveCreditMerchandiseReturn(redeem, [{ ...prior, amount: 1, delta: 1 }], selection())).toThrow();
    expect(() => proveCreditMerchandiseReturn(redeem, [{ ...prior, orderLineId: null }], selection())).toThrow();
    expect(() => proveCreditMerchandiseReturn(redeem, [{ ...prior, relatedTransactionId: 'other' }], selection())).toThrow();
  });
  it('refuses missing/foreign/unlinked/excess/duplicate merchandise & bad redemption signs', () => {
    expect(() => proveCreditMerchandiseReturn(undefined, [], selection())).toThrow();
    expect(() => proveCreditMerchandiseReturn(redeem, [], [])).toThrow();
    expect(() => proveCreditMerchandiseReturn(redeem, [], [...selection(), ...selection()])).toThrow();
    expect(() => proveCreditMerchandiseReturn(redeem, [], [{ orderLineId: 'other', quantity: 1 }])).toThrow();
    expect(() => proveCreditMerchandiseReturn(redeem, [], selection(4))).toThrow();
    expect(() => proveCreditMerchandiseReturn({ ...redeem, delta: 101 }, [], selection())).toThrow();
    expect(() => proveCreditMerchandiseReturn({ ...redeem, amount: 1, delta: -1 }, [], selection(3))).toThrow();
  });
  it('projects only bounded credit reconciliation facts', () => {
    expect(refundCreditProjection({ creditRestoration: { state: 'posted', amount: 0, private: 'hidden' } })).toEqual({ state: 'posted', amount: 0 });
    expect(refundCreditProjection({ creditRestoration: { state: 'other', amount: 0 } })).toBeNull();
  });
});
