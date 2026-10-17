import { describe, expect, it } from 'vitest';
import * as s from '../db/schema.js';
import { importSessionsAndCarts } from './sessions-carts.js';
import type { ImportContext } from './context.js';

function fixture(codes: unknown, promotions = ['SAVE', ' CREDIT ']) {
  const saved: Array<{ table: unknown; value: Record<string, unknown> }> = [];
  const exclusions: ImportContext['exclusions'] = [];
  const carts = new Set<string>();
  const raw = JSON.stringify(codes);
  const tx = {
    select: () => ({ from: () => ({ where: async () => promotions.map(code => ({ code })) }) }),
    insert: (table: unknown) => ({ values: (value: Record<string, unknown>) => {
      saved.push({ table, value });
      return { onConflictDoNothing: () => ({ returning: async () => {
        if (carts.has(String(value.id))) return [];
        carts.add(String(value.id)); return [{ id: value.id }];
      } }) };
    } }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  };
  const ctx = { tx, exclusions, storeId: 'store', sourceKey: 'source', channelId: 1, currency: 'USD',
    id: (entity: string, id: unknown) => `${entity}:${id}`,
    q: async (query: string) => query.includes('FROM session') ? [1, 2].map(id => ({ id, token: `proof-${id}`, type: 'AnonymousSession', invalidated: false,
      channel: 1, oid: 12, uid: null, expires: new Date(Date.now() + 60_000).toISOString() }))
      : query.includes('FROM "order"') ? [{ id: 12, couponCodes: codes, raw_coupon_codes: raw, shippingAddress: {} }] : [],
  } as unknown as ImportContext;
  return { ctx, saved, exclusions, raw };
}

describe('active source cart coupon retention', () => {
  it('imports complete canonical stack, private invalid facts & exact duplicate counts once per shared cart', async () => {
    const f = fixture(['Save', 'save', ' CREDIT ', 17]); await importSessionsAndCarts(f.ctx);
    expect(f.saved.filter(row => row.table === s.cart).map(row => row.value.couponCodes)).toEqual([['SAVE', ' CREDIT '], ['SAVE', ' CREDIT ']]);
    expect(f.saved.filter(row => row.table === s.legacySessionGrant).map(row => row.value.couponCode)).toEqual(['SAVE', 'SAVE']);
    expect(f.exclusions).toHaveLength(2);
    expect(f.exclusions).toEqual(expect.arrayContaining([
      expect.objectContaining({ blocking: true, count: 1, sourceValues: [f.raw] }),
      expect.objectContaining({ type: 'merged-duplicate', count: 1, sourceValues: [f.raw] }),
    ]));
    expect(f.exclusions.some(row => row.detail.includes('supports one'))).toBe(false);
  });
  it('retains unknown codes & blocks parity instead of waiving unresolved source intent', async () => {
    const f = fixture(['SAVE', 'UNKNOWN']); await importSessionsAndCarts(f.ctx);
    expect(f.saved.find(row => row.table === s.cart)?.value.couponCodes).toEqual(['SAVE', 'UNKNOWN']);
    expect(f.exclusions).toEqual([expect.objectContaining({ blocking: true, count: 1, sourceValues: [f.raw] })]);
  });
});
