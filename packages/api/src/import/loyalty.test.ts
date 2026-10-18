import { describe, expect, it, vi } from 'vitest';
import { classifyPromotionActions } from './catalog.js';
import { importLoyalty } from './loyalty.js';
import { loyaltySettingsFromConfig } from '../money/loyalty.js';
import type { ImportContext } from './context.js';

describe('importer: promotion action classification', () => {
  const a = (code: string) => ({ code, args: [] });
  it('keeps single-action promotions', () => {
    expect(classifyPromotionActions([a('order_percentage_discount')])).toBe('single');
    expect(classifyPromotionActions([a('free_shipping')])).toBe('single');
  });
  it('routes dynamic store-credit actions to dedicated monetary import', () => {
    expect(classifyPromotionActions([a('account_credit_discount')])).toBe('account_credit');
    expect(classifyPromotionActions([a('order_fixed_discount'), a('account_credit_discount')])).toBe('account_credit');
  });
  it('flags discount + free shipping as multi-action', () => {
    expect(classifyPromotionActions([a('order_percentage_discount'), a('free_shipping')])).toBe('multi_action');
    expect(classifyPromotionActions([a('free_shipping'), a('order_fixed_discount')])).toBe('multi_action');
  });
  it('leaves anything else unsupported (still a hard failure upstream)', () => {
    expect(classifyPromotionActions([a('order_percentage_discount'), a('order_fixed_discount')])).toBe('unsupported');
    expect(classifyPromotionActions([])).toBe('unsupported');
  });
});

describe('importer: monetary credit never duplicates loyalty value', () => {
  it('writes no points regardless of target loyalty configuration', async () => {
    const q = vi.fn(() => { throw new Error('Monetary credits must not be read as loyalty points'); });
    const insert = vi.fn(() => { throw new Error('Monetary credits must not create loyalty value'); });
    const ctx = { q, tx: { insert }, sourceColumns: new Map([['account_credit', new Set(['balance'])]]) } as unknown as ImportContext;
    expect(await importLoyalty(ctx, null)).toEqual({ imported: 0, points: 0 });
    expect(await importLoyalty(ctx, loyaltySettingsFromConfig({ loyalty: { enabled: true, pointsPerDollarOff: 50 } }))).toEqual({ imported: 0, points: 0 });
    expect(q).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });
});
