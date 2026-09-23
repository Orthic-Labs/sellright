import { describe, expect, it } from 'vitest';
import { StockReservationError, reserveStockOrThrow, validateReservableItems } from './stock-reservation.js';

const variant = (overrides: Partial<{ id: string; sku: string; enabled: boolean; isPreOrder: boolean; fulfillmentType: string }> = {}) => ({
  id: overrides.id ?? 'variant-1',
  sku: overrides.sku ?? 'SKU-1',
  enabled: overrides.enabled ?? true,
  isPreOrder: overrides.isPreOrder ?? false,
  fulfillmentType: overrides.fulfillmentType ?? 'physical',
});

describe('stock reservation', () => {
  it('detects missing and disabled items before any stock update', () => {
    const bySku = new Map([
      ['DISABLED', variant({ id: 'disabled-1', sku: 'DISABLED', enabled: false })],
      ['OK', variant({ id: 'ok-1', sku: 'OK' })],
    ]);

    expect(validateReservableItems([{ sku: 'MISSING', quantity: 1 }, { sku: 'DISABLED', quantity: 1 }, { sku: 'OK', quantity: 1 }], bySku)).toEqual(['MISSING', 'DISABLED']);
  });

  it('throws on stock update failure so the surrounding transaction rolls back prior allocations', async () => {
    const calls: string[] = [];
    const tx = {
      async execute() {
        calls.push('update');
        return { rowCount: calls.length === 1 ? 1 : 0 };
      },
    };
    const bySku = new Map([
      ['A', variant({ id: 'a', sku: 'A' })],
      ['B', variant({ id: 'b', sku: 'B' })],
    ]);

    await expect(reserveStockOrThrow(tx, 'store-1', [{ sku: 'A', quantity: 1 }, { sku: 'B', quantity: 1 }], bySku)).rejects.toBeInstanceOf(StockReservationError);
    expect(calls).toHaveLength(2);
  });

  it('does not require stock rows for license variants', async () => {
    const calls: string[] = [];
    const tx = {
      async execute() {
        calls.push('update');
        return { rowCount: 0 };
      },
    };
    const bySku = new Map([
      ['VIEWRIGHT-PRO', variant({ id: 'license-1', sku: 'VIEWRIGHT-PRO', fulfillmentType: 'license' })],
    ]);

    // Nothing physical was reserved — false tells the caller not to trigger a
    // stock-changed manifest regeneration (see reserveStockOrThrow's JSDoc).
    await expect(reserveStockOrThrow(tx, 'store-1', [{ sku: 'VIEWRIGHT-PRO', quantity: 1 }], bySku)).resolves.toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('reports a change when a physical item is successfully reserved (caller must trigger onStockChanged)', async () => {
    const tx = { async execute() { return { rowCount: 1 }; } };
    const bySku = new Map([['A', variant({ id: 'a', sku: 'A' })]]);
    await expect(reserveStockOrThrow(tx, 'store-1', [{ sku: 'A', quantity: 1 }], bySku)).resolves.toBe(true);
  });
});
