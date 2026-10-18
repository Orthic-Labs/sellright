import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import * as s from '../db/schema.js';
import { assertTestDatabase } from '../db/rls-test-utils.js';
import { importOrders } from './orders.js';
import { migrationId, type ImportContext } from './context.js';

const URL = process.env.IMPORT_TARGET_DATABASE_URL ?? process.env.DATABASE_URL;
if (!URL) throw new Error('Set IMPORT_TARGET_DATABASE_URL or DATABASE_URL to a disposable *_test database');
assertTestDatabase(URL, 'orders.charges.db.test.ts');
const pool = new Pool({ connectionString: URL, max: 1 });
afterAll(async () => { await pool.end(); });
afterEach(() => { vi.restoreAllMocks(); });

function source(options: { stale?: boolean; paid?: number; refund?: number; quantity?: string } = {}) {
  const header = options.stale ? { sub: '200', subt: '240', ship: '20', shipt: '24' }
    : { sub: '219', subt: '263', ship: '95', shipt: '114' };
  const order = { id: 1, code: 'CHARGES', state: 'PaymentSettled', cur: 'USD', ...header,
    placed: null, created: null, updated: null, coupons: '', shipaddr: '{}', billaddr: '{}', cid: null, ispre: false,
    source_record: JSON.stringify({ id: 1, subTotal: header.sub, subTotalWithTax: header.subt,
      shipping: header.ship, shippingWithTax: header.shipt }) };
  const surcharges = [
    { id: 31, orderId: 1, description: 'Processing fee', listPrice: 50, listPriceIncludesTax: false, taxLines: [{ taxRate: 20 }] },
    { id: 32, orderId: 1, description: 'Historical credit', listPrice: -25, listPriceIncludesTax: true, taxLines: [{ taxRate: 20 }] },
    { id: 33, orderId: 1, description: 'Waived fee', listPrice: 0, listPriceIncludesTax: false, taxLines: [] },
  ];
  const shipping = [
    { id: 41, orderId: 1, listPrice: 100, listPriceIncludesTax: true, taxLines: [{ taxRate: 20 }], adjustments: [{ amount: -10 }] },
    { id: 42, orderId: 1, listPrice: 20, listPriceIncludesTax: false, taxLines: [{ taxRate: 20 }], adjustments: [] },
  ];
  const payment = options.paid === undefined ? [] : [{ id: 51, oid: 1, amount: options.paid, method: 'standard-payment', state: 'Settled',
    txn: 'capture-51', metadata: null, created: null, err: null, source_created_at: null, source_metadata: null,
    source_record: JSON.stringify({ id: 51, orderId: 1, amount: options.paid, state: 'Settled' }) }];
  return {
    header, order, surcharges, shipping,
    q: async (query: string) => {
      if (query.includes('FROM "order" o')) return [order];
      if (query.includes('FROM payment p WHERE')) return payment.map(row => ({ ...row, id: String(row.id), settled: String(row.amount) }));
      if (query.includes('FROM refund r JOIN')) return options.refund === undefined ? [] : [{ id: '61', oid: 1, refunded: String(options.refund),
        source_record: JSON.stringify({ id: 61, paymentId: 51, state: 'Settled', total: options.refund }) }];
      if (query.includes('FROM surcharge c')) return surcharges.map(row => ({ oid: row.orderId, source_record: JSON.stringify(row) }));
      if (query.includes('source_record FROM shipping_line sl')) return shipping.map(row => ({ oid: row.orderId, source_record: JSON.stringify(row) }));
      if (query.includes('SELECT DISTINCT ON')) return [{ oid: 1, code: 'historic', name: 'Historical shipping' }];
      if (query.includes('FROM order_line ol')) return [{ id: 11, oid: 1, vid: null, qty: options.quantity ?? '2', placed_qty: '0',
        price: '100', includes_tax: false, adjustments: '[{"amount":-10,"type":"PROMOTION"}]', tax_lines: '[{"taxRate":20}]', sku: 'historic', pname: 'Historical merchandise' }];
      if (query.includes('FROM payment_method')) return [];
      if (query.includes('FROM payment p')) return payment;
      throw new Error(`Unexpected import source query: ${query}`);
    },
  };
}

async function fixture<T>(options: Parameters<typeof source>[0], fn: (input: {
  ctx: ImportContext; tx: ImportContext['tx']; data: ReturnType<typeof source>;
}) => Promise<T>) {
  const client = await pool.connect();
  const storeId = randomUUID(), sourceKey = 'synthetic-charges';
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_store', $1, true)", [storeId]);
    const tx: ImportContext['tx'] = drizzle(client, { schema: s, casing: 'snake_case' });
    await tx.insert(s.store).values({ id: storeId, slug: `charges-${storeId}`, name: 'Synthetic charges', currency: 'USD' });
    const data = source(options);
    const ctx: ImportContext = { tx, source: client, storeId, sourceKey, channelId: 1, currency: 'USD', gatewayAccounts: {}, exclusions: [],
      sourceColumns: new Map([['order_line', new Set(['listPriceIncludesTax', 'adjustments', 'taxLines', 'orderPlacedQuantity'])]]),
      id: (entity: string, id: unknown) => migrationId(storeId, sourceKey, entity, id), q: data.q };
    return await fn({ ctx, tx, data });
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

describe('persisted imported signed charges', () => {
  it('seeds real deterministic signed & zero adjustments with independent shipping tax', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    await fixture({}, async ({ ctx, tx, data }) => {
      await importOrders(ctx);
      expect(output).toHaveBeenCalledTimes(1);
      expect(JSON.parse(output.mock.calls[0]![0] as string)).toMatchObject({ orders: 1, moneyReconciled: true });
      const [order] = await tx.select().from(s.order).where(eq(s.order.storeId, ctx.storeId));
      expect(order).toMatchObject({ subtotal: 200, discountTotal: 10, shippingTotal: 95, taxTotal: 63, grandTotal: 377 });
      const adjustments = await tx.select().from(s.orderAdjustment).where(eq(s.orderAdjustment.storeId, ctx.storeId));
      expect(adjustments).toHaveLength(3);
      expect(adjustments).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: ctx.id('order-adjustment', 31), label: 'Processing fee', amount: 50 }),
        expect.objectContaining({ id: ctx.id('order-adjustment', 32), label: 'Historical credit', amount: -21 }),
        expect.objectContaining({ id: ctx.id('order-adjustment', 33), label: 'Waived fee', amount: 0 }),
      ]));
      const metadata = order!.metadata as { vendure: { sourceOrderRecord: string; chargeProjectionV1: Record<string, unknown> } };
      expect(metadata.vendure.sourceOrderRecord).toBe(data.order.source_record);
      expect(metadata.vendure.chargeProjectionV1).toMatchObject({ status: 'exact-header',
        sourceHeader: { subTotal: '219', subTotalWithTax: '263', shipping: '95', shippingWithTax: '114' } });
      const lines = await tx.select().from(s.orderLine).where(eq(s.orderLine.storeId, ctx.storeId));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ quantity: 2, lineSubtotal: 200, lineDiscount: 10, lineTax: 38, lineTotal: 228 });
      expect(lines[0]!.metadata).toMatchObject({ vendure: { placedQuantity: 0 } });
      expect(ctx.exclusions).toEqual([]);
    });
  });

  it('retains stored header even when settled minus refunded grand corroborates reconstructed charges', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    await fixture({ stale: true, paid: 400, refund: 23 }, async ({ ctx, tx, data }) => {
      await importOrders(ctx);
      expect(output).toHaveBeenCalledTimes(1);
      expect(JSON.parse(output.mock.calls[0]![0] as string)).toMatchObject({ orders: 1, moneyReconciled: false });
      const [order] = await tx.select().from(s.order).where(eq(s.order.storeId, ctx.storeId));
      expect(order).toMatchObject({ subtotal: 200, discountTotal: 0, shippingTotal: 20, taxTotal: 44, grandTotal: 264 });
      const projection = (order!.metadata as { vendure: { chargeProjectionV1: Record<string, unknown> } }).vendure.chargeProjectionV1;
      expect(projection).toMatchObject({ status: 'settled-corroborated',
        sourceHeader: { subTotal: '200', subTotalWithTax: '240', shipping: '20', shippingWithTax: '24' },
        settlementProof: { netSettled: '377', payments: [{ sourceId: '51', sourceRecord: expect.any(String) }],
          refunds: [{ sourceId: '61', sourceRecord: expect.any(String) }] } });
      expect((order!.metadata as { vendure: { sourceOrderRecord: string } }).vendure.sourceOrderRecord).toBe(data.order.source_record);
      expect(await tx.select().from(s.orderAdjustment).where(eq(s.orderAdjustment.storeId, ctx.storeId))).toEqual([]);
      expect(ctx.exclusions).toEqual([expect.objectContaining({ table: 'order', blocking: false,
        detail: expect.stringContaining('known_historical_financial_quarantine HEADER_CHARGE_CONTRADICTION'), sourceValues: [expect.any(String)] })]);
      expect(JSON.parse(ctx.exclusions[0]!.sourceValues![0]!)).toEqual(projection);
    });
  });

  it.each([undefined, 342])('preserves unproven header finances & seeds no charges (net=%s)', async paid => {
    await fixture({ stale: true, paid }, async ({ ctx, tx }) => {
      await importOrders(ctx);
      const [order] = await tx.select().from(s.order).where(eq(s.order.storeId, ctx.storeId));
      expect(order).toMatchObject({ subtotal: 200, discountTotal: 0, shippingTotal: 20, taxTotal: 44, grandTotal: 264 });
      expect((order!.metadata as { vendure: { chargeProjectionV1: unknown } }).vendure.chargeProjectionV1).toMatchObject({ status: 'unresolved' });
      expect(await tx.select().from(s.orderAdjustment).where(eq(s.orderAdjustment.storeId, ctx.storeId))).toEqual([]);
      expect(ctx.exclusions).toEqual([expect.objectContaining({ table: 'order', blocking: false,
        detail: expect.stringContaining('known_historical_financial_quarantine HEADER_CHARGE_CONTRADICTION'), sourceValues: expect.any(Array) })]);
    });
  });

  it('rejects unsafe quantity before any operational financial insert', async () => {
    await fixture({ quantity: '9007199254740993' }, async ({ ctx, tx }) => {
      await expect(importOrders(ctx)).rejects.toThrow(/Unsafe.*quantity/);
      expect(await tx.select().from(s.order).where(eq(s.order.storeId, ctx.storeId))).toEqual([]);
      expect(await tx.select().from(s.orderLine).where(eq(s.orderLine.storeId, ctx.storeId))).toEqual([]);
      expect(await tx.select().from(s.orderAdjustment).where(eq(s.orderAdjustment.storeId, ctx.storeId))).toEqual([]);
    });
  });
});
