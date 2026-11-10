/**
 * #446 backorder / incoming stock, end to end against the lane test DB (these wipe data; *_test database only).
 *
 * Covers: reservation (in stock, partial -> backorder, beyond sellable fails, concurrent, missing row fails closed),
 * catalog + live stock payloads, cart estimate fields, checkout line snapshot, order read, admin incoming/label
 * validation + receive, fulfilment refusal, confirmation email, feed + JSON-LD availability, restock, order-edit variant picker.
 */
import { requireDisposablePostgresUrl as assertTestDatabase } from '../db/test-database-url.js';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';

vi.mock('../manifest/stock-hook.js', () => ({ onStockChanged: vi.fn() }));
vi.mock('../email/wake.js', () => ({ wakeEmailDelivery: vi.fn() }));

import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { createAdminSession } from '../auth/admin-session.js';
import { clearLoginAttempts } from '../auth/rate-limit.js';
import { rateLimitBackend } from '../auth/rate-limit-backend.js';
import { invalidateStoreCache } from '../store-context.js';
import { onStockChanged } from '../manifest/stock-hook.js';
import { reserveStock, StockReservationError, type ReservableVariant } from '../orders/stock-reservation.js';
import { sendOrderConfirmationAndEnrol } from '../payments/paid-effects.js';
import { searchEditVariants } from '../orders/order-edit-service.js';
import { catalog } from './catalog.js';
import { cart } from './cart.js';
import { checkout } from './checkout.js';
import { orders } from './orders.js';
import { adminProducts } from './admin-products.js';
import { adminCatalog } from './admin-catalog.js';
import { admin } from './admin.js';
import { adminOrderEdit } from './admin-order-edit.js';
import { shopExtra } from './shop-extra.js';
import { feeds } from './feeds.js';
import { seo } from './seo.js';
import { restockRoutes, sweepRestockEvents } from './restock.js';

assertTestDatabase(process.env.DATABASE_URL ?? env.DATABASE_URL, 'backorder.db.test.ts');

const STORE = 'b0446000-0000-4000-8000-000000000001';
const SLUG = 'backorder-446-test';
const ADMIN = 'b0446000-0000-4000-8000-000000000002';
const PRODUCT = 'b0446000-0000-4000-8000-0000000000a1';
const V = 'b0446000-0000-4000-8000-0000000000b1'; // on_hand 2, incoming 5, label
const V_NOROW = 'b0446000-0000-4000-8000-0000000000b2'; // label but no stock row
const V_DIGITAL = 'b0446000-0000-4000-8000-0000000000b3';
const SKU = 'BO-1';
const LABEL = 'Ships in 3 weeks';

const app = new OpenAPIHono();
for (const r of [catalog, cart, checkout, orders, adminProducts, adminCatalog, admin, adminOrderEdit, shopExtra, feeds, seo, restockRoutes]) app.route('/', r);

let token = '';
const hdr = (extra: Record<string, string> = {}) => ({ 'content-type': 'application/json', 'x-store-slug': SLUG, ...extra });
const adminHdr = () => hdr({ authorization: `Bearer ${token}` });
const bySku = new Map<string, ReservableVariant>([[SKU, { id: V, sku: SKU, enabled: true, isPreOrder: false, fulfillmentType: 'physical' }]]);

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM "session"');
  await pool.query('DELETE FROM admin_user');
}

async function setStock(onHand: number, incoming: number, allocated: number, variant = V) {
  await withStore(STORE, (tx) => tx.execute(sql`UPDATE stock SET on_hand = ${onHand}, incoming = ${incoming}, allocated = ${allocated} WHERE variant_id = ${variant}`));
}
async function stockRow(variant = V) {
  return withStore(STORE, async (tx) => (await tx.execute(sql`SELECT on_hand, incoming, allocated FROM stock WHERE variant_id = ${variant}`)).rows[0] as { on_hand: number; incoming: number; allocated: number });
}

beforeEach(async () => {
  await wipe();
  vi.clearAllMocks();
  await rateLimitBackend().clear('checkout-ip', `unknown|${STORE}`);
  await clearLoginAttempts('unknown', `checkout:${STORE}:guest`);
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name, currency, tax_rate, config) VALUES (${STORE}, ${SLUG}, ${SLUG}, 'USD', 0, '{"seo":{"siteUrl":"https://shop.example.net"}}'::jsonb)`);
    await tx.execute(sql`INSERT INTO admin_user (id, email, password_hash) VALUES (${ADMIN}, 'owner@backorder.test', 'x')`);
    await tx.execute(sql`INSERT INTO admin_user_store (admin_user_id, store_id, role) VALUES (${ADMIN}, ${STORE}, 'owner')`);
    await tx.execute(sql`INSERT INTO product (id, store_id, slug, name, status) VALUES (${PRODUCT}, ${STORE}, 'bo-prod', 'Backorder Product', 'active')`);
    await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price, backorder_label) VALUES (${V}, ${STORE}, ${PRODUCT}, ${SKU}, 'Backorder Variant', 1000, ${LABEL})`);
    await tx.execute(sql`INSERT INTO stock (variant_id, store_id, on_hand, incoming, allocated) VALUES (${V}, ${STORE}, 2, 5, 0)`);
    await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price, backorder_label) VALUES (${V_NOROW}, ${STORE}, ${PRODUCT}, 'BO-NOROW', 'No stock row', 1500, ${LABEL})`);
    await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price, fulfillment_type) VALUES (${V_DIGITAL}, ${STORE}, ${PRODUCT}, 'BO-DIGI', 'Digital', 500, 'digital_download')`);
    await tx.execute(sql`INSERT INTO shipping_method (store_id, code, name, calculator) VALUES (${STORE}, 'standard', 'Standard', '{"flat":100}'::jsonb)`);
  });
  token = await createAdminSession(ADMIN);
  invalidateStoreCache();
});
afterAll(async () => { await wipe(); await pool.end(); });

describe('reservation (reserveStock)', () => {
  const reserve = (qty: number) => withStore(STORE, (tx) => reserveStock(tx, STORE, [{ sku: SKU, quantity: qty }], bySku));

  it('fully in stock is not a backorder line', async () => {
    expect(await reserve(2)).toEqual({ changed: true, backorder: [false] });
    expect(await stockRow()).toMatchObject({ on_hand: 2, allocated: 2 });
  });
  it('partly beyond warehouse stock is a backorder line, and allocated may exceed on_hand', async () => {
    expect((await reserve(3)).backorder).toEqual([true]);
    expect(await stockRow()).toMatchObject({ on_hand: 2, incoming: 5, allocated: 3 });
  });
  it('a line sold after warehouse stock is used up is a backorder line (read under the same lock)', async () => {
    await reserve(2);
    expect((await reserve(1)).backorder).toEqual([true]);
  });
  it('exactly the sellable quantity succeeds; one more fails and changes nothing', async () => {
    expect((await reserve(7)).backorder).toEqual([true]);
    await expect(reserve(1)).rejects.toBeInstanceOf(StockReservationError);
    expect(await stockRow()).toMatchObject({ allocated: 7 });
  });
  it('beyond sellable fails and rolls back', async () => {
    await expect(reserve(8)).rejects.toMatchObject({ skus: [SKU] });
    expect(await stockRow()).toMatchObject({ allocated: 0 });
  });
  it('a missing stock row fails closed even when the variant has a label', async () => {
    const map = new Map<string, ReservableVariant>([['BO-NOROW', { id: V_NOROW, sku: 'BO-NOROW', enabled: true, isPreOrder: false, fulfillmentType: 'physical' }]]);
    await expect(withStore(STORE, (tx) => reserveStock(tx, STORE, [{ sku: 'BO-NOROW', quantity: 1 }], map))).rejects.toBeInstanceOf(StockReservationError);
  });
  it('concurrent reservations never exceed sellable, and exactly the units past on_hand are backorders', async () => {
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => reserve(1)));
    const ok = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof reserve>>> => r.status === 'fulfilled');
    expect(ok).toHaveLength(7);
    expect(ok.filter((r) => r.value.backorder[0]).length).toBe(5);
    expect(await stockRow()).toMatchObject({ on_hand: 2, allocated: 7 });
  });
});

describe('catalog payloads', () => {
  const product = async () => (await (await app.request('/v1/shop/catalog/products/bo-prod', { headers: hdr() })).json()) as { variants: Array<Record<string, unknown>> };
  const live = async () => (await (await app.request('/v1/shop/catalog/products/bo-prod/stock', { headers: hdr() })).json()) as { variants: Array<Record<string, unknown>> };

  it('variant payload carries backorderLabel; availableQuantity is sellable and inStock holds', async () => {
    const v = (await product()).variants.find((x) => x.sku === SKU)!;
    expect(v).toMatchObject({ backorderLabel: LABEL, availableQuantity: 7, inStock: true });
  });
  it('live stock: ships now while warehouse stock remains, backorder once it is used up, sold out after incoming', async () => {
    const pick = async () => (await live()).variants.find((x) => x.sku === SKU)!;
    expect(await pick()).toMatchObject({ inStock: true, availableQuantity: 7, shipsNowQuantity: 2, backorder: false, backorderLabel: LABEL });
    await withStore(STORE, (tx) => tx.execute(sql`UPDATE product_variant SET backorder_label = '  ' WHERE id = ${V}`));
    expect((await pick()).backorderLabel).toBeNull();
    await withStore(STORE, (tx) => tx.execute(sql`UPDATE product_variant SET backorder_label = ${LABEL} WHERE id = ${V}`));
    await setStock(2, 5, 2);
    expect(await pick()).toMatchObject({ inStock: true, availableQuantity: 5, shipsNowQuantity: 0, backorder: true });
    await setStock(2, 5, 7);
    expect(await pick()).toMatchObject({ inStock: false, availableQuantity: 0, shipsNowQuantity: 0, backorder: false });
  });
  it('a variant with a label but no stock row is out of stock (fail closed)', async () => {
    const v = (await live()).variants.find((x) => x.sku === 'BO-NOROW')!;
    expect(v).toMatchObject({ inStock: false, availableQuantity: 0, backorder: false });
  });
  it('digital variants are unchanged (not quantity capped, no backorder)', async () => {
    const v = (await live()).variants.find((x) => x.sku === 'BO-DIGI')!;
    expect(v).toMatchObject({ inStock: true, availableQuantity: null, shipsNowQuantity: null, backorder: false });
  });
});

describe('cart estimate', () => {
  const estimate = async (items: Array<{ sku: string; quantity: number }>) => {
    const res = await app.request('/v1/shop/cart/estimate', { method: 'POST', headers: hdr(), body: JSON.stringify({ items }) });
    expect(res.status).toBe(200);
    return (await res.json()) as { lines: Array<Record<string, unknown>>; unavailable: string[]; subtotal: number };
  };
  it('a line within warehouse stock is not a backorder', async () => {
    const { lines } = await estimate([{ sku: SKU, quantity: 2 }]);
    expect(lines[0]).toMatchObject({ available: true, availableQuantity: 7, backorder: false, shipLabel: null, shipsNowQuantity: 2 });
  });
  it('a line past warehouse stock is a backorder line, still available, with the label; price is unchanged', async () => {
    const { lines, subtotal } = await estimate([{ sku: SKU, quantity: 3 }]);
    expect(lines[0]).toMatchObject({ available: true, backorder: true, shipLabel: LABEL, shipsNowQuantity: 2, unitPrice: 1000 });
    expect(subtotal).toBe(3000);
  });
  it('beyond sellable is unavailable', async () => {
    const { lines, unavailable } = await estimate([{ sku: SKU, quantity: 8 }]);
    expect(lines[0]).toMatchObject({ available: false, backorder: false });
    expect(unavailable).toEqual([SKU]);
  });
  it('missing stock row: 0 available, no backorder, label ignored', async () => {
    const { lines } = await estimate([{ sku: 'BO-NOROW', quantity: 1 }]);
    expect(lines[0]).toMatchObject({ available: false, availableQuantity: 0, backorder: false, shipLabel: null });
  });
  it('digital line: null shipsNowQuantity, no backorder', async () => {
    const { lines } = await estimate([{ sku: 'BO-DIGI', quantity: 1 }]);
    expect(lines[0]).toMatchObject({ available: true, availableQuantity: null, backorder: false, shipsNowQuantity: null });
  });
});

describe('checkout snapshot + order read', () => {
  const place = async (quantity: number) => {
    const res = await app.request('/v1/shop/checkout', { method: 'POST', headers: hdr(), body: JSON.stringify({
      items: [{ sku: SKU, quantity }], email: 'buyer@example.com', shippingMethodCode: 'standard', shippingAddress: { country: 'US' } }) });
    return { res, body: (await res.json()) as { code: string } };
  };
  const lineMeta = async (code: string) => withStore(STORE, async (tx) =>
    (await tx.execute(sql`SELECT ol.metadata, o.receipt_token FROM order_line ol JOIN "order" o ON o.id = ol.order_id WHERE o.code = ${code}`)).rows[0] as { metadata: unknown; receipt_token: string });

  it('a line within warehouse stock keeps null metadata', async () => {
    const { res, body } = await place(2);
    expect(res.status).toBe(200);
    expect((await lineMeta(body.code)).metadata).toBeNull();
  });
  it('a backorder line snapshots backorder + shipLabel; later variant edits do not change it; order read exposes both', async () => {
    const { res, body } = await place(3);
    expect(res.status).toBe(200);
    expect(await stockRow()).toMatchObject({ allocated: 3 });
    const row = await lineMeta(body.code);
    expect(row.metadata).toEqual({ backorder: true, shipLabel: LABEL });
    await withStore(STORE, (tx) => tx.execute(sql`UPDATE product_variant SET backorder_label = 'Ships in 9 weeks' WHERE id = ${V}`));
    const read = await app.request(`/v1/shop/orders/${body.code}?rt=${row.receipt_token}`, { headers: hdr() });
    expect(read.status).toBe(200);
    const order = (await read.json()) as { hasBackorder: boolean; lines: Array<Record<string, unknown>> };
    expect(order.hasBackorder).toBe(true);
    expect(order.lines[0]).toMatchObject({ backorder: true, shipLabel: LABEL });
  });
  it('backorderSkus acknowledgement: stock sold out between estimate and place-order -> 409 BACKORDER_CHANGED, nothing allocated', async () => {
    const orderCount = async () => withStore(STORE, async (tx) => Number(((await tx.execute(sql`SELECT count(*)::int AS n FROM "order" WHERE store_id = ${STORE}`)).rows[0] as { n: number }).n));
    const attempts = async () => withStore(STORE, async (tx) => Number(((await tx.execute(sql`SELECT count(*)::int AS n FROM payment_attempt WHERE store_id = ${STORE}`)).rows[0] as { n: number }).n));
    // estimate time: 2 on hand, 1 wanted -> ships now, the shopper saw no notice; then the warehouse stock is sold elsewhere
    await setStock(2, 5, 2);
    const res = await app.request('/v1/shop/checkout', { method: 'POST', headers: hdr(), body: JSON.stringify({
      items: [{ sku: SKU, quantity: 1 }], email: 'buyer@example.com', shippingMethodCode: 'standard', shippingAddress: { country: 'US' }, backorderSkus: [] }) });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: 'BACKORDER_CHANGED' }, skus: [SKU] });
    expect(await stockRow()).toMatchObject({ allocated: 2 });
    expect(await orderCount()).toBe(0);
    expect(await attempts()).toBe(0);
    expect(vi.mocked(onStockChanged)).not.toHaveBeenCalled();
  });
  it('backorderSkus acknowledgement: acknowledged backorder places the order with the snapshot; absent field behaves as before; listed-but-not-backorder is fine', async () => {
    await setStock(2, 5, 2);
    const body = (extra: Record<string, unknown>) => JSON.stringify({ items: [{ sku: SKU, quantity: 1 }], email: 'buyer@example.com', shippingMethodCode: 'standard', shippingAddress: { country: 'US' }, ...extra });
    const ack = await app.request('/v1/shop/checkout', { method: 'POST', headers: hdr(), body: body({ backorderSkus: [SKU] }) });
    expect(ack.status).toBe(200);
    expect((await lineMeta(((await ack.json()) as { code: string }).code)).metadata).toEqual({ backorder: true, shipLabel: LABEL });
    const legacy = await app.request('/v1/shop/checkout', { method: 'POST', headers: hdr(), body: body({}) });
    expect(legacy.status).toBe(200);
    await setStock(2, 5, 0);
    const sooner = await app.request('/v1/shop/checkout', { method: 'POST', headers: hdr(), body: body({ backorderSkus: [SKU] }) });
    expect(sooner.status).toBe(200);
    expect(await stockRow()).toMatchObject({ allocated: 1 });
  });
  it('beyond sellable is refused and reserves nothing', async () => {
    const { res } = await place(8);
    expect(res.status).toBe(409);
    expect(await stockRow()).toMatchObject({ allocated: 0 });
  });
  it('an order with no backorder line reports hasBackorder false', async () => {
    const { body } = await place(1);
    const row = await lineMeta(body.code);
    const order = (await (await app.request(`/v1/shop/orders/${body.code}?rt=${row.receipt_token}`, { headers: hdr() })).json()) as { hasBackorder: boolean; lines: Array<Record<string, unknown>> };
    expect(order.hasBackorder).toBe(false);
    expect(order.lines[0]).toMatchObject({ backorder: false, shipLabel: null });
  });
});

describe('admin incoming, label and receive', () => {
  const patchIncoming = (body: Record<string, unknown>, id = V) => app.request(`/v1/admin/variants/${id}/incoming`, { method: 'PATCH', headers: adminHdr(), body: JSON.stringify(body) });
  const receive = (quantity: number) => app.request(`/v1/admin/variants/${V}/stock/receive`, { method: 'POST', headers: adminHdr(), body: JSON.stringify({ quantity }) });

  it('reads incoming, backorderLabel, available (sellable) and shipsNow on product detail', async () => {
    const res = await app.request(`/v1/admin/products/${PRODUCT}`, { headers: adminHdr() });
    const v = ((await res.json()) as { variants: Array<Record<string, unknown>> }).variants.find((x) => x.sku === SKU)!;
    expect(v).toMatchObject({ onHand: 2, incoming: 5, allocated: 0, available: 7, shipsNow: 2, backorderLabel: LABEL });
  });
  it('rejects incoming > 0 without a non-empty label', async () => {
    await withStore(STORE, (tx) => tx.execute(sql`UPDATE product_variant SET backorder_label = NULL WHERE id = ${V}`));
    expect((await patchIncoming({ incoming: 4 })).status).toBe(400);
    expect((await patchIncoming({ incoming: 4, backorderLabel: '   ' })).status).toBe(400);
    expect((await stockRow()).incoming).toBe(5);
    expect((await patchIncoming({ incoming: 4, backorderLabel: ' Ships Friday ' })).status).toBe(200);
    const v = await withStore(STORE, async (tx) => (await tx.execute(sql`SELECT backorder_label FROM product_variant WHERE id = ${V}`)).rows[0] as { backorder_label: string });
    expect(v.backorder_label).toBe('Ships Friday');
    expect(onStockChanged).toHaveBeenCalledWith(SLUG, [V]);
  });
  it('rejects incoming below the quantity already sold on backorder; accepts it at the floor', async () => {
    await setStock(2, 5, 6); // 4 units sold on backorder
    const low = await patchIncoming({ incoming: 3 });
    expect(low.status).toBe(400);
    expect(((await low.json()) as { error: { code: string } }).error.code).toBe('INCOMING_BELOW_SOLD');
    expect((await stockRow()).incoming).toBe(5);
    expect((await patchIncoming({ incoming: 4 })).status).toBe(200);
  });
  it('the generic variant PATCH cannot clear the label while incoming > 0', async () => {
    const res = await app.request(`/v1/admin/variants/${V}`, { method: 'PATCH', headers: adminHdr(), body: JSON.stringify({ backorderLabel: null }) });
    expect(res.status).toBe(400);
    await setStock(2, 0, 0);
    expect((await app.request(`/v1/admin/variants/${V}`, { method: 'PATCH', headers: adminHdr(), body: JSON.stringify({ backorderLabel: null }) })).status).toBe(200);
  });
  it('variant create takes incoming + label, and rejects incoming without a label', async () => {
    const bad = await app.request(`/v1/admin/products/${PRODUCT}/variants`, { method: 'POST', headers: adminHdr(), body: JSON.stringify({ sku: 'BO-NEW', name: 'New', price: 100, incoming: 3 }) });
    expect(bad.status).toBe(400);
    const ok = await app.request(`/v1/admin/products/${PRODUCT}/variants`, { method: 'POST', headers: adminHdr(), body: JSON.stringify({ sku: 'BO-NEW', name: 'New', price: 100, incoming: 3, backorderLabel: 'Soon' }) });
    expect(ok.status).toBe(200);
    const id = ((await ok.json()) as { id: string }).id;
    expect(await stockRow(id)).toMatchObject({ incoming: 3, on_hand: 0 });
  });
  it('receive moves n from incoming to on_hand in one step with a movement row and the post-commit stock hook', async () => {
    const res = await receive(3);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ onHand: 5, incoming: 2 });
    expect(await stockRow()).toMatchObject({ on_hand: 5, incoming: 2, allocated: 0 });
    const mv = await withStore(STORE, async (tx) => (await tx.execute(sql`SELECT delta, reason FROM stock_movement WHERE variant_id = ${V}`)).rows);
    expect(mv).toEqual([{ delta: 3, reason: 'receive_incoming' }]);
    expect(onStockChanged).toHaveBeenCalledWith(SLUG, [V]);
  });
  it('receive refuses more than is incoming and changes nothing', async () => {
    const res = await receive(6);
    expect(res.status).toBe(409);
    expect(await stockRow()).toMatchObject({ on_hand: 2, incoming: 5 });
    expect(onStockChanged).not.toHaveBeenCalled();
  });
  it('receive keeps sellable unchanged', async () => {
    await setStock(2, 5, 4);
    await receive(5);
    const r = await stockRow();
    expect(r.on_hand + r.incoming - r.allocated).toBe(3);
  });
});

describe('fulfilment refuses to ship more than on_hand', () => {
  const CODE = 'BO-FUL-1';
  async function seedOrder(qty: number) {
    await withStore(STORE, async (tx) => {
      const o = await tx.execute(sql`INSERT INTO "order" (store_id, code, state, currency, grand_total, metadata)
        VALUES (${STORE}, ${CODE}, 'Paid', 'USD', ${qty * 1000}, '{"contact":{"email":"guest@backorder.test"}}'::jsonb) RETURNING id`);
      const oid = (o.rows[0] as { id: string }).id;
      await tx.execute(sql`INSERT INTO order_line (store_id, order_id, variant_id, variant_sku, variant_name, quantity, unit_price, line_subtotal, line_total, metadata)
        VALUES (${STORE}, ${oid}, ${V}, ${SKU}, 'Backorder Variant', ${qty}, 1000, ${qty * 1000}, ${qty * 1000}, '{"backorder":true,"shipLabel":"Ships in 3 weeks"}'::jsonb)`);
    });
  }
  const fulfill = () => app.request(`/v1/admin/orders/${CODE}/fulfill`, { method: 'POST', headers: adminHdr(), body: JSON.stringify({ state: 'Shipped' }) });

  it('409 naming the SKU, nothing shipped, then ships after the stock is received', async () => {
    await seedOrder(4);
    await setStock(2, 5, 4);
    const res = await fulfill();
    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).toContain(SKU);
    expect(await stockRow()).toMatchObject({ on_hand: 2, allocated: 4 });
    const state = await withStore(STORE, async (tx) => (await tx.execute(sql`SELECT (SELECT state FROM "order" WHERE code = ${CODE}) AS state, (SELECT count(*)::int FROM fulfillment WHERE store_id = ${STORE}) AS f, (SELECT fulfilled_qty FROM order_line WHERE store_id = ${STORE}) AS q`)).rows[0]);
    expect(state).toMatchObject({ state: 'Paid', f: 0, q: 0 });
    expect((await app.request(`/v1/admin/variants/${V}/stock/receive`, { method: 'POST', headers: adminHdr(), body: JSON.stringify({ quantity: 2 }) })).status).toBe(200);
    expect((await fulfill()).status).toBe(200);
    expect(await stockRow()).toMatchObject({ on_hand: 0, incoming: 3, allocated: 0 });
  });
  it('shipping within on_hand is unchanged', async () => {
    await seedOrder(2);
    await setStock(5, 0, 2);
    expect((await fulfill()).status).toBe(200);
    expect(await stockRow()).toMatchObject({ on_hand: 3, allocated: 0 });
  });
});

describe('confirmation email', () => {
  it('backorder lines carry the label and the order carries one ships-together sentence', async () => {
    const oid = await withStore(STORE, async (tx) => {
      const o = await tx.execute(sql`INSERT INTO "order" (store_id, code, state, currency, grand_total, metadata)
        VALUES (${STORE}, 'BO-MAIL-1', 'Paid', 'USD', 4000, '{"contact":{"email":"buyer@backorder.test"}}'::jsonb) RETURNING id`);
      const id = (o.rows[0] as { id: string }).id;
      await tx.execute(sql`INSERT INTO order_line (store_id, order_id, variant_id, variant_sku, variant_name, quantity, unit_price, line_subtotal, line_total, metadata)
        VALUES (${STORE}, ${id}, ${V}, ${SKU}, 'Backorder Variant', 3, 1000, 3000, 3000, '{"backorder":true,"shipLabel":"Ships in 3 weeks"}'::jsonb),
               (${STORE}, ${id}, ${V_DIGITAL}, 'BO-DIGI', 'Digital', 1, 1000, 1000, 1000, NULL)`);
      await sendOrderConfirmationAndEnrol(tx, STORE, id);
      return id;
    });
    expect(oid).toBeTruthy();
    const mail = await withStore(STORE, async (tx) => (await tx.execute(sql`SELECT payload FROM email_outbox WHERE store_id = ${STORE} AND kind = 'order_confirmation'`)).rows[0] as { payload: { html: string; text: string } });
    expect(mail.payload.html).toContain('Ships in 3 weeks');
    expect(mail.payload.html.match(/Your whole order ships together when these items arrive\./g)).toHaveLength(1);
    // fixture names contain "Backorder"; the customer-facing copy must not (no prefix, no "backordered")
    for (const out of [mail.payload.html, mail.payload.text]) { expect(out).not.toMatch(/backordered/i); expect(out).not.toMatch(/Backorder:/i); }
    expect(mail.payload.text).toContain('Ships in 3 weeks');
  });
});

describe('feeds and JSON-LD availability', () => {
  const feed = async () => (await app.request('/v1/shop/feeds/google', { headers: hdr() })).text();
  // the digital fixture variant is always sellable and ships now, which would mask the product-level rule
  beforeEach(async () => { await withStore(STORE, (tx) => tx.execute(sql`DELETE FROM product_variant WHERE id = ${V_DIGITAL}`)); });
  const jsonld = async () => JSON.stringify(await (await app.request('/v1/shop/seo/jsonld/products/bo-prod', { headers: hdr() })).json());

  it('in stock while warehouse stock remains', async () => {
    expect(await feed()).toContain('in stock');
    expect(await jsonld()).toContain('InStock');
  });
  it('BackOrder when nothing ships now but incoming remains', async () => {
    await setStock(2, 5, 2);
    const csv = await feed();
    expect(csv).toContain(',backorder,');
    expect(await jsonld()).toContain('BackOrder');
  });
  it('OutOfStock once incoming is used up', async () => {
    await setStock(2, 5, 7);
    expect(await jsonld()).toContain('OutOfStock');
    expect(await feed()).not.toContain(',backorder,');
  });
  it('a product with another variant that ships now stays InStock', async () => {
    await withStore(STORE, async (tx) => {
      await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price) VALUES ('b0446000-0000-4000-8000-0000000000b9', ${STORE}, ${PRODUCT}, 'BO-SHIPS', 'Ships now', 900)`);
      await tx.execute(sql`INSERT INTO stock (variant_id, store_id, on_hand, allocated) VALUES ('b0446000-0000-4000-8000-0000000000b9', ${STORE}, 4, 0)`);
    });
    await setStock(2, 5, 2);
    const out = await jsonld();
    expect(out).toContain('InStock');
    expect(out).not.toContain('BackOrder');
  });
});

describe('restock and waitlist', () => {
  let ip = 0;
  const subscribe = (variantId: string) => app.request('/v1/shop/restock-request', { method: 'POST',
    headers: { ...hdr(), 'x-real-ip': `198.51.102.${++ip}` }, body: JSON.stringify({ variantId, email: 'wait@example.com' }) });
  const requests = async () => withStore(STORE, async (tx) => (await tx.execute(sql`SELECT variant_id FROM restock_request WHERE store_id = ${STORE}`)).rows);

  it('a variant is not out of stock while sellable > 0 (incoming only): no waitlist row', async () => {
    await setStock(0, 5, 0);
    expect((await subscribe(V)).status).toBe(200);
    expect(await requests()).toHaveLength(0);
  });
  it('a sold-out variant (incoming used up) still takes a waitlist row', async () => {
    await setStock(0, 5, 5);
    expect((await subscribe(V)).status).toBe(200);
    expect(await requests()).toHaveLength(1);
  });
  it('adding incoming to a sold-out variant raises a restock event; a receive does not', async () => {
    await setStock(0, 0, 0);
    await withStore(STORE, (tx) => tx.execute(sql`UPDATE stock SET incoming = 5 WHERE variant_id = ${V}`));
    const events = async () => withStore(STORE, async (tx) => (await tx.execute(sql`SELECT count(*)::int AS n FROM restock_event WHERE store_id = ${STORE}`)).rows[0] as { n: number });
    expect((await events()).n).toBe(1);
    await sweepRestockEvents();
    await withStore(STORE, (tx) => tx.execute(sql`UPDATE stock SET on_hand = on_hand + 2, incoming = incoming - 2 WHERE variant_id = ${V}`));
    expect((await events()).n).toBe(1); // still just the swept one: no new unprocessed event
  });
});

describe('order edit variant picker', () => {
  it('reports sellable (on_hand + incoming - allocated) as available', async () => {
    const rows = await searchEditVariants(STORE, 'BO-1');
    expect(rows.find((r) => r.sku === SKU)).toMatchObject({ available: 7 });
  });
});

describe('fulfilment: count drift without incoming keeps the legacy clamp', () => {
  it('allocated > on_hand and incoming = 0 still ships (clamped), no 409', async () => {
    await withStore(STORE, async (tx) => {
      const o = await tx.execute(sql`INSERT INTO "order" (store_id, code, state, currency, grand_total, metadata)
        VALUES (${STORE}, 'BO-DRIFT', 'Paid', 'USD', 2000, '{"contact":{"email":"guest@backorder.test"}}'::jsonb) RETURNING id`);
      await tx.execute(sql`INSERT INTO order_line (store_id, order_id, variant_id, variant_sku, variant_name, quantity, unit_price, line_subtotal, line_total)
        VALUES (${STORE}, ${(o.rows[0] as { id: string }).id}, ${V}, ${SKU}, 'Backorder Variant', 2, 1000, 2000, 2000)`);
    });
    await setStock(0, 0, 2);
    const res = await app.request('/v1/admin/orders/BO-DRIFT/fulfill', { method: 'POST', headers: adminHdr(), body: JSON.stringify({ state: 'Shipped' }) });
    expect(res.status).toBe(200);
    expect(await stockRow()).toMatchObject({ on_hand: 0, incoming: 0, allocated: 0 });
  });
});

describe('on_hand reducers warn (never reject) when backorder is left oversold', () => {
  const patchOnHand = (onHand: number) => app.request(`/v1/admin/variants/${V}/stock`, { method: 'PATCH', headers: adminHdr(), body: JSON.stringify({ onHand }) });
  it('PATCH stock: warning only when incoming > 0 and sold backorder exceeds it', async () => {
    await setStock(2, 5, 6);
    const res = await patchOnHand(0); // sold backorder 6 > incoming 5
    expect(res.status).toBe(200);
    expect(((await res.json()) as { warning?: string }).warning).toMatch(/6 units are sold on backorder but only 5 are incoming/);
    await setStock(2, 5, 6);
    expect(await (await patchOnHand(1)).json()).not.toHaveProperty('warning'); // 5 <= 5
    await setStock(2, 0, 6);
    expect(await (await patchOnHand(0)).json()).not.toHaveProperty('warning'); // incoming 0: legacy behaviour
  });
  it('adjust and bulk carry the same warning', async () => {
    await setStock(2, 5, 6);
    const adj = await app.request(`/v1/admin/variants/${V}/stock/adjust`, { method: 'POST', headers: adminHdr(), body: JSON.stringify({ delta: -2, reason: 'recount' }) });
    expect(adj.status).toBe(200);
    expect(await adj.json()).toHaveProperty('warning');
    await setStock(2, 5, 6);
    const bulk = await app.request('/v1/admin/variants/stock/bulk', { method: 'PATCH', headers: adminHdr(), body: JSON.stringify({ items: [{ id: V, onHand: 0 }] }) });
    expect(bulk.status).toBe(200);
    expect(((await bulk.json()) as { updated: Array<{ warning?: string }> }).updated[0]!.warning).toBeTruthy();
  });
});

describe('/v1/shop/track', () => {
  it('exposes hasBackorder and per-line backorder + shipLabel', async () => {
    await withStore(STORE, async (tx) => {
      const o = await tx.execute(sql`INSERT INTO "order" (store_id, code, state, currency, grand_total, metadata)
        VALUES (${STORE}, 'BO-TRACK', 'Paid', 'USD', 3000, '{"contact":{"email":"track@backorder.test"}}'::jsonb) RETURNING id`);
      await tx.execute(sql`INSERT INTO order_line (store_id, order_id, variant_id, variant_sku, variant_name, quantity, unit_price, line_subtotal, line_total, metadata)
        VALUES (${STORE}, ${(o.rows[0] as { id: string }).id}, ${V}, ${SKU}, 'Backorder Variant', 3, 1000, 3000, 3000, '{"backorder":true,"shipLabel":"Ships in 3 weeks"}'::jsonb)`);
    });
    const res = await app.request('/v1/shop/track?code=BO-TRACK&email=track@backorder.test', { headers: { ...hdr(), 'x-real-ip': '198.51.103.9' } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hasBackorder: boolean; lines: Array<Record<string, unknown>> };
    expect(body.hasBackorder).toBe(true);
    expect(body.lines[0]).toMatchObject({ backorder: true, shipLabel: LABEL });
  });
});

describe('order edit adds backorder units', () => {
  const CODE = 'BO-EDIT-1';
  async function seedPaid() {
    await withStore(STORE, async (tx) => {
      const o = await tx.execute(sql`INSERT INTO "order" (store_id, code, state, currency, subtotal, shipping_total, grand_total, shipping_address, metadata)
        VALUES (${STORE}, ${CODE}, 'Paid', 'USD', 2000, 0, 2000, '{"line1":"1 A St","city":"Austin","country":"US"}'::jsonb, '{"contact":{"email":"c@backorder.test"}}'::jsonb) RETURNING id`);
      const oid = (o.rows[0] as { id: string }).id;
      await tx.execute(sql`INSERT INTO order_line (store_id, order_id, variant_id, variant_sku, variant_name, quantity, unit_price, line_subtotal, line_total)
        VALUES (${STORE}, ${oid}, ${V}, ${SKU}, 'Backorder Variant', 2, 1000, 2000, 2000)`);
      await tx.execute(sql`INSERT INTO payment (store_id, order_id, amount, method, state, provider_ref, gateway_mode, currency) VALUES (${STORE}, ${oid}, 2000, 'stripe', 'Settled', 'pi_bo', 'test', 'USD')`);
    });
  }
  const edit = async (ops: unknown[], grand: number, key: string) => {
    const prev = await app.request(`/v1/admin/orders/${CODE}/edit/preview`, { method: 'POST', headers: adminHdr(), body: JSON.stringify({ ops }) });
    expect(prev.status).toBe(200);
    const { previewAcceptanceHash } = (await prev.json()) as { previewAcceptanceHash: string };
    return app.request(`/v1/admin/orders/${CODE}/edit/commit`, { method: 'POST', headers: adminHdr(), body: JSON.stringify({ ops, previewAcceptanceHash, expectedGrandTotal: grand, idempotencyKey: key, settlement: { type: 'leave_due' }, notifyCustomer: false }) });
  };
  const lineMetas = async () => withStore(STORE, async (tx) => (await tx.execute(sql`SELECT metadata, quantity FROM order_line WHERE order_id = (SELECT id FROM "order" WHERE code = ${CODE}) ORDER BY quantity DESC`)).rows as Array<{ metadata: Record<string, unknown> | null; quantity: number }>);

  it('units within warehouse stock add no snapshot', async () => {
    await seedPaid();
    await setStock(10, 5, 2);
    expect((await edit([{ op: 'add_item', sku: SKU, quantity: 1 }], 3000, 'bo-edit-0')).status).toBe(200);
    expect((await lineMetas()).every((l) => l.metadata == null)).toBe(true);
  });
  it('added units that need incoming stock set metadata.backorder + shipLabel; later removal never clears it', async () => {
    await seedPaid();
    await setStock(2, 5, 2); // warehouse stock fully allocated: any added unit is a backorder unit
    const res = await edit([{ op: 'add_item', sku: SKU, quantity: 1 }], 3000, 'bo-edit-1');
    expect(res.status).toBe(200);
    expect(await stockRow()).toMatchObject({ allocated: 3 });
    const metas = await lineMetas();
    expect(metas.some((l) => l.metadata && l.metadata.backorder === true && l.metadata.shipLabel === LABEL)).toBe(true);
    const flagged = metas.find((l) => l.metadata?.backorder === true)!;
    const rows = await withStore(STORE, async (tx) => (await tx.execute(sql`SELECT id, quantity FROM order_line WHERE order_id = (SELECT id FROM "order" WHERE code = ${CODE}) AND metadata IS NOT NULL`)).rows as Array<{ id: string; quantity: number }>);
    expect(rows).toHaveLength(1);
    const down = await edit([{ op: 'set_quantity', lineId: rows[0]!.id, quantity: flagged.quantity - 1 }], 2000, 'bo-edit-2');
    expect(down.status).toBe(200);
    const after = await lineMetas();
    expect(after.some((l) => l.metadata?.backorder === true)).toBe(true);
  });
});

describe('admin order reads expose backorder', () => {
  async function seedTwo() {
    await withStore(STORE, async (tx) => {
      for (const [code, meta] of [['BO-ADM-Y', '{"backorder":true,"shipLabel":"Ships in 3 weeks"}'], ['BO-ADM-N', null]] as const) {
        const o = await tx.execute(sql`INSERT INTO "order" (store_id, code, state, currency, grand_total, metadata) VALUES (${STORE}, ${code}, 'Paid', 'USD', 1000, '{}'::jsonb) RETURNING id`);
        await tx.execute(sql`INSERT INTO order_line (store_id, order_id, variant_id, variant_sku, variant_name, quantity, unit_price, line_subtotal, line_total, metadata)
          VALUES (${STORE}, ${(o.rows[0] as { id: string }).id}, ${V}, ${SKU}, 'Backorder Variant', 1, 1000, 1000, 1000, ${meta}::jsonb)`);
      }
    });
  }
  it('detail: lines[].backorder/shipLabel and order.hasBackorder', async () => {
    await seedTwo();
    const y = (await (await app.request('/v1/admin/orders/BO-ADM-Y', { headers: adminHdr() })).json()) as { hasBackorder: boolean; lines: Array<Record<string, unknown>> };
    expect(y.hasBackorder).toBe(true);
    expect(y.lines[0]).toMatchObject({ backorder: true, shipLabel: LABEL });
    const n = (await (await app.request('/v1/admin/orders/BO-ADM-N', { headers: adminHdr() })).json()) as { hasBackorder: boolean; lines: Array<Record<string, unknown>> };
    expect(n.hasBackorder).toBe(false);
    expect(n.lines[0]).toMatchObject({ backorder: false, shipLabel: null });
  });
  it('list: rows[].hasBackorder from the same statement', async () => {
    await seedTwo();
    const list = (await (await app.request('/v1/admin/orders', { headers: adminHdr() })).json()) as { items: Array<{ code: string; hasBackorder: boolean }> };
    expect(Object.fromEntries(list.items.map((r) => [r.code, r.hasBackorder]))).toMatchObject({ 'BO-ADM-Y': true, 'BO-ADM-N': false });
  });
});
