import { describe, expect, it } from 'vitest';
import { StockReservationError, reserveStockOrThrow, validateReservableItems } from './stock-reservation.js';

const variant = (overrides: Partial<{ id: string; sku: string; enabled: boolean; isPreOrder: boolean }> = {}) => ({
  id: overrides.id ?? 'variant-1',
  sku: overrides.sku ?? 'SKU-1',
  enabled: overrides.enabled ?? true,
  isPreOrder: overrides.isPreOrder ?? false,
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
});
