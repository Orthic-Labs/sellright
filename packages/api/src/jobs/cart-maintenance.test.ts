/**
 * DB tests for the cart lifecycle job (CART-04): inactivity → abandoned,
 * expired empty active carts purged, abandoned carts purged past the 24h
 * (CART_RETENTION_DAYS=1) deployment default — owner decision 2026-09-24 —
 * per-store retention windows honored, and converted carts + orders NEVER
 * touched. Also covers the stale-write guard: the job must not clobber a
 * cart that was converted between its scan and its write.
 *
 * Runs against a dedicated *_test DB ONLY (these wipe data). vitest runs
 * files serially (fileParallelism: false).
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import * as s from '../db/schema.js';
import { abandonStaleCarts, cleanupExpiredCarts } from './cart-maintenance.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`cart-maintenance test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);
}

const STORE = 'cccccccc-4444-4444-4444-444444444444';
const STORE_B = 'cccccccc-5555-5555-5555-555555555555';
const SLUG = 'cart-maint-test-store';
const SLUG_B = 'cart-maint-test-store-b';

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
}

async function seedStore(id: string, slug: string, config?: unknown): Promise<void> {
  await pool.query('INSERT INTO store (id, slug, name, currency, config) VALUES ($1, $2, $3, $4, $5::jsonb) ON CONFLICT (id) DO NOTHING',
    [id, slug, slug, 'USD', config ? JSON.stringify(config) : null]);
}

const HOURS = 3_600_000;
const DAYS = 24 * HOURS;
const ago = (ms: number) => new Date(Date.now() - ms);
const ahead = (ms: number) => new Date(Date.now() + ms);

let seq = 0;
/** Seed a cart directly (timestamps need SQL-level control). */
async function seedCart(opts: {
  store?: string; status?: 'active' | 'abandoned' | 'converted' | 'merged'; lines?: number;
  updatedAt?: Date; expiresAt?: Date | null; orderId?: string | null;
}): Promise<string> {
  const storeId = opts.store ?? STORE;
  return withStore(storeId, async (tx) => {
    const r = await tx.execute(sql`
      INSERT INTO cart (id, store_id, token, status, converted_order_id, expires_at, updated_at)
      VALUES (gen_random_uuid(), ${storeId}, ${`maint-${++seq}`}, ${opts.status ?? 'active'},
              ${opts.orderId ?? null}, ${opts.expiresAt === undefined ? ahead(30 * DAYS) : opts.expiresAt},
              ${opts.updatedAt ?? new Date()})
      RETURNING id`);
    const id = (r.rows[0] as { id: string }).id;
    for (let i = 0; i < (opts.lines ?? 0); i++) {
      await tx.execute(sql`INSERT INTO cart_line (id, store_id, cart_id, sku, quantity) VALUES (gen_random_uuid(), ${storeId}, ${id}, ${`SKU-${i}`}, 1)`);
    }
    return id;
  });
}

async function seedOrder(): Promise<string> {
  return withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`
      INSERT INTO "order" (id, store_id, code, state, currency, grand_total)
      VALUES (gen_random_uuid(), ${STORE}, ${`CM${++seq}`}, 'PendingPayment', 'USD', 1000) RETURNING id`);
    return (r.rows[0] as { id: string }).id;
  });
}

async function cartById(id: string) {
  return withStore(STORE, async (tx) => {
    const [row] = await tx.select().from(s.cart).where(eq(s.cart.id, id)).limit(1);
    return row ?? null;
  });
}

beforeEach(async () => {
  await wipe();
  await seedStore(STORE, SLUG);
});
afterAll(async () => { await wipe(); await pool.end(); });

describe('abandonStaleCarts', () => {
  it('flags a stale non-empty active cart abandoned and bumps its revision', async () => {
    const id = await seedCart({ status: 'active', lines: 2, updatedAt: ago(6 * HOURS) });
    const before = await cartById(id);
    const { abandoned } = await abandonStaleCarts(4);
    expect(abandoned).toBe(1);
    const row = await cartById(id);
    expect(row!.status).toBe('abandoned');
    expect(row!.revision).toBe(before!.revision + 1);
  });

  it('leaves empty, fresh, and already-abandoned carts alone', async () => {
    const empty = await seedCart({ status: 'active', lines: 0, updatedAt: ago(6 * HOURS) });
    const fresh = await seedCart({ status: 'active', lines: 1, updatedAt: ago(1 * HOURS) });
    const already = await seedCart({ status: 'abandoned', lines: 1, updatedAt: ago(30 * HOURS) });
    const { abandoned } = await abandonStaleCarts(4);
    expect(abandoned).toBe(0);
    expect((await cartById(empty))!.status).toBe('active');
    expect((await cartById(fresh))!.status).toBe('active');
    expect((await cartById(already))!.status).toBe('abandoned');
  });

  it('never flips a converted cart back to abandoned', async () => {
    const orderId = await seedOrder();
    const id = await seedCart({ status: 'converted', lines: 1, updatedAt: ago(30 * HOURS), orderId });
    const { abandoned } = await abandonStaleCarts(4);
    expect(abandoned).toBe(0);
    const row = await cartById(id);
    expect(row!.status).toBe('converted');
    expect(row!.convertedOrderId).toBe(orderId);
  });

  it('honors a per-store inactivity window from store.config.cart.abandonAfterHours', async () => {
    // Store A overrides to 1h; store B (no config) follows the passed default (24h).
    await seedStore(STORE_B, SLUG_B, { cart: { abandonAfterHours: 1 } });
    const inB = await seedCart({ store: STORE_B, status: 'active', lines: 1, updatedAt: ago(2 * HOURS) });
    const inA = await seedCart({ status: 'active', lines: 1, updatedAt: ago(2 * HOURS) });
    const { abandoned } = await abandonStaleCarts(24);
    expect(abandoned).toBe(1); // only B's cart is stale under its 1h window
    const rowB = await withStore(STORE_B, async (tx) => {
      const [r] = await tx.select().from(s.cart).where(eq(s.cart.id, inB)).limit(1);
      return r!;
    });
    expect(rowB.status).toBe('abandoned');
    expect((await cartById(inA))!.status).toBe('active');
  });
});

// ── scan→write race (regression: a cart touched between the candidate scan
// and the guarded write must survive untouched) ────────────────────────────
// The job locks candidate rows FOR UPDATE inside the store tx, so a racing
// shopper write either commits before the lock is taken (Postgres re-checks
// the scan predicate on the fresh row — a just-extended expiresAt, a just-
// refreshed updatedAt, or a just-added line drops the cart from the
// candidate set) or queues behind it. These tests reproduce the dangerous
// interleaving deterministically: a raw client takes the cart row lock (the
// same lock every cart mutation takes), the job is launched and observed
// blocked on it, then the "shopper" change commits.

/** Poll until another backend is blocked on a lock against the cart table —
 *  i.e. the job's FOR UPDATE scan (or guarded write) is queueing behind the
 *  row lock this test holds. Fails loudly rather than hanging the suite. */
async function waitForCartLockWaiter(): Promise<void> {
  for (let i = 0; i < 400; i++) {
    const { rows } = await pool.query(
      `SELECT 1 FROM pg_stat_activity
       WHERE datname = current_database() AND pid <> pg_backend_pid()
         AND wait_event_type = 'Lock' AND query ILIKE '%cart%' LIMIT 1`);
    if (rows.length) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('timed out waiting for the maintenance job to block on the locked cart row');
}

describe('cleanupExpiredCarts — scan→write race', () => {
  it('a cart whose expiresAt is extended between the candidate scan and the delete survives', async () => {
    const id = await seedCart({ status: 'active', lines: 0, expiresAt: ago(1 * HOURS) });
    const client = await pool.connect();
    const extended = ahead(30 * DAYS);
    try {
      await client.query('BEGIN');
      // "cart" carries FORCE ROW LEVEL SECURITY — without app.current_store
      // set on this raw connection the UPDATE below matches zero rows (RLS
      // hides them), takes no lock, and the job races ahead undetected.
      await client.query("SELECT set_config('app.current_store', $1, true)", [STORE]);
      // Take the cart row lock exactly like a shopper mutation does — the
      // job must block on it rather than scan-then-delete underneath us.
      await client.query('UPDATE cart SET expires_at = $1, updated_at = now(), revision = revision + 1 WHERE id = $2', [extended, id]);
      const job = cleanupExpiredCarts();
      await waitForCartLockWaiter();
      await client.query('COMMIT');
      const { deleted } = await job;
      expect(deleted).toBe(0);
      const row = await cartById(id);
      expect(row).not.toBeNull();
      expect(row!.expiresAt!.getTime()).toBe(extended.getTime());
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('a cart that gains a line between scan and delete survives — with its line intact', async () => {
    const id = await seedCart({ status: 'active', lines: 0, expiresAt: ago(1 * HOURS) });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // The shopper's line write: cart_line insert + the cart-row touch that
      // accompanies every line mutation (applyLines updates the cart row).
      await client.query("SELECT set_config('app.current_store', $1, true)", [STORE]);
      await client.query('INSERT INTO cart_line (id, store_id, cart_id, sku, quantity) VALUES (gen_random_uuid(), $1, $2, $3, 1)', [STORE, id, 'RACE-SKU']);
      await client.query('UPDATE cart SET expires_at = $1, updated_at = now(), revision = revision + 1 WHERE id = $2', [ahead(30 * DAYS), id]);
      const job = cleanupExpiredCarts();
      await waitForCartLockWaiter();
      await client.query('COMMIT');
      const { deleted } = await job;
      expect(deleted).toBe(0);
      const row = await cartById(id);
      expect(row).not.toBeNull();
      const lines = await withStore(STORE, (tx) => tx.select().from(s.cartLine).where(eq(s.cartLine.cartId, id)));
      expect(lines).toHaveLength(1);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('purges expired merged carts — terminal and always empty, same TTL rule as active', async () => {
    const expiredMerged = await seedCart({ status: 'merged', lines: 0, expiresAt: ago(1 * HOURS) });
    const liveMerged = await seedCart({ status: 'merged', lines: 0, expiresAt: ahead(1 * HOURS) });
    const { deleted } = await cleanupExpiredCarts();
    expect(deleted).toBe(1);
    expect(await cartById(expiredMerged)).toBeNull();
    expect(await cartById(liveMerged)).not.toBeNull();
  });

  it('retention purge removes the abandoned cart AND its lines', async () => {
    await wipe();
    await seedStore(STORE, SLUG, { cart: { retentionDays: 7 } });
    const old = await seedCart({ status: 'abandoned', lines: 2, updatedAt: ago(10 * DAYS) });
    const { deleted } = await cleanupExpiredCarts();
    expect(deleted).toBe(1);
    expect(await cartById(old)).toBeNull();
    const lines = await withStore(STORE, (tx) => tx.select().from(s.cartLine).where(eq(s.cartLine.cartId, old)));
    expect(lines).toHaveLength(0);
  });
});

describe('abandonStaleCarts — scan→write race', () => {
  it('a cart refreshed between the candidate scan and the UPDATE is NOT flipped abandoned', async () => {
    const id = await seedCart({ status: 'active', lines: 1, updatedAt: ago(6 * HOURS) });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // "cart" carries FORCE ROW LEVEL SECURITY — without app.current_store
      // set on this raw connection the UPDATE below matches zero rows (RLS
      // hides them), takes no lock, and the job races ahead undetected.
      await client.query("SELECT set_config('app.current_store', $1, true)", [STORE]);
      await client.query('UPDATE cart SET updated_at = now(), revision = revision + 1 WHERE id = $1', [id]);
      const job = abandonStaleCarts(4);
      await waitForCartLockWaiter();
      await client.query('COMMIT');
      const { abandoned } = await job;
      expect(abandoned).toBe(0);
      expect((await cartById(id))!.status).toBe('active');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });
});

describe('cleanupExpiredCarts', () => {
  it('purges ONLY expired, empty, active carts', async () => {
    const expiredEmpty = await seedCart({ status: 'active', lines: 0, expiresAt: ago(1 * HOURS) });
    const expiredWithLines = await seedCart({ status: 'active', lines: 1, expiresAt: ago(1 * HOURS) });
    const expiredAbandoned = await seedCart({ status: 'abandoned', lines: 0, expiresAt: ago(1 * HOURS) });
    const liveEmpty = await seedCart({ status: 'active', lines: 0, expiresAt: ahead(1 * HOURS) });
    const { deleted } = await cleanupExpiredCarts();
    expect(deleted).toBe(1);
    expect(await cartById(expiredEmpty)).toBeNull();
    expect(await cartById(expiredWithLines)).not.toBeNull();
    expect(await cartById(expiredAbandoned)).not.toBeNull();
    expect(await cartById(liveEmpty)).not.toBeNull();
  });

  it('owner decision 2026-09-24: purges abandoned carts past the 24h (CART_RETENTION_DAYS=1) deployment default with no store config', async () => {
    const ancient = await seedCart({ status: 'abandoned', lines: 1, updatedAt: ago(365 * DAYS), expiresAt: ago(300 * DAYS) });
    const recent = await seedCart({ status: 'abandoned', lines: 1, updatedAt: ago(2 * HOURS) });
    const { deleted } = await cleanupExpiredCarts();
    expect(deleted).toBe(1);
    expect(await cartById(ancient)).toBeNull();
    // Still well within the 24h retention window — not touched.
    expect(await cartById(recent)).not.toBeNull();
  });

  it('with store.config.cart.retentionDays set, old abandoned carts purge — but NEVER converted carts or orders', async () => {
    await wipe();
    await seedStore(STORE, SLUG, { cart: { retentionDays: 7 } });
    const orderId = await seedOrder();
    const oldAbandoned = await seedCart({ status: 'abandoned', lines: 1, updatedAt: ago(10 * DAYS) });
    const recentAbandoned = await seedCart({ status: 'abandoned', lines: 1, updatedAt: ago(3 * DAYS) });
    const converted = await seedCart({ status: 'converted', lines: 1, updatedAt: ago(30 * DAYS), expiresAt: ago(30 * DAYS), orderId });
    const { deleted } = await cleanupExpiredCarts();
    expect(deleted).toBe(1);
    expect(await cartById(oldAbandoned)).toBeNull();
    expect(await cartById(recentAbandoned)).not.toBeNull();
    // Converted carts anchor payment recovery — never purged regardless of age.
    expect(await cartById(converted)).not.toBeNull();
    const [o] = await withStore(STORE, (tx) => tx.select().from(s.order).where(eq(s.order.id, orderId)).limit(1));
    expect(o!.state).toBe('PendingPayment');
  });
});
