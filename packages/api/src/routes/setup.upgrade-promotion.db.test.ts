/**
 * WS-B upgrade path: 0075_promote_installation_admin.sql (plan §1.3/§1.4).
 *
 * An install that predates admin_user.is_installation_admin (0072) has real
 * admin_user rows but none flagged installation-admin. Two things must both
 * hold after upgrading past this migration:
 *   1. /v1/setup/status still 404s (it already did — gated on hasAnyAdmin(),
 *      not hasInstallationAdmin(); see setup-claim.db.test.ts) — checked here
 *      too as an end-to-end regression guard on the exact bug reported: a
 *      pre-upgrade install must never render the claim-only screen.
 *   2. Exactly one existing admin is promoted to installation-admin, chosen
 *      as the earliest-created admin holding an 'owner' membership (falling
 *      back to the earliest admin overall) — so recovery-kit download and
 *      future system operations stay reachable after upgrade.
 *   3. The existing admin's login keeps working — the migration only flips a
 *      boolean column, never touches password_hash/email.
 *
 * Runs against a *_test DB only (TRUNCATEs). Mirrors upgrade-compatibility.db.test.ts's
 * pattern of reading the real migration file's SQL out of drizzle/ and
 * executing it directly, but against REAL tables (not a temp shadow) — this
 * needs the actual admin_user rows visible to the real /v1/admin/login and
 * /v1/setup/status route handlers, not an isolated fixture.
 */
import { readFileSync } from 'node:fs';
import { OpenAPIHono } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool, unsafeUnscopedDb as db } from '../db/client.js';
import { env } from '../env.js';
import * as s from '../db/schema.js';
import { assertTestDatabase } from '../db/rls-test-utils.js';
import { hashPassword } from '../auth/password.js';
import { admin } from './admin.js';
import { setup } from './setup.js';

assertTestDatabase(process.env.DATABASE_URL ?? env.DATABASE_URL, 'setup.upgrade-promotion.db.test.ts');

const folder = new URL('../../drizzle/', import.meta.url);
const journal = JSON.parse(readFileSync(new URL('meta/_journal.json', folder), 'utf8')) as { entries: { tag: string }[] };
function migrationSql(suffix: string): string {
  const entry = journal.entries.find(({ tag }) => tag.endsWith(suffix));
  if (!entry) throw new Error(`Missing migration: ${suffix}`);
  return readFileSync(new URL(`${entry.tag}.sql`, folder), 'utf8');
}
const PROMOTE_MIGRATION = migrationSql('_promote_installation_admin');

const app = new OpenAPIHono();
app.route('/', setup);
app.route('/', admin);

async function wipe() {
  await pool.query('DELETE FROM "admin_user_store"');
  await pool.query('TRUNCATE "store" CASCADE');
  await pool.query('DELETE FROM "session"');
  await pool.query('DELETE FROM "admin_user"');
}

beforeEach(wipe);
afterAll(async () => {
  await wipe();
  await pool.end();
});

const PASSWORD = 'correct horse battery staple';

async function seedPreUpgradeInstall() {
  const passwordHash = await hashPassword(PASSWORD);
  const [store1] = await db.insert(s.store).values({ slug: 'legacy-store-1', name: 'Legacy Store 1' }).returning({ id: s.store.id });
  const [store2] = await db.insert(s.store).values({ slug: 'legacy-store-2', name: 'Legacy Store 2' }).returning({ id: s.store.id });

  // Explicit createdAt so ordering is deterministic regardless of statement
  // timing — Admin A is earliest overall but only ever 'staff', never
  // 'owner'; Admin B is the earliest OWNER; Admin C owns a different store
  // but was created after B.
  const t0 = new Date('2026-01-01T00:00:00Z');
  const [adminA] = await db.insert(s.adminUser).values({ email: 'staff-a@legacy.test', passwordHash, createdAt: new Date(t0.getTime()) }).returning({ id: s.adminUser.id });
  const [adminB] = await db.insert(s.adminUser).values({ email: 'owner-b@legacy.test', passwordHash, createdAt: new Date(t0.getTime() + 1000) }).returning({ id: s.adminUser.id });
  const [adminC] = await db.insert(s.adminUser).values({ email: 'owner-c@legacy.test', passwordHash, createdAt: new Date(t0.getTime() + 2000) }).returning({ id: s.adminUser.id });

  await db.insert(s.adminUserStore).values({ adminUserId: adminA!.id, storeId: store1!.id, role: 'staff' });
  await db.insert(s.adminUserStore).values({ adminUserId: adminB!.id, storeId: store1!.id, role: 'owner' });
  await db.insert(s.adminUserStore).values({ adminUserId: adminC!.id, storeId: store2!.id, role: 'owner' });

  return { adminA: adminA!.id, adminB: adminB!.id, adminC: adminC!.id };
}

describe('0075_promote_installation_admin.sql', () => {
  it('promotes the earliest-created admin holding an owner membership, not the earliest admin overall or a later owner', async () => {
    const { adminA, adminB, adminC } = await seedPreUpgradeInstall();

    // Sanity: this is a genuine pre-upgrade state — real admins, no
    // installation admin yet.
    const before = await db.select({ id: s.adminUser.id, isInstallationAdmin: s.adminUser.isInstallationAdmin }).from(s.adminUser);
    expect(before.every((a) => !a.isInstallationAdmin)).toBe(true);

    await pool.query(PROMOTE_MIGRATION);

    const promoted = await db.select().from(s.adminUser).where(eq(s.adminUser.isInstallationAdmin, true));
    expect(promoted).toHaveLength(1);
    expect(promoted[0]!.id).toBe(adminB);
    expect(promoted[0]!.id).not.toBe(adminA);
    expect(promoted[0]!.id).not.toBe(adminC);
  });

  it('falls back to the earliest admin overall when none holds an owner membership', async () => {
    const passwordHash = await hashPassword(PASSWORD);
    const t0 = new Date('2026-01-01T00:00:00Z');
    const [staffOnly1] = await db.insert(s.adminUser).values({ email: 'staff-only-1@legacy.test', passwordHash, createdAt: t0 }).returning({ id: s.adminUser.id });
    await db.insert(s.adminUser).values({ email: 'staff-only-2@legacy.test', passwordHash, createdAt: new Date(t0.getTime() + 1000) });

    await pool.query(PROMOTE_MIGRATION);

    const promoted = await db.select().from(s.adminUser).where(eq(s.adminUser.isInstallationAdmin, true));
    expect(promoted).toHaveLength(1);
    expect(promoted[0]!.id).toBe(staffOnly1!.id);
  });

  it('is a no-op on a truly fresh install with zero admins', async () => {
    await pool.query(PROMOTE_MIGRATION);
    const rows = await db.select().from(s.adminUser);
    expect(rows).toHaveLength(0);
  });

  it('is a no-op once an installation admin already exists (idempotent; never re-promotes or double-promotes)', async () => {
    const { adminB } = await seedPreUpgradeInstall();
    await pool.query(PROMOTE_MIGRATION);
    await pool.query(PROMOTE_MIGRATION); // re-run, e.g. a second deploy of the same release
    const promoted = await db.select().from(s.adminUser).where(eq(s.adminUser.isInstallationAdmin, true));
    expect(promoted).toHaveLength(1);
    expect(promoted[0]!.id).toBe(adminB);
  });

  it('END-TO-END: after promotion, GET /v1/setup/status 404s and the existing admin can still log in', async () => {
    await seedPreUpgradeInstall();

    // Before the migration runs, the install is ALREADY correctly gated
    // (hasAnyAdmin(), not hasInstallationAdmin() — the bug this whole
    // workstream fixes) — assert that first so a regression here is
    // unambiguous about which layer broke.
    const statusBefore = await app.request('/v1/setup/status');
    expect(statusBefore.status).toBe(404);

    await pool.query(PROMOTE_MIGRATION);

    const statusAfter = await app.request('/v1/setup/status');
    expect(statusAfter.status).toBe(404);

    const loginRes = await app.request('/v1/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'owner-b@legacy.test', password: PASSWORD }),
    });
    expect(loginRes.status).toBe(200);
    const body = await loginRes.json() as { token?: string; admin?: { email: string } };
    expect(body.admin?.email).toBe('owner-b@legacy.test');
    expect(body.token).toBeTruthy();
  });
});
