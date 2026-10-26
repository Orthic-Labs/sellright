/**
 * #375: the OpenAI CAPI job pass against a *_test database: one send per live-paid order, never for test-mode, unpaid
 * or out-of-window orders; retries with backoff; a rejection is final; validate-only acceptances are re-sent live once
 * validate-only is off; the client IP address / user agent are dropped after the live acceptance; no config = no-op.
 */
import { requireDisposablePostgresUrl as assertTestDatabase } from '../db/test-database-url.js';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { openaiCapiPass, type CapiConfig } from './openai-capi.js';

assertTestDatabase(process.env.DATABASE_URL ?? env.DATABASE_URL, 'openai-capi.db.test.ts');

const STORE = 'abababab-abab-abab-abab-abababab0375';
const LIVE: CapiConfig = { pixelId: 'PIX', key: 'k', validateOnly: false, storefrontUrl: 'https://shop.test' };
const NOW = new Date();
const wipe = () => pool.query('TRUNCATE store CASCADE');

async function order(code: string, o: { state?: string; paidHoursAgo?: number; attempts?: Array<'live' | 'test'>; adMatch?: unknown } = {}): Promise<string> {
  return withStore(STORE, async (tx) => {
    const placed = new Date(NOW.getTime() - (o.paidHoursAgo ?? 1) * 3_600_000).toISOString();
    const r = await tx.execute(sql`INSERT INTO "order" (id, store_id, code, state, currency, grand_total, placed_at, metadata, shipping_address)
      VALUES (gen_random_uuid(), ${STORE}, ${code}, ${o.state ?? 'Paid'}, 'USD', 2500, ${placed}::timestamptz,
        ${JSON.stringify({ contact: { email: 'buyer@example.com' }, ...(o.adMatch === undefined ? { adMatch: { visitorId: 'vid-0001-abcd', ip: '198.51.100.7', userAgent: 'UA' } } : {}) })}::jsonb,
        ${JSON.stringify({ fullName: 'Ada Lovelace', phone: '+1 415 555 2671', country: 'US' })}::jsonb) RETURNING id`);
    const id = (r.rows[0] as { id: string }).id;
    await tx.execute(sql`INSERT INTO order_line (id, store_id, order_id, variant_sku, variant_name, quantity, unit_price, line_subtotal, line_total, fulfilled_qty)
      VALUES (gen_random_uuid(), ${STORE}, ${id}, 'SKU1', 'Shirt', 1, 2500, 2500, 2500, 0)`);
    for (const mode of o.attempts ?? ['live']) {
      await tx.execute(sql`INSERT INTO payment_attempt (store_id, order_id, operation, method, account_id, mode, amount, currency, idempotency_key, fingerprint, status)
        VALUES (${STORE}, ${id}, 'charge', 'nmi', 'acct', ${mode}, 2500, 'USD', gen_random_uuid()::text, 'fp', 'settled')`);
    }
    return id;
  });
}
const meta = (code: string) => withStore(STORE, async (tx) =>
  ((await tx.execute(sql`SELECT metadata FROM "order" WHERE code = ${code}`)).rows[0] as { metadata: Record<string, any> }).metadata);
const ok = () => vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
const sentIds = (f: ReturnType<typeof vi.fn>) => f.mock.calls.map((c) => JSON.parse(c[1].body).events[0].id).sort();

describe('openaiCapiPass (#375)', () => {
  beforeEach(async () => {
    await wipe();
    await pool.query(`INSERT INTO store (id, slug, name) VALUES ($1, 'capi-test', 'capi-test')`, [STORE]);
  });
  afterAll(async () => { await wipe(); await pool.end(); });

  it('sends each live-paid order once; never test-mode, mixed-test, unpaid, cancelled or out-of-window orders', async () => {
    await order('LIVE-1');
    await order('LIVE-REFUNDED', { state: 'Refunded' });
    await order('TEST-1', { attempts: ['test'] });
    await order('MIXED', { attempts: ['live', 'test'] });
    await order('NO-ATTEMPT', { attempts: [] });
    await order('UNPAID', { state: 'PendingPayment' });
    await order('CANCELLED', { state: 'Cancelled' });
    await order('OLD', { paidHoursAgo: 7 * 24 });
    const f = ok();
    expect(await openaiCapiPass({ config: LIVE, fetchImpl: f, now: NOW })).toEqual({ sent: 2, validated: 0, retry: 0, rejected: 0 });
    expect(sentIds(f)).toEqual(['purchase_LIVE-1', 'purchase_LIVE-REFUNDED']);
    const replay = ok();
    expect(await openaiCapiPass({ config: LIVE, fetchImpl: replay, now: NOW })).toEqual({ sent: 0, validated: 0, retry: 0, rejected: 0 });
    expect(replay).not.toHaveBeenCalled();
    const m = await meta('LIVE-1');
    expect(m.openaiCapi).toMatchObject({ status: 'sent', tries: 1 });
    expect(m.adMatch).toEqual({ visitorId: 'vid-0001-abcd' }); // IP address and user agent dropped after the live acceptance
  });

  it('retries a 5xx with backoff, then sends; a 4xx is final', async () => {
    await order('RETRY-1');
    await order('BAD-1');
    const f = vi.fn(async (_u: string, init: RequestInit) => JSON.parse(String(init.body)).events[0].id === 'purchase_BAD-1'
      ? new Response('{"error":"invalid"}', { status: 400 }) : new Response('down', { status: 503 }));
    expect(await openaiCapiPass({ config: LIVE, fetchImpl: f, now: NOW })).toEqual({ sent: 0, validated: 0, retry: 1, rejected: 1 });
    expect((await meta('RETRY-1')).openaiCapi).toMatchObject({ status: 'retry', tries: 1, httpStatus: 503 });
    expect((await meta('BAD-1')).openaiCapi).toMatchObject({ status: 'rejected', httpStatus: 400 });
    // Before the backoff elapses nothing is sent; after it the retry goes out and the rejection stays final.
    const early = ok();
    expect(await openaiCapiPass({ config: LIVE, fetchImpl: early, now: new Date(NOW.getTime() + 60_000) })).toMatchObject({ sent: 0 });
    expect(early).not.toHaveBeenCalled();
    const later = ok();
    expect(await openaiCapiPass({ config: LIVE, fetchImpl: later, now: new Date(NOW.getTime() + 6 * 60_000) })).toMatchObject({ sent: 1 });
    expect(sentIds(later)).toEqual(['purchase_RETRY-1']);
    expect((await meta('RETRY-1')).openaiCapi).toMatchObject({ status: 'sent', tries: 2 });
  });

  it('validate-only first, then the same order is sent live once validate-only is off', async () => {
    await order('VAL-1');
    const v = ok();
    expect(await openaiCapiPass({ config: { ...LIVE, validateOnly: true }, fetchImpl: v, now: NOW })).toMatchObject({ validated: 1 });
    expect(JSON.parse(v.mock.calls[0]![1].body).validate_only).toBe(true);
    expect((await meta('VAL-1')).adMatch.ip).toBe('198.51.100.7'); // kept until the live send
    const again = ok();
    expect(await openaiCapiPass({ config: { ...LIVE, validateOnly: true }, fetchImpl: again, now: NOW })).toMatchObject({ validated: 0 });
    expect(again).not.toHaveBeenCalled();
    const live = ok();
    expect(await openaiCapiPass({ config: LIVE, fetchImpl: live, now: NOW })).toMatchObject({ sent: 1 });
    expect(JSON.parse(live.mock.calls[0]![1].body).validate_only).toBe(false);
  });

  it('does nothing without a pixel id and key', async () => {
    await order('LIVE-2');
    const f = ok();
    expect(await openaiCapiPass({ config: null, fetchImpl: f, now: NOW })).toEqual({ sent: 0, validated: 0, retry: 0, rejected: 0 });
    expect(f).not.toHaveBeenCalled();
  });
});
