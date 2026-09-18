/**
 * SR-01/SR-02 tenant-resolution seam contract. Proves at the DB layer that an
 * inbound gateway event resolves its owning storeId while connected as the
 * RLS nonowner app role — no app.current_store — and that FORCE RLS still
 * fails closed for the app role's direct reads (the seam is the controlled
 * exception, never a broad bypass).
 *
 *   pool    (client.ts, DATABASE_URL)            — owner/migration role: seed + wipe
 *   appPool (DATABASE_URL_NONOWNER, or owner)    — nonowner role: assertions
 *   resolveStoreForGatewayEvent                  — seam under test; prefers
 *                                                  DATABASE_URL_NONOWNER itself
 *
 * Requires migrations applied to DATABASE_URL. Self-skips unless DATABASE_URL
 * targets a *_test database — TRUNCATE would wipe real data.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { pool, withStore, assertRuntimeRoleUnprivileged } from '../db/client.js';
import { env } from '../env.js';
import { RLS_STORE_A as A, RLS_STORE_B as B } from '../db/rls-test-utils.js';
import { resolveStoreForGatewayEvent } from './tenant-resolution.js';

const DB = process.env.DATABASE_URL ?? '';
const IS_TEST_DB = /_test(\b|$|\?)/.test(DB);
const NONOWNER = env.DATABASE_URL_NONOWNER;

const appPool = new Pool({ connectionString: NONOWNER ?? env.DATABASE_URL });

const ORDER_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaa1';
const ORDER_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbb2';

async function wipe() {
  await withStore(A, async (tx) => {
    await tx.execute(sql`TRUNCATE store CASCADE`);
  });
}

async function seedBothStores() {
  await withStore(A, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name) VALUES (${A}, 'store-a', 'Store A')`);
    await tx.execute(sql`INSERT INTO "order" (id, store_id, code) VALUES (${ORDER_A}, ${A}, 'O-A')`);
    await tx.execute(sql`
      INSERT INTO payment (store_id, order_id, amount, method, provider_ref)
      VALUES (${A}, ${ORDER_A}, 500, 'stripe', 'pi_store_a')`);
    await tx.execute(sql`
      INSERT INTO subscription (store_id, stripe_subscription_id)
      VALUES (${A}, 'sub_store_a')`);
    await tx.execute(sql`
      INSERT INTO payment_attempt
        (store_id, order_id, operation, method, account_id, mode, amount, currency, idempotency_key, fingerprint, provider_ref)
      VALUES (${A}, ${ORDER_A}, 'charge', 'nmi', 'acct-a', 'test', 500, 'USD', 'idem-a', 'fp-a', 'txn_store_a')`);
  });
  await withStore(B, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name) VALUES (${B}, 'store-b', 'Store B')`);
    await tx.execute(sql`INSERT INTO "order" (id, store_id, code) VALUES (${ORDER_B}, ${B}, 'O-B')`);
    await tx.execute(sql`
      INSERT INTO payment (store_id, order_id, amount, method, provider_ref)
      VALUES (${B}, ${ORDER_B}, 700, 'stripe', 'pi_store_b')`);
    await tx.execute(sql`
      INSERT INTO subscription (store_id, stripe_subscription_id)
      VALUES (${B}, 'sub_store_b')`);
    await tx.execute(sql`
      INSERT INTO payment_attempt
        (store_id, order_id, operation, method, account_id, mode, amount, currency, idempotency_key, fingerprint, provider_ref)
      VALUES (${B}, ${ORDER_B}, 'charge', 'sezzle', 'acct-b', 'test', 700, 'USD', 'idem-b', 'fp-b', 'sz_store_b')`);
  });
}

/**
 * Strict-resolution fixtures (migration 0060). The collisions below are the
 * exact shapes the loose resolver got wrong: a provider_ref present in two
 * stores, a ref recorded under a different account than the event claims, and
 * rows whose recorded mode differs from the event's mode.
 */
async function seedStrictRows() {
  await withStore(A, async (tx) => {
    // A's copy of the colliding stripe ref — live mode, account acct-stripe-a.
    await tx.execute(sql`
      INSERT INTO payment (store_id, order_id, amount, method, provider_ref, gateway_account, gateway_mode)
      VALUES (${A}, ${ORDER_A}, 500, 'stripe', 'pi_dup', 'acct-stripe-a', 'live')`);
    // nmi ref shared with an attempt row in B (payment row AND attempt row in A).
    await tx.execute(sql`
      INSERT INTO payment (store_id, order_id, amount, method, provider_ref, gateway_account, gateway_mode)
      VALUES (${A}, ${ORDER_A}, 500, 'nmi', 'txn_shared', 'nmi-acct-a', 'test')`);
    await tx.execute(sql`
      INSERT INTO payment_attempt
        (store_id, order_id, operation, method, account_id, mode, amount, currency, idempotency_key, fingerprint, provider_ref)
      VALUES (${A}, ${ORDER_A}, 'charge', 'nmi', 'nmi-acct-a', 'test', 500, 'USD', 'idem-strict-a', 'fp-strict-a', 'txn_shared')`);
    // Ref recorded before its gateway identity was persisted (NULL mode/
    // account) — a supplied binding must NOT match this row.
    await tx.execute(sql`
      INSERT INTO payment (store_id, order_id, amount, method, provider_ref)
      VALUES (${A}, ${ORDER_A}, 500, 'stripe', 'pi_nomode_a')`);
  });
  await withStore(B, async (tx) => {
    // B's copy of the same stripe ref — test mode, a different account.
    await tx.execute(sql`
      INSERT INTO payment (store_id, order_id, amount, method, provider_ref, gateway_account, gateway_mode)
      VALUES (${B}, ${ORDER_B}, 900, 'stripe', 'pi_dup', 'acct-stripe-b', 'test')`);
    await tx.execute(sql`
      INSERT INTO payment_attempt
        (store_id, order_id, operation, method, account_id, mode, amount, currency, idempotency_key, fingerprint, provider_ref)
      VALUES (${B}, ${ORDER_B}, 'charge', 'nmi', 'nmi-acct-b', 'test', 900, 'USD', 'idem-strict-b', 'fp-strict-b', 'txn_shared')`);
  });
}

const fn = (provider: string, payment: string | null, sub: string | null, acct: string | null, mode: string | null = null) =>
  appPool.query<{ store_id: string | null }>(
    'SELECT public.resolve_store_for_gateway_event($1, $2, $3, $4, $5) AS store_id',
    [provider, payment, sub, acct, mode],
  );

describe.skipIf(!IS_TEST_DB)('tenant resolution seam (SR-01)', () => {
  beforeEach(wipe);
  afterAll(async () => {
    await wipe();
    await pool.end();
    await appPool.end();
  });

  it('the nonowner role cannot read tenant rows without a store context', async () => {
    await seedBothStores();
    const { rows } = await appPool.query('SELECT count(*)::int AS n FROM payment');
    expect(rows[0].n).toBe(0);
    const scoped = await appPool.query(
      "SELECT count(*)::int AS n FROM payment WHERE provider_ref = 'pi_store_b'",
    );
    expect(scoped.rows[0].n).toBe(0);
  });

  it('resolves a payment ref to the owning store under the nonowner role', async () => {
    await seedBothStores();
    expect((await fn('stripe', 'pi_store_a', null, null)).rows[0]?.store_id).toBe(A);
    expect((await fn('stripe', 'pi_store_b', null, null)).rows[0]?.store_id).toBe(B);
    expect((await fn('nmi', 'txn_store_a', null, null)).rows[0]?.store_id).toBe(A);
    expect((await fn('sezzle', 'sz_store_b', null, null)).rows[0]?.store_id).toBe(B);
  });

  it('resolves subscription and account refs under the nonowner role', async () => {
    await seedBothStores();
    expect((await fn('stripe', null, 'sub_store_a', null)).rows[0]?.store_id).toBe(A);
    expect((await fn('stripe', null, 'sub_store_b', null)).rows[0]?.store_id).toBe(B);
    expect((await fn('nmi', null, null, 'acct-a')).rows[0]?.store_id).toBe(A);
    expect((await fn('sezzle', null, null, 'acct-b')).rows[0]?.store_id).toBe(B);
  });

  it('provider binding: a ref minted under another provider never resolves', async () => {
    await seedBothStores();
    expect((await fn('nmi', 'pi_store_a', null, null)).rows[0]?.store_id).toBeNull();
    expect((await fn('sezzle', null, 'sub_store_a', null)).rows[0]?.store_id).toBeNull();
    expect((await fn('stripe', 'txn_store_a', null, null)).rows[0]?.store_id).toBeNull();
    expect((await fn('bogus', 'pi_store_a', null, null)).rows[0]?.store_id).toBeNull();
  });

  it('resolveStoreForGatewayEvent returns {storeId} via the seam', async () => {
    await seedBothStores();
    await expect(resolveStoreForGatewayEvent('stripe', { paymentRef: 'pi_store_a' }))
      .resolves.toEqual({ storeId: A });
    await expect(resolveStoreForGatewayEvent('stripe', { paymentRef: 'pi_store_b' }))
      .resolves.toEqual({ storeId: B });
    await expect(resolveStoreForGatewayEvent('stripe', { subscriptionRef: 'sub_store_b' }))
      .resolves.toEqual({ storeId: B });
    await expect(resolveStoreForGatewayEvent('nmi', { accountRef: 'acct-a' }))
      .resolves.toEqual({ storeId: A });
    await expect(resolveStoreForGatewayEvent('stripe', { paymentRef: 'pi_unknown' }))
      .resolves.toBeNull();
    await expect(resolveStoreForGatewayEvent('stripe', {})).resolves.toBeNull();
  });

  it('the seam connects as the nonowner role when DATABASE_URL_NONOWNER is set', async () => {
    if (!NONOWNER) return; // single-role dev fallback — nothing extra to prove
    const { rows } = await appPool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
    );
    expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it('boot guard: rejects a privileged runtime role, accepts the app role', async () => {
    await expect(assertRuntimeRoleUnprivileged(appPool)).resolves.toBeUndefined();
    const { rows } = await pool.query<{ rolsuper: boolean }>(
      'SELECT rolsuper FROM pg_roles WHERE rolname = current_user',
    );
    if (rows[0]?.rolsuper) {
      await expect(assertRuntimeRoleUnprivileged(pool)).rejects.toThrow(/privileged/i);
    }
  });

  // ── STRICT resolution (migration 0060) ──────────────────────────────────
  // The 0053 resolver took ORDER BY created_at DESC LIMIT 1 on the first
  // applicable lookup — every case below silently resolved the newest row.
  // Strict semantics union the DISTINCT store_ids of ALL applicable lookups:
  // exactly one resolves, zero or several return NULL.

  it('fails closed when a provider_ref exists in two stores (the finding)', async () => {
    await seedBothStores();
    await seedStrictRows();
    // 'pi_dup' is a stripe payment row in BOTH A and B — the old function
    // returned the newest (B); strict resolution must return NULL.
    expect((await fn('stripe', 'pi_dup', null, null)).rows[0]?.store_id).toBeNull();
    // Same for a payment row + a payment_attempt row sharing a ref across stores.
    expect((await fn('nmi', 'txn_shared', null, null)).rows[0]?.store_id).toBeNull();
  });

  it('account binding disambiguates a shared ref; the wrong account resolves NULL', async () => {
    await seedBothStores();
    await seedStrictRows();
    // Bound to A's account → only A's row is a candidate.
    expect((await fn('stripe', 'pi_dup', null, 'acct-stripe-a')).rows[0]?.store_id).toBe(A);
    expect((await fn('stripe', 'pi_dup', null, 'acct-stripe-b')).rows[0]?.store_id).toBe(B);
    // A ref hit on a different account is EXCLUDED — an account the provider
    // doesn't know leaves zero candidates (NULL), never the unfiltered hit.
    expect((await fn('stripe', 'pi_dup', null, 'acct-nonexistent')).rows[0]?.store_id).toBeNull();
    expect((await fn('nmi', 'txn_store_a', null, 'acct-nonexistent')).rows[0]?.store_id).toBeNull();
    // A payment row with NULL gateway_account never matches a supplied account.
    expect((await fn('stripe', 'pi_nomode_a', null, 'acct-stripe-a')).rows[0]?.store_id).toBeNull();
  });

  it('mode binding excludes other-mode and NULL-mode rows; matches resolve', async () => {
    await seedBothStores();
    await seedStrictRows();
    // 'pi_dup': A's row is live, B's is test — binding picks exactly one.
    expect((await fn('stripe', 'pi_dup', null, null, 'live')).rows[0]?.store_id).toBe(A);
    expect((await fn('stripe', 'pi_dup', null, null, 'test')).rows[0]?.store_id).toBe(B);
    // NULL gateway_mode does not match a supplied mode.
    expect((await fn('stripe', 'pi_nomode_a', null, null, 'live')).rows[0]?.store_id).toBeNull();
    expect((await fn('stripe', 'pi_nomode_a', null, null)).rows[0]?.store_id).toBe(A);
    // payment_attempt.mode is NOT NULL but the same exclusion applies: A's
    // 'txn_store_a' attempt is test-mode; a live-mode claim excludes it.
    expect((await fn('nmi', 'txn_store_a', null, null, 'live')).rows[0]?.store_id).toBeNull();
    expect((await fn('nmi', 'txn_store_a', null, null, 'test')).rows[0]?.store_id).toBe(A);
  });

  it('a supplied account is also a positive anchor (attempt/event rows by account)', async () => {
    await seedBothStores();
    await seedStrictRows();
    // B's nmi account resolves B — a ref claim under a foreign account doesn't
    // suppress the legitimate account anchor (the event is then processed
    // under B where the foreign ref simply won't match anything: fail safe).
    expect((await fn('nmi', 'txn_store_a', null, 'nmi-acct-b')).rows[0]?.store_id).toBe(B);
    // Correct account + correct mode binds both anchors → A.
    expect((await fn('nmi', 'txn_shared', null, 'nmi-acct-a', 'test')).rows[0]?.store_id).toBe(A);
  });

  it('the stripe subscription anchor still resolves, unbound by account/mode', async () => {
    await seedBothStores();
    await seedStrictRows();
    // subscription rows carry no account/mode — the anchor resolves even when
    // bindings are supplied (stripe_subscription_id is provider-unique).
    expect((await fn('stripe', null, 'sub_store_a', 'acct-nonexistent', 'live')).rows[0]?.store_id).toBe(A);
    expect((await fn('stripe', null, 'sub_store_b', null, 'test')).rows[0]?.store_id).toBe(B);
  });

  it('resolveStoreForGatewayEvent binds account/mode and fails closed on ambiguity', async () => {
    await seedBothStores();
    await seedStrictRows();
    await expect(resolveStoreForGatewayEvent('stripe', { paymentRef: 'pi_dup' })).resolves.toBeNull();
    await expect(resolveStoreForGatewayEvent('stripe', { paymentRef: 'pi_dup', accountRef: 'acct-stripe-a', mode: 'live' }))
      .resolves.toEqual({ storeId: A });
    await expect(resolveStoreForGatewayEvent('stripe', { paymentRef: 'pi_dup', mode: 'test' }))
      .resolves.toEqual({ storeId: B });
    await expect(resolveStoreForGatewayEvent('stripe', { paymentRef: 'pi_nomode_a', mode: 'live' }))
      .resolves.toBeNull();
    // An invalid mode string is not a binding — but the ambiguity still fails closed.
    await expect(resolveStoreForGatewayEvent('stripe', { paymentRef: 'pi_dup', mode: 'bogus' as never }))
      .resolves.toBeNull();
  });

  it('the strict seam resolves under the nonowner role (SECURITY DEFINER path)', async () => {
    if (!NONOWNER) return; // single-role dev fallback — nothing extra to prove
    await seedBothStores();
    const { rows } = await appPool.query<{ u: string }>('SELECT current_user AS u');
    expect(rows[0]?.u).not.toBe('vendure'); // really the app role, not the owner
    expect(rows[0]?.u).toBeTruthy();
    // sr_app owns nothing and sees zero rows directly, yet the definer
    // function still resolves — including the strict NULL on ambiguity.
    expect((await fn('stripe', 'pi_store_a', null, null, 'live')).rows[0]?.store_id).toBeNull(); // NULL mode ≠ live
    expect((await fn('stripe', 'pi_store_a', null, null)).rows[0]?.store_id).toBe(A);
    await seedStrictRows();
    expect((await fn('stripe', 'pi_dup', null, null)).rows[0]?.store_id).toBeNull();
  });
});
