/**
 * Purchase → account bootstrap (upstream port, genericized). Covers the paid-
 * effects path every settlement funnels through (applyPaymentResult → Paid →
 * enqueuePaidEffects → bootstrapAccountAndQueueAccessMail):
 *
 *   1. A `softwareAccount`-flagged purchase creates a passwordless customer,
 *      links order + licenses, and enqueues exactly ONE account_access mail
 *      (claim/set-password token — never a session, never auto-login).
 *   2. Re-running settle / paid-effects cannot duplicate the account or mail.
 *   3. An unflagged product bootstraps nothing.
 *   4. An existing customer at the contact email is LINKED, not duplicated.
 *   5. An order already carrying a customerId is a bootstrap no-op.
 *
 * Sender/URL assertions prove the SR-05 tenant resolver (store.config) is used
 * — the downstream global-sender defect must not regress.
 *
 * Runs against a *_test DB only (TRUNCATEs store CASCADE).
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import * as s from '../db/schema.js';
import { applyPaymentResult } from '../payments/settle.js';
import { enqueuePaidEffects } from '../payments/paid-effects.js';
import { bootstrapAccountAndQueueAccessMail, ACCOUNT_ACCESS_KIND } from './account-bootstrap.js';
import type { PaymentResult } from '../payments/provider.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`account-bootstrap test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);
}

const STORE_A = 'abababab-0000-4000-8000-00000000000a';
const STORE_B = 'abababab-0000-4000-8000-00000000000b';

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
}

async function seedStores(): Promise<void> {
  await pool.query(
    `INSERT INTO store (id, slug, name, currency, config) VALUES
       ($1, 'ab-brand-a', 'Brand A', 'USD', $3::jsonb),
       ($2, 'ab-brand-b', 'Brand B', 'EUR', $4::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [
      STORE_A, STORE_B,
      JSON.stringify({ storefrontUrl: 'https://a-shop.example', emailFrom: 'orders@a-shop.example' }),
      JSON.stringify({ storefrontUrl: 'https://b-shop.example', emailFrom: 'orders@b-shop.example' }),
    ],
  );
}

/** Product + variant; `flagged` sets metafields.softwareAccount on the VARIANT
 *  (and `flaggedOnProduct` on the product) — the catalog opt-in for bootstrap. */
async function seedVariant(
  storeId: string,
  sku: string,
  opts: { flagged?: boolean; flaggedOnProduct?: boolean; appKey?: string | null } = {},
): Promise<string> {
  return withStore(storeId, async (tx) => {
    const [p] = await tx.insert(s.product).values({
      storeId, slug: `p-${sku.toLowerCase()}`, name: `Product ${sku}`, status: 'active',
      metafields: opts.flaggedOnProduct ? { softwareAccount: true } : null,
    }).returning({ id: s.product.id });
    const [v] = await tx.insert(s.productVariant).values({
      storeId, productId: p!.id, sku, name: `Variant ${sku}`, price: 4900,
      fulfillmentType: 'license', appKey: opts.appKey === undefined ? 'testapp' : opts.appKey,
      metafields: opts.flagged ? { softwareAccount: true } : null,
    }).returning({ id: s.productVariant.id });
    return v!.id;
  });
}

/** PendingPayment order + one line; contact email rides order.metadata the way
 *  checkout.ts writes it (no customer link — the guest-checkout shape). */
async function seedOrder(
  storeId: string,
  opts: { variantId: string; code: string; email?: string; customerId?: string | null; grandTotal?: number },
): Promise<string> {
  return withStore(storeId, async (tx) => {
    const [o] = await tx.insert(s.order).values({
      storeId, code: opts.code, state: 'PendingPayment', currency: 'USD',
      grandTotal: opts.grandTotal ?? 4900,
      customerId: opts.customerId ?? null,
      metadata: opts.email ? { contact: { email: opts.email } } : null,
    }).returning({ id: s.order.id });
    await tx.insert(s.orderLine).values({
      storeId, orderId: o!.id, variantId: opts.variantId, variantSku: 'SKU', variantName: 'Line',
      quantity: 1, unitPrice: opts.grandTotal ?? 4900,
      lineSubtotal: opts.grandTotal ?? 4900, lineTotal: opts.grandTotal ?? 4900,
    });
    return o!.id;
  });
}

async function settleOrder(storeId: string, orderId: string, providerRef: string): Promise<void> {
  const result: PaymentResult = { state: 'Settled', providerRef, metadata: { test: true } };
  await withStore(storeId, (tx) => applyPaymentResult(tx, {
    storeId,
    order: { id: orderId, state: 'PendingPayment', grandTotal: 4900, currency: 'USD', customerId: null },
    method: 'manual',
    result,
  }));
}

type OutboxRow = { kind: string; recipient: string; payload: { to?: string; from?: string; html?: string; text?: string }; dedupeKey: string | null };
async function outbox(storeId: string): Promise<OutboxRow[]> {
  return withStore(storeId, async (tx) => {
    const r = await tx.execute(sql`SELECT kind, recipient, payload, dedupe_key AS "dedupeKey" FROM email_outbox WHERE store_id = ${storeId} ORDER BY created_at`);
    return r.rows as OutboxRow[];
  });
}

async function customers(storeId: string) {
  return withStore(storeId, (tx) => tx.select().from(s.customer).where(eq(s.customer.storeId, storeId)));
}

describe('purchase → account bootstrap', () => {
  beforeEach(async () => { await wipe(); await seedStores(); });
  afterAll(async () => { await wipe(); await pool.end(); });

  it('flagged purchase: creates a passwordless account, links order + license, enqueues one claim mail', async () => {
    const variantId = await seedVariant(STORE_B, 'FLAG-1', { flagged: true });
    const orderId = await seedOrder(STORE_B, { variantId, code: 'B-FLAG-1', email: 'NewBuyer@b.test' });
    await settleOrder(STORE_B, orderId, 'm_flag_1');

    const custs = await customers(STORE_B);
    expect(custs).toHaveLength(1);
    expect(custs[0]!.email).toBe('newbuyer@b.test'); // normalized
    expect(custs[0]!.passwordHash).toBeNull(); // passwordless
    expect(custs[0]!.emailVerified).toBe(false); // mailbox not yet proven

    const [order] = await withStore(STORE_B, (tx) => tx.select().from(s.order).where(eq(s.order.id, orderId)));
    expect(order!.state).toBe('Paid');
    expect(order!.customerId).toBe(custs[0]!.id);

    // Entitlement associated with the new account.
    const licenses = await withStore(STORE_B, (tx) => tx.select().from(s.license).where(eq(s.license.orderId, orderId)));
    expect(licenses).toHaveLength(1);
    expect(licenses[0]!.customerId).toBe(custs[0]!.id);

    // One claim mail via the tenant resolver: store B's sender + storefront.
    const mails = (await outbox(STORE_B)).filter((m) => m.kind === ACCOUNT_ACCESS_KIND);
    expect(mails).toHaveLength(1);
    expect(mails[0]!.recipient).toBe('newbuyer@b.test');
    expect(mails[0]!.payload.from).toBe('orders@b-shop.example');
    expect(mails[0]!.payload.from).not.toBe(env.SMTP_FROM);
    expect(mails[0]!.payload.html).toContain('https://b-shop.example/set-password?token=');
    expect(mails[0]!.payload.html).not.toContain('a-shop.example');
    expect(mails[0]!.dedupeKey).toBe(`${ACCOUNT_ACCESS_KIND}:${orderId}`);

    // One-time set_password token minted (hashed, TTL'd, unused).
    const tokens = await withStore(STORE_B, (tx) =>
      tx.select().from(s.customerToken).where(and(eq(s.customerToken.customerId, custs[0]!.id), eq(s.customerToken.kind, 'set_password'))));
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.usedAt).toBeNull();
    expect(tokens[0]!.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(tokens[0]!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    // The raw token only exists inside the emailed link.
    expect(mails[0]!.payload.html).not.toContain(tokens[0]!.tokenHash);
  });

  it('settle retry + paid-effects replay: no duplicate account, token, or mail', async () => {
    const variantId = await seedVariant(STORE_A, 'FLAG-2', { flagged: true });
    const orderId = await seedOrder(STORE_A, { variantId, code: 'A-FLAG-2', email: 'twice@a.test' });
    await settleOrder(STORE_A, orderId, 'm_flag_2');
    // Duplicate settle for the SAME capture (webhook racing /pay).
    await settleOrder(STORE_A, orderId, 'm_flag_2');
    // Direct paid-effects replay + direct bootstrap call.
    await withStore(STORE_A, (tx) => enqueuePaidEffects(tx, STORE_A, orderId));
    await withStore(STORE_A, (tx) => bootstrapAccountAndQueueAccessMail(tx, { storeId: STORE_A, orderId, existingCustomerId: null }));

    expect(await customers(STORE_A)).toHaveLength(1);
    const mails = (await outbox(STORE_A)).filter((m) => m.kind === ACCOUNT_ACCESS_KIND);
    expect(mails).toHaveLength(1);
    const custs = await customers(STORE_A);
    const tokens = await withStore(STORE_A, (tx) =>
      tx.select().from(s.customerToken).where(eq(s.customerToken.customerId, custs[0]!.id)));
    expect(tokens).toHaveLength(1);
  });

  it('unflagged product: settle still pays + confirms, but no account and no claim mail', async () => {
    const variantId = await seedVariant(STORE_B, 'PLAIN-1', { flagged: false });
    const orderId = await seedOrder(STORE_B, { variantId, code: 'B-PLAIN-1', email: 'guest@b.test' });
    await settleOrder(STORE_B, orderId, 'm_plain_1');

    const [order] = await withStore(STORE_B, (tx) => tx.select().from(s.order).where(eq(s.order.id, orderId)));
    expect(order!.state).toBe('Paid');
    expect(order!.customerId).toBeNull();
    expect(await customers(STORE_B)).toHaveLength(0);
    // The license was issued but stays unattributed.
    const licenses = await withStore(STORE_B, (tx) => tx.select().from(s.license).where(eq(s.license.orderId, orderId)));
    expect(licenses).toHaveLength(1);
    expect(licenses[0]!.customerId).toBeNull();

    const rows = await outbox(STORE_B);
    expect(rows.filter((m) => m.kind === ACCOUNT_ACCESS_KIND)).toHaveLength(0);
    expect(rows.some((m) => m.kind === 'order_confirmation')).toBe(true);
  });

  it('flag on product.metafields (not the variant) also triggers', async () => {
    const variantId = await seedVariant(STORE_A, 'PFLAG-1', { flaggedOnProduct: true });
    const orderId = await seedOrder(STORE_A, { variantId, code: 'A-PFLAG-1', email: 'prod@a.test' });
    await settleOrder(STORE_A, orderId, 'm_pflag_1');
    expect(await customers(STORE_A)).toHaveLength(1);
    const mails = (await outbox(STORE_A)).filter((m) => m.kind === ACCOUNT_ACCESS_KIND);
    expect(mails).toHaveLength(1);
  });

  it('existing customer at the contact email: linked, not duplicated', async () => {
    const variantId = await seedVariant(STORE_B, 'EXIST-1', { flagged: true });
    const existingId = await withStore(STORE_B, async (tx) => {
      const [c] = await tx.insert(s.customer).values({ storeId: STORE_B, email: 'regular@b.test' }).returning({ id: s.customer.id });
      return c!.id;
    });
    const orderId = await seedOrder(STORE_B, { variantId, code: 'B-EXIST-1', email: ' Regular@b.test ' });
    await settleOrder(STORE_B, orderId, 'm_exist_1');

    const custs = await customers(STORE_B);
    expect(custs).toHaveLength(1);
    expect(custs[0]!.id).toBe(existingId);
    const [order] = await withStore(STORE_B, (tx) => tx.select().from(s.order).where(eq(s.order.id, orderId)));
    expect(order!.customerId).toBe(existingId);
    const licenses = await withStore(STORE_B, (tx) => tx.select().from(s.license).where(eq(s.license.orderId, orderId)));
    expect(licenses[0]!.customerId).toBe(existingId);
    // Linked account still gets ONE access mail (linked, not new copy).
    const mails = (await outbox(STORE_B)).filter((m) => m.kind === ACCOUNT_ACCESS_KIND);
    expect(mails).toHaveLength(1);
    expect(mails[0]!.recipient).toBe('regular@b.test');
  });

  it('order already linked to a customer (session/email-match checkout): bootstrap no-ops, no claim mail', async () => {
    const variantId = await seedVariant(STORE_A, 'LINKED-1', { flagged: true });
    const custId = await withStore(STORE_A, async (tx) => {
      const [c] = await tx.insert(s.customer).values({ storeId: STORE_A, email: 'member@a.test' }).returning({ id: s.customer.id });
      return c!.id;
    });
    const orderId = await seedOrder(STORE_A, { variantId, code: 'A-LINKED-1', email: 'member@a.test', customerId: custId });
    await settleOrder(STORE_A, orderId, 'm_linked_1');

    expect(await customers(STORE_A)).toHaveLength(1);
    const mails = (await outbox(STORE_A)).filter((m) => m.kind === ACCOUNT_ACCESS_KIND);
    expect(mails).toHaveLength(0);
    const tokens = await withStore(STORE_A, (tx) => tx.select().from(s.customerToken).where(eq(s.customerToken.customerId, custId)));
    expect(tokens).toHaveLength(0);
  });

  it('flagged purchase with no contact email: nothing to claim against — no account, no mail', async () => {
    const variantId = await seedVariant(STORE_A, 'NOMAIL-1', { flagged: true });
    const orderId = await seedOrder(STORE_A, { variantId, code: 'A-NOMAIL-1' });
    await settleOrder(STORE_A, orderId, 'm_nomail_1');
    expect(await customers(STORE_A)).toHaveLength(0);
    const mails = (await outbox(STORE_A)).filter((m) => m.kind === ACCOUNT_ACCESS_KIND);
    expect(mails).toHaveLength(0);
  });
});
