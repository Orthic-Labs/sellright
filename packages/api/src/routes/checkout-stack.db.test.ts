/** Synthetic disposable DB fixtures; root integration owns execution. */
import { beforeEach, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { createHash, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { requireDisposablePostgresUrl } from '../db/test-database-url.js';
import * as s from '../db/schema.js';
import { issue } from '../account-credit/service.js';
import { clearLoginAttempts } from '../auth/rate-limit.js';
import { recordSettlementOperation } from '../payments/settlement/record.js';
import { settleOrderReleases } from '../payments/reservation.js';
import { commitOrderEdit, loadEditContext, previewOrderEdit } from '../orders/order-edit-service.js';
import { checkout } from './checkout.js';
import { cart } from './cart.js';

requireDisposablePostgresUrl(process.env.DATABASE_URL ?? env.DATABASE_URL, 'checkout-stack.db.test.ts');
const STORE = 'cccccccc-ccdd-4000-8000-000000000001';
const PRODUCT = 'cccccccc-ccdd-4000-8000-000000000002';
const VARIANT = 'cccccccc-ccdd-4000-8000-000000000003';
const SLUG = 'synthetic-stack-checkout';
const SKU = 'STACK-SYNTHETIC';
const app = new OpenAPIHono(); app.route('/', checkout); app.route('/', cart);
const headers = { 'content-type': 'application/json', 'x-store-slug': SLUG };
const codes = ['ORDINARY', 'CREDIT'];
beforeEach(async () => {
  clearLoginAttempts('unknown', 'checkout:unknown');
  await pool.query('TRUNCATE store CASCADE');
  await withStore(STORE, async tx => {
    await tx.insert(s.store).values({ id: STORE, slug: SLUG, name: 'Synthetic stack', currency: 'USD' });
    await tx.insert(s.product).values({ id: PRODUCT, storeId: STORE, slug: 'synthetic-stack', name: 'Synthetic', status: 'active' });
    await tx.insert(s.productVariant).values({ id: VARIANT, storeId: STORE, productId: PRODUCT, sku: SKU, name: 'Synthetic', price: 1000, fulfillmentType: 'physical' });
    await tx.insert(s.stock).values({ variantId: VARIANT, storeId: STORE, onHand: 10, allocated: 0 });
    await tx.insert(s.shippingMethod).values({ storeId: STORE, code: 'standard', name: 'Standard', calculator: { flat: 100 } });
    await tx.insert(s.promotion).values({ storeId: STORE, code: 'ORDINARY', type: 'percentage', value: 10, stackOrder: 10, discountScope: 'line' });
    await issue(tx, { storeId: STORE, email: 'private-issuance@example.invalid', issuanceKey: 'fixture', code: 'CREDIT', amount: 101 });
  });
});
async function cartQuote() {
  const created = await app.request('/v1/shop/cart', { method: 'POST', headers, body: JSON.stringify({ items: [{ sku: SKU, quantity: 3 }], couponCodes: codes }) });
  const saved = await created.json() as { token: string; revision: number };
  const query = new URLSearchParams({ couponCodes: JSON.stringify(codes), shippingMethodCode: 'standard', shipCountry: 'US', pricingIntent: 'checkout' });
  const response = await app.request(`/v1/shop/cart/${saved.token}?${query}`, { headers });
  expect(response.status).toBe(200);
  return { saved, quote: await response.json() as { quoteHash: string; grandTotal: number } };
}
function place(token: string, revision: number, acceptedQuoteHash?: string) {
  return app.request('/v1/shop/checkout', { method: 'POST', headers, body: JSON.stringify({ items: [{ sku: SKU, quantity: 3 }],
    cartToken: token, expectedRevision: revision, couponCodes: codes, acceptedQuoteHash, shippingMethodCode: 'standard', shippingAddress: { country: 'US' } }) });
}

describe('accepted ordered credit checkout', () => {
  it('keeps legacy single-coupon checkout fingerprint bytes unchanged when new fields are absent', async () => {
    const response = await app.request('/v1/shop/checkout', { method: 'POST', headers, body: JSON.stringify({
      items: [{ sku: SKU, quantity: 3 }], couponCode: 'ORDINARY', shippingMethodCode: 'standard',
    }) });
    expect(response.status).toBe(200);
    const legacyHash = createHash('sha256').update(JSON.stringify({ v: 1, cartToken: null, items: [{ sku: SKU, quantity: 3 }],
      couponCode: 'ORDINARY', giftCardCode: null, shippingMethodCode: 'standard', email: null,
      shippingAddress: null, billingAddress: null, legalAcceptance: null })).digest('hex');
    await withStore(STORE, async tx => expect((await tx.select().from(s.order))[0]?.metadata).toMatchObject({ checkoutFingerprint: legacyHash }));
  });

  it('rolls back stale quote order, stock, hold, usage & cart conversion before reconfirmation', async () => {
    const { saved, quote } = await cartQuote();
    await withStore(STORE, tx => tx.update(s.productVariant).set({ price: 1100 }).where(eq(s.productVariant.id, VARIANT)));
    const stale = await place(saved.token, saved.revision, quote.quoteHash);
    expect(stale.status).toBe(409);
    const changed = await stale.json() as { error: { code: string }; quote: { quoteHash: string; pricingIntent: string }; quoteHash: string };
    expect(changed.error.code).toBe('QUOTE_CHANGED'); expect(changed.quote.pricingIntent).toBe('checkout');
    expect(changed.quoteHash).toBe(changed.quote.quoteHash); expect(changed.quoteHash).not.toBe(quote.quoteHash);
    await withStore(STORE, async tx => {
      expect(await tx.select().from(s.order)).toHaveLength(0);
      expect(await tx.select().from(s.promotionUsage)).toHaveLength(0);
      expect(await tx.select().from(s.payment)).toHaveLength(0);
      expect((await tx.select().from(s.stock))[0]?.allocated).toBe(0);
      expect((await tx.select().from(s.cart))[0]).toMatchObject({ status: 'active', revision: saved.revision });
      expect((await tx.select().from(s.accountCreditTransaction)).filter(row => row.kind === 'RESERVE')).toHaveLength(0);
    });
    expect((await place(saved.token, saved.revision, changed.quoteHash)).status).toBe(200);
  });
  it.each(['send_pay_link', 'leave_due', 'record_payment'] as const)('requires credit acceptance, debits once & redacts %s edit context', async settlementType => {
    const { saved, quote } = await cartQuote();
    expect((await place(saved.token, saved.revision)).status).toBe(409);
    const response = await place(saved.token, saved.revision, quote.quoteHash); expect(response.status).toBe(200);
    const placed = await response.json() as { code: string; grandTotal: number };
    await withStore(STORE, async tx => {
      const [order] = await tx.select().from(s.order).where(eq(s.order.code, placed.code));
      expect(order?.couponCodes).toEqual(codes); expect(order?.pricingSnapshot).not.toBeNull();
      expect(await tx.select().from(s.promotionUsage)).toHaveLength(2);
      expect((await tx.select().from(s.accountCredit))[0]?.balance).toBe(101);
      const paymentId = randomUUID();
      const operation = { storeId: STORE, kind: 'payment_settled' as const, operationId: paymentId, orderId: order!.id,
        mutations: [{ type: 'payment_insert' as const, rows: [{ id: paymentId, storeId: STORE, orderId: order!.id, amount: placed.grandTotal, method: 'synthetic', state: 'Settled' as const }] }], effects: [] };
      expect((await recordSettlementOperation(tx, operation)).creditReconciliation).toBeUndefined();
      expect((await tx.select().from(s.accountCredit))[0]?.balance).toBe(101);
      // Capture & first-paid transition have separate business identities, as in settle().
      const paid = { storeId: STORE, kind: 'order_paid_transition' as const, operationId: order!.id, orderId: order!.id,
        mutations: [{ type: 'order_paid' as const, orderId: order!.id, placedAt: new Date() }], effects: [] };
      expect((await recordSettlementOperation(tx, paid)).creditReconciliation).toBeUndefined();
      expect((await recordSettlementOperation(tx, operation)).replayed).toBe(true);
      expect((await recordSettlementOperation(tx, paid)).replayed).toBe(true);
      expect((await tx.select().from(s.order).where(eq(s.order.id, order!.id)))[0]?.state).toBe('Paid');
      expect(await tx.select().from(s.payment)).toHaveLength(1);
      expect((await tx.select().from(s.accountCredit))[0]?.balance).toBe(0);
      const redeems = (await tx.select().from(s.accountCreditTransaction)).filter(row => row.kind === 'REDEEM');
      expect(redeems).toHaveLength(1);
      expect(Object.values(redeems[0]!.operationalAllocation ?? {}).flat().reduce((a, b) => a + b, 0)).toBe(101);
    });
    expect((await loadEditContext(STORE, placed.code)).editable).toMatchObject({ items: true, addressOnly: false, address: true });
    const preview = await previewOrderEdit(STORE, placed.code, []);
    expect(preview.after.grandTotal).toBe(placed.grandTotal);
    expect(preview.couponCodes).toEqual(['ORDINARY']); // reusable credit bearer stays out of preview wire data
    await withStore(STORE, async tx => {
      expect((await tx.select().from(s.order))[0]?.couponCodes).toEqual(codes);
      expect((await tx.select().from(s.accountCredit))[0]?.balance).toBe(0);
      expect((await tx.select().from(s.accountCreditTransaction)).filter(row => row.kind === 'RESTORE')).toHaveLength(0);
      expect(await tx.select().from(s.orderEdit)).toHaveLength(0);
    });
    const ops = [{ op: 'add_item' as const, sku: SKU, quantity: 1 }];
    const addition = await previewOrderEdit(STORE, placed.code, ops);
    expect(addition.balance.amountDue).toBe(900);
    const input = { storeId: STORE, storeSlug: SLUG, code: placed.code, actor: 'fixture', principalKind: 'human' as const,
      ops, expectedGrandTotal: addition.after.grandTotal, expectedBalance: addition.balance.amountDue,
      previewAcceptanceHash: addition.previewAcceptanceHash, idempotencyKey: `private-context-${settlementType}`,
      settlement: settlementType === 'record_payment' ? { type: settlementType, method: 'cash' } : { type: settlementType }, notifyCustomer: false };
    const prepared = await commitOrderEdit(input);
    if (settlementType === 'record_payment') {
      expect(prepared.settlement.phase).toBe('activated');
      expect((await commitOrderEdit(input)).replay).toBe(true);
      expect((await loadEditContext(STORE, placed.code)).pendingEdit).toBeNull();
      await withStore(STORE, async tx => {
        expect((await tx.select().from(s.order))[0]).toMatchObject({ grandTotal: addition.after.grandTotal, couponCodes: codes });
        expect((await tx.select().from(s.payment)).filter(row => row.method === 'manual')).toHaveLength(1);
        expect((await tx.select().from(s.accountCredit))[0]?.balance).toBe(0);
        expect((await tx.select().from(s.accountCreditTransaction)).filter(row => row.kind === 'RESTORE')).toHaveLength(0);
        expect((await tx.select().from(s.accountCreditTransaction)).filter(row => row.kind === 'REDEEM')).toHaveLength(1);
      });
      return;
    }
    expect(prepared.settlement.phase).toBe('awaiting_tender');
    const storedEdit = () => withStore(STORE, async tx => (await tx.select().from(s.orderEdit).where(eq(s.orderEdit.id, prepared.editId)))[0]!);
    const durable = await storedEdit();
    const proposal = (durable.after as { proposal: { couponCodes: string[]; proposalDigest: string; activation: unknown; pricingSnapshot: unknown } }).proposal;
    expect(proposal.couponCodes).toEqual(codes);
    expect(proposal.activation).toBeDefined(); expect(proposal.pricingSnapshot).toBeDefined();
    const context = await loadEditContext(STORE, placed.code);
    const values = (value: unknown): unknown[] => value && typeof value === 'object' ? Object.values(value).flatMap(values) : [value];
    expect(values(context)).not.toContain('CREDIT');
    expect(values(context)).not.toContain('private-issuance@example.invalid');
    expect(context.pendingEdit).toMatchObject({ id: prepared.editId, settlement: { type: settlementType, phase: 'awaiting_tender' },
      proposal: { previewAcceptanceHash: addition.previewAcceptanceHash, proposalDigest: proposal.proposalDigest,
        settlementRequirement: { type: settlementType, currency: 'USD', requiredTender: 900, requiredRefund: 0 } },
      proposed: { totals: { grandTotal: addition.after.grandTotal } } });
    expect(context.pendingEdit?.proposal).not.toHaveProperty('activation');
    expect(context.pendingEdit?.proposal).not.toHaveProperty('pricingSnapshot');
    expect(context.pendingEdit?.proposal).not.toHaveProperty('couponCodes');
    expect(context.pendingEdit?.proposed).not.toHaveProperty('proposal');
    expect(context.editable).toMatchObject({ items: false, address: false });
    expect(await storedEdit()).toEqual(durable);
  });
  it('keeps financially settled payment successful on invalid snapshot & cancellation releases a hold without policy reservations', async () => {
    const { saved, quote } = await cartQuote();
    const placed = await (await place(saved.token, saved.revision, quote.quoteHash)).json() as { code: string; grandTotal: number };
    await withStore(STORE, async tx => {
      const [order] = await tx.select().from(s.order).where(eq(s.order.code, placed.code));
      await tx.update(s.order).set({ pricingSnapshot: { version: 999 } }).where(eq(s.order.id, order!.id));
      const id = randomUUID();
      await recordSettlementOperation(tx, { storeId: STORE, kind: 'payment_settled', operationId: id, orderId: order!.id,
        mutations: [{ type: 'payment_insert', rows: [{ id, storeId: STORE, orderId: order!.id, amount: placed.grandTotal, method: 'synthetic', state: 'Settled' }] }], effects: [] });
      const result = await recordSettlementOperation(tx, { storeId: STORE, kind: 'order_paid_transition', operationId: order!.id, orderId: order!.id,
        mutations: [{ type: 'order_paid', orderId: order!.id, placedAt: new Date() }], effects: [] });
      expect(result.creditReconciliation?.errorCode).toBe('accepted_snapshot_invalid');
      expect((await tx.select().from(s.order).where(eq(s.order.id, order!.id)))[0]?.state).toBe('Paid');
      expect((await tx.select().from(s.payment))[0]?.state).toBe('Settled');
      expect((await tx.select().from(s.accountCredit))[0]?.balance).toBe(101);
      expect((await tx.select().from(s.accountCreditTransaction)).find(row => row.kind === 'RESERVE')?.status).toBe('PENDING');
    });
    // Mark provider discovery complete: cancellation release is independent of policy reservation rows.
    await withStore(STORE, async tx => { await tx.execute(sql`UPDATE "order" SET state = 'Cancelled', metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('stripeDiscovery', jsonb_build_object('checkedAt', now()::text)) WHERE code = ${placed.code}`); });
    const orderId = await withStore(STORE, async tx => (await tx.select().from(s.order).where(eq(s.order.code, placed.code)))[0]!.id);
    await settleOrderReleases(STORE, orderId);
    await withStore(STORE, async tx => expect((await tx.select().from(s.accountCreditTransaction)).find(row => row.kind === 'RESERVE')?.status).toBe('VOID'));
  });
  it('blocks legacy economic editing before effects while exposing direct address availability', async () => {
    const { saved, quote } = await cartQuote();
    const placed = await (await place(saved.token, saved.revision, quote.quoteHash)).json() as { code: string };
    const facts = () => withStore(STORE, async tx => ({
      orders: await tx.select().from(s.order), lines: await tx.select().from(s.orderLine), stock: await tx.select().from(s.stock),
      credits: await tx.select().from(s.accountCredit), funding: await tx.select().from(s.accountCreditTransaction),
      usages: await tx.select().from(s.promotionUsage), edits: await tx.select().from(s.orderEdit),
      payments: await tx.select().from(s.payment), effects: await tx.select().from(s.orderPendingEffect),
    }));
    const before = await facts();
    const holds = before.funding.filter(row => row.kind === 'RESERVE');
    expect(holds).toHaveLength(1);
    expect(holds[0]).toMatchObject({ status: 'PENDING', amount: 101, delta: 0 });
    expect(before.edits).toHaveLength(0); expect(before.effects).toHaveLength(0);
    await expect(previewOrderEdit(STORE, placed.code, [])).rejects.toMatchObject({ code: 'ORDER_PRICING_EDIT_UNSUPPORTED' });
    expect((await loadEditContext(STORE, placed.code)).editable).toMatchObject({ items: false, addressOnly: true, address: true });
    expect(await facts()).toEqual(before);
  });
});
