/**
 * ra-008: DB-layer tests for the licensing activation path.
 *
 * Runs against the sellright_test database (DATABASE_URL must end with _test).
 * Uses the same dual-pool/withStore pattern as db/rls.test.ts:
 *   - owner pool (DATABASE_URL)        → seeding + teardown
 *   - app pool   (DATABASE_URL_NONOWNER or DATABASE_URL) → isolation assertions
 *
 * Covers:
 *   1. Seat-cap enforced — Nth+1 device is rejected with 'full'.
 *   2. Revoked license → 'notfound' / null.
 *   3. Expired license → 'notfound' / null (ra-009).
 *   4. Cross-store isolation — store A's license cannot be activated via store B's context.
 *   5. Forged/truncated activation token → findActivationByToken returns null.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { activateLicenseOnDevice, findActivationByToken } from './activations.js';
import { newActivationToken } from './tokens.js';

// Safety: refuse to run against anything but a *_test database.
const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(
    `activations test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`,
  );
}

// Two tenant UUIDs for isolation tests.
const STORE_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const STORE_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const ORDER_A = 'aaaaaaaa-aaaa-aaaa-aaaa-000000000001';
const ORDER_B = 'bbbbbbbb-bbbb-bbbb-bbbb-000000000001';
const LINE_A = 'aaaaaaaa-aaaa-aaaa-aaaa-000000000002';
const LINE_B = 'bbbbbbbb-bbbb-bbbb-bbbb-000000000002';

/** Wipe licensing rows and the two test stores (CASCADE takes the rest).
 *  Uses pool.query directly to avoid RLS filtering by app.current_store —
 *  the owner role (DATABASE_URL) can see all rows regardless of RLS. */
async function wipe() {
  // DELETE in FK order so referential integrity is not violated.
  await pool.query(`DELETE FROM license_activation WHERE store_id IN ($1, $2)`, [STORE_A, STORE_B]);
  await pool.query(`DELETE FROM license WHERE store_id IN ($1, $2)`, [STORE_A, STORE_B]);
  await pool.query(`DELETE FROM order_line WHERE store_id IN ($1, $2)`, [STORE_A, STORE_B]);
  await pool.query(`DELETE FROM "order" WHERE store_id IN ($1, $2)`, [STORE_A, STORE_B]);
  await pool.query(`DELETE FROM store WHERE id IN ($1, $2)`, [STORE_A, STORE_B]);
}

interface SeedOpts {
  storeId: string;
  orderId: string;
  lineId: string;
  licenseKey: string;
  appKey?: string;
  seats?: number;
  status?: string;
  /** ISO timestamp string — null means no expiry */
  expiresAt?: string | null;
}

/** Seed a minimal store + order + order_line + license row. */
async function seedLicense(opts: SeedOpts): Promise<string> {
  const {
    storeId,
    orderId,
    lineId,
    licenseKey,
    appKey = 'viewright',
    seats = 1,
    status = 'active',
    expiresAt = null,
  } = opts;

  await withStore(storeId, async (tx) => {
    // store (tenant registry — not RLS'd)
    await tx.execute(sql`
      INSERT INTO store (id, slug, name) VALUES (${storeId}, ${storeId}, ${storeId})
      ON CONFLICT (id) DO NOTHING
    `);
    // order (bare minimum columns, defaults cover the rest)
    await tx.execute(sql`
      INSERT INTO "order" (id, store_id, code, currency)
      VALUES (${orderId}, ${storeId}, ${orderId}, 'USD')
      ON CONFLICT (id) DO NOTHING
    `);
    // order_line
    await tx.execute(sql`
      INSERT INTO order_line (id, store_id, order_id, variant_sku, variant_name, quantity, unit_price, line_subtotal, line_total)
      VALUES (${lineId}, ${storeId}, ${orderId}, 'SKU', 'Test Product', 1, 9900, 9900, 9900)
      ON CONFLICT (id) DO NOTHING
    `);
    // license
    await tx.execute(sql`
      INSERT INTO license (id, store_id, order_id, order_line_id, app_key, license_key, status, seats, expires_at)
      VALUES (
        gen_random_uuid(), ${storeId}, ${orderId}, ${lineId},
        ${appKey}, ${licenseKey}, ${status}::license_status, ${seats},
        ${expiresAt}::timestamptz
      )
      ON CONFLICT DO NOTHING
    `);
  });

  // Return the license id for assertions.
  const result = await pool.query<{ id: string }>(
    `SELECT id FROM license WHERE license_key = $1 LIMIT 1`,
    [licenseKey],
  );
  return result.rows[0]!.id;
}

beforeEach(wipe);
afterEach(wipe);
afterAll(() => pool.end());

describe('activateLicenseOnDevice', () => {
  it('(1) seat-cap: Nth+1 device is rejected with full', async () => {
    const KEY = 'SR-VR-SEATCAP-TEST-0001';
    await seedLicense({ storeId: STORE_A, orderId: ORDER_A, lineId: LINE_A, licenseKey: KEY, seats: 2 });

    // Fill both seats.
    const r1 = await withStore(STORE_A, (tx) =>
      activateLicenseOnDevice(tx, { storeId: STORE_A, appKey: 'viewright', licenseKey: KEY, deviceId: 'device-1' }),
    );
    expect(r1.kind).toBe('ok');

    const r2 = await withStore(STORE_A, (tx) =>
      activateLicenseOnDevice(tx, { storeId: STORE_A, appKey: 'viewright', licenseKey: KEY, deviceId: 'device-2' }),
    );
    expect(r2.kind).toBe('ok');

    // Third device should be rejected.
    const r3 = await withStore(STORE_A, (tx) =>
      activateLicenseOnDevice(tx, { storeId: STORE_A, appKey: 'viewright', licenseKey: KEY, deviceId: 'device-3' }),
    );
    expect(r3.kind).toBe('full');
  });

  it('(1b) same-device re-activation does not consume an extra seat', async () => {
    const KEY = 'SR-VR-REACTIVATE-TEST-0001';
    await seedLicense({ storeId: STORE_A, orderId: ORDER_A, lineId: LINE_A, licenseKey: KEY, seats: 1 });

    const r1 = await withStore(STORE_A, (tx) =>
      activateLicenseOnDevice(tx, { storeId: STORE_A, appKey: 'viewright', licenseKey: KEY, deviceId: 'device-x' }),
    );
    expect(r1.kind).toBe('ok');

    // Same device again — should succeed (re-activation, not a new seat).
    const r2 = await withStore(STORE_A, (tx) =>
      activateLicenseOnDevice(tx, { storeId: STORE_A, appKey: 'viewright', licenseKey: KEY, deviceId: 'device-x' }),
    );
    expect(r2.kind).toBe('ok');
  });

  it('(2) revoked license returns notfound', async () => {
    const KEY = 'SR-VR-REVOKED-TEST-0001';
    await seedLicense({ storeId: STORE_A, orderId: ORDER_A, lineId: LINE_A, licenseKey: KEY, status: 'revoked' });

    const r = await withStore(STORE_A, (tx) =>
      activateLicenseOnDevice(tx, { storeId: STORE_A, appKey: 'viewright', licenseKey: KEY, deviceId: 'device-y' }),
    );
    expect(r.kind).toBe('notfound');
  });

  it('(3) expired license returns notfound (ra-009)', async () => {
    const KEY = 'SR-VR-EXPIRED-TEST-0001';
    // expiresAt is 2 days in the past.
    const pastTs = new Date(Date.now() - 2 * 86_400_000).toISOString();
    await seedLicense({ storeId: STORE_A, orderId: ORDER_A, lineId: LINE_A, licenseKey: KEY, expiresAt: pastTs });

    const r = await withStore(STORE_A, (tx) =>
      activateLicenseOnDevice(tx, { storeId: STORE_A, appKey: 'viewright', licenseKey: KEY, deviceId: 'device-z' }),
    );
    expect(r.kind).toBe('notfound');
  });

  it('(4) cross-store isolation: store B context cannot activate a store A license', async () => {
    const KEY = 'SR-VR-XSTORE-TEST-0001';
    await seedLicense({ storeId: STORE_A, orderId: ORDER_A, lineId: LINE_A, licenseKey: KEY });
    // Seed store B so withStore(STORE_B, ...) can set the context.
    await seedLicense({
      storeId: STORE_B,
      orderId: ORDER_B,
      lineId: LINE_B,
      licenseKey: 'SR-VR-XSTORE-DUMMY',
      appKey: 'viewright',
    });

    // Attempt to activate the store A license through store B's context.
    // withStore sets app.current_store = STORE_B, so RLS should hide the
    // license row that belongs to STORE_A — activateLicenseOnDevice should
    // return notfound.
    const r = await withStore(STORE_B, (tx) =>
      activateLicenseOnDevice(tx, { storeId: STORE_B, appKey: 'viewright', licenseKey: KEY, deviceId: 'device-w' }),
    );
    expect(r.kind).toBe('notfound');
  });
});

describe('findActivationByToken', () => {
  it('(5a) forged token returns null', async () => {
    const KEY = 'SR-VR-FORGED-TEST-0001';
    await seedLicense({ storeId: STORE_A, orderId: ORDER_A, lineId: LINE_A, licenseKey: KEY });

    // Activate so there is at least one real token in the DB.
    await withStore(STORE_A, (tx) =>
      activateLicenseOnDevice(tx, { storeId: STORE_A, appKey: 'viewright', licenseKey: KEY, deviceId: 'device-legit' }),
    );

    // A completely forged token not present in the DB.
    const forged = newActivationToken();
    const r = await withStore(STORE_A, (tx) =>
      findActivationByToken(tx, { appKey: 'viewright', activationToken: forged }),
    );
    expect(r).toBeNull();
  });

  it('(5b) truncated token returns null', async () => {
    const KEY = 'SR-VR-TRUNC-TEST-0001';
    await seedLicense({ storeId: STORE_A, orderId: ORDER_A, lineId: LINE_A, licenseKey: KEY });

    const act = await withStore(STORE_A, (tx) =>
      activateLicenseOnDevice(tx, { storeId: STORE_A, appKey: 'viewright', licenseKey: KEY, deviceId: 'device-legit2' }),
    );
    expect(act.kind).toBe('ok');
    const realToken = (act as { kind: 'ok'; activationToken: string }).activationToken;

    // Truncate the token — hash will not match.
    const truncated = realToken.slice(0, realToken.length - 4);
    const r = await withStore(STORE_A, (tx) =>
      findActivationByToken(tx, { appKey: 'viewright', activationToken: truncated }),
    );
    expect(r).toBeNull();
  });

  it('(3) expired license: findActivationByToken returns null (ra-009)', async () => {
    const KEY = 'SR-VR-TOKEXP-TEST-0001';
    // First activate with a valid (not-yet-expired) license.
    await seedLicense({ storeId: STORE_A, orderId: ORDER_A, lineId: LINE_A, licenseKey: KEY });

    const act = await withStore(STORE_A, (tx) =>
      activateLicenseOnDevice(tx, { storeId: STORE_A, appKey: 'viewright', licenseKey: KEY, deviceId: 'device-exp' }),
    );
    expect(act.kind).toBe('ok');
    const token = (act as { kind: 'ok'; activationToken: string }).activationToken;

    // Now expire the license directly in the DB.
    const pastTs = new Date(Date.now() - 86_400_000).toISOString();
    await withStore(STORE_A, async (tx) => {
      await tx.execute(sql`
        UPDATE license SET expires_at = ${pastTs}::timestamptz WHERE license_key = ${KEY}
      `);
    });

    const r = await withStore(STORE_A, (tx) =>
      findActivationByToken(tx, { appKey: 'viewright', activationToken: token }),
    );
    expect(r).toBeNull();
  });

  it('(2) revoked license: findActivationByToken returns null', async () => {
    const KEY = 'SR-VR-TOKREV-TEST-0001';
    await seedLicense({ storeId: STORE_A, orderId: ORDER_A, lineId: LINE_A, licenseKey: KEY });

    const act = await withStore(STORE_A, (tx) =>
      activateLicenseOnDevice(tx, { storeId: STORE_A, appKey: 'viewright', licenseKey: KEY, deviceId: 'device-rev' }),
    );
    expect(act.kind).toBe('ok');
    const token = (act as { kind: 'ok'; activationToken: string }).activationToken;

    // Revoke the license.
    await withStore(STORE_A, async (tx) => {
      await tx.execute(sql`
        UPDATE license SET status = 'revoked'::license_status WHERE license_key = ${KEY}
      `);
    });

    const r = await withStore(STORE_A, (tx) =>
      findActivationByToken(tx, { appKey: 'viewright', activationToken: token }),
    );
    expect(r).toBeNull();
  });
});
