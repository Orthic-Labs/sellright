/**
 * WS-A (one-click install plan §1.6/§1.7): the DB-backed leg of the env>db
 * credential resolver, proven against a real Postgres — the piece
 * settings-resolver.test.ts's mocked-db unit tests cannot prove: that
 * checkout for store A actually uses store A's OWN decrypted Stripe key
 * (never falls through to another store's, never leaks it), and that the
 * secret is genuinely encrypted at rest, not just formatted differently.
 *
 * `stripe` (the SDK) is mocked so `resolveStripeClient`'s `new Stripe(key)`
 * is observable without a real network call or a real Stripe account —
 * exactly the kind of external-I/O boundary this suite is allowed to fake;
 * everything else (encryption, storage, RLS, resolution) is real.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { Pool } from 'pg';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import * as s from '../db/schema.js';
import { assertTestDatabase, createStoreAppRunner } from '../db/rls-test-utils.js';
import { encryptSecret } from '../security/secret-crypto.js';

assertTestDatabase(process.env.DATABASE_URL ?? env.DATABASE_URL, 'stripe-store-secret.db.test.ts');

const STORE_A = 'dddddddd-0000-0000-0000-0000000007a1';
const STORE_B = 'dddddddd-0000-0000-0000-0000000007b1';
const PLAINTEXT_KEY_A = 'sk_test_store_a_only_secret_value_123456';

// Capture what `new Stripe(key)` was constructed with, without a real SDK /
// network call. resolveStripeClient's only interaction with the constructed
// client, in this test, is `.paymentIntents.retrieve(id)`.
const constructedWithKeys: string[] = [];
vi.mock('stripe', () => {
  return {
    default: class FakeStripe {
      constructor(key: string) {
        constructedWithKeys.push(key);
      }
      paymentIntents = {
        retrieve: vi.fn(async (id: string) => ({
          id, amount: 1500, currency: 'usd', status: 'succeeded',
          metadata: { orderCode: 'SR-A-1' }, latest_charge: 'ch_fake',
        })),
      };
    },
  };
});

const { stripeProvider } = await import('./stripe.js');

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
}

async function seedStores() {
  await pool.query(
    `INSERT INTO store (id, slug, name, currency, config) VALUES ($1, $2, $2, 'USD', $3::jsonb) ON CONFLICT (id) DO NOTHING`,
    [STORE_A, 'stripe-secret-store-a', JSON.stringify({ payments: { stripe: true }, stripe: { mode: 'test' } })],
  );
  await pool.query(
    `INSERT INTO store (id, slug, name, currency, config) VALUES ($1, $2, $2, 'USD', $3::jsonb) ON CONFLICT (id) DO NOTHING`,
    [STORE_B, 'stripe-secret-store-b', JSON.stringify({ payments: { stripe: true }, stripe: { mode: 'test' } })],
  );
}

/** Insert store A's encrypted Stripe secret key directly (bypassing the admin
 *  route — this suite is testing the RESOLUTION + STORAGE layer, not the API). */
async function seedStoreASecret() {
  const purpose = `store:${STORE_A}:stripe:test:secretKey`;
  const sealed = encryptSecret(PLAINTEXT_KEY_A, { purpose });
  await withStore(STORE_A, (tx) => tx.insert(s.storeSecret).values({
    storeId: STORE_A, provider: 'stripe', mode: 'test', field: 'secretKey',
    keyVersion: sealed.v, iv: sealed.iv, ciphertext: sealed.ct, authTag: sealed.tag,
    last4: PLAINTEXT_KEY_A.slice(-4),
  }));
}

describe('Stripe checkout resolves per-store, DB-backed credentials (env unset)', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    for (const k of ['STRIPE_SECRET_KEY', 'STRIPE_SECRET_KEY_TEST', 'STRIPE_SECRET_KEY_LIVE', 'SELLRIGHT_MASTER_KEY']) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    process.env.SELLRIGHT_MASTER_KEY = 'b'.repeat(64); // deterministic 32-byte hex key for this suite
    constructedWithKeys.length = 0;
    await wipe();
    await seedStores();
    await seedStoreASecret();
  });
  afterAll(async () => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    await wipe();
  });

  it("uses store A's own DB-stored (decrypted) key to construct the Stripe client for store A's checkout", async () => {
    const result = await stripeProvider.createPayment({
      orderCode: 'SR-A-1', storeId: STORE_A, amount: 1500, currency: 'USD',
      token: 'pi_fake_a', stripeMode: 'test',
    });
    expect(result.state).toBe('Settled');
    expect(constructedWithKeys).toEqual([PLAINTEXT_KEY_A]);
  });

  it("store B has no configured key (env unset, no store_secret row) and fails closed — never falls through to store A's key", async () => {
    const result = await stripeProvider.createPayment({
      orderCode: 'SR-B-1', storeId: STORE_B, amount: 1500, currency: 'USD',
      token: 'pi_fake_b', stripeMode: 'test',
    });
    expect(result.state).toBe('Failed');
    expect(result.errorMessage).toMatch(/not configured/);
    // The Stripe client was never even constructed for store B's attempt.
    expect(constructedWithKeys).toEqual([]);
  });

  it('the DB row holds ciphertext, never the plaintext key', async () => {
    const [row] = await withStore(STORE_A, (tx) => tx.select().from(s.storeSecret)
      .where(and(eq(s.storeSecret.storeId, STORE_A), eq(s.storeSecret.field, 'secretKey'))).limit(1));
    expect(row).toBeDefined();
    expect(row!.ciphertext).not.toBe(PLAINTEXT_KEY_A);
    expect(row!.ciphertext).not.toContain(PLAINTEXT_KEY_A);
    expect(Buffer.from(row!.ciphertext, 'base64').toString('latin1')).not.toContain(PLAINTEXT_KEY_A);
    expect(row!.last4).toBe(PLAINTEXT_KEY_A.slice(-4));
  });

  it("store B (under FORCE RLS, non-owner app role) cannot read store A's store_secret row at all", async () => {
    const appPool = new Pool({ connectionString: env.DATABASE_URL_NONOWNER ?? env.DATABASE_URL });
    try {
      const withStoreApp = createStoreAppRunner(appPool, { casing: 'snake_case' } as const);
      const rowsSeenAsB = await withStoreApp(STORE_B, (tx) => tx.select().from(s.storeSecret));
      expect(rowsSeenAsB.length).toBe(0);
      const rowsSeenAsA = await withStoreApp(STORE_A, (tx) => tx.select().from(s.storeSecret));
      expect(rowsSeenAsA.length).toBeGreaterThan(0);
    } finally {
      await appPool.end();
    }
  });
});
