/**
 * DB tests for the one-click install claim flow (plan §1.3/§1.4).
 *
 * Covers:
 *   1. issueSetupClaimToken mints a hashed, 7-day token and invalidates any
 *      prior unused one.
 *   2. claimInstallation creates the installation admin + owner membership
 *      in one transaction, reusing an existing unclaimed store when present.
 *   3. Without an unclaimed store, claimInstallation mints a placeholder
 *      store, unpublished.
 *   4. CONCURRENCY: two concurrent claims with the same token → exactly one
 *      installation administrator, exactly one owner membership, the loser
 *      gets InvalidClaimTokenError.
 *   5. Every /v1/setup/* route 404s once ANY admin_user exists — not just
 *      once an installation admin exists (issueSetupClaimToken and
 *      claimInstallation both reject; this is what keeps an upgraded
 *      pre-WS-B install, whose real admins have no installation-admin flag
 *      yet, from ever being treated as "unclaimed").
 *   6. Expired and already-used tokens are rejected.
 *
 * Runs against a *_test DB only (TRUNCATEs store CASCADE + admin_user).
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, isNull } from 'drizzle-orm';
import { pool, unsafeUnscopedDb as db } from '../db/client.js';
import { env } from '../env.js';
import * as s from '../db/schema.js';
import {
  claimInstallation,
  hasAnyAdmin,
  hasInstallationAdmin,
  hashClaimToken,
  InvalidClaimTokenError,
  issueSetupClaimToken,
  SetupAlreadyClaimedError,
} from './setup-claim.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`setup-claim test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);
}

async function wipe() {
  await pool.query('DELETE FROM "admin_user_store"');
  await pool.query('TRUNCATE "store" CASCADE');
  await pool.query('DELETE FROM "setup_claim_token"');
  await pool.query('DELETE FROM "admin_user"');
}

beforeEach(async () => {
  await wipe();
});

afterAll(async () => {
  await wipe();
  await pool.end();
});

describe('issueSetupClaimToken', () => {
  it('mints a hashed token with a 7-day expiry and invalidates prior unused tokens', async () => {
    const first = await issueSetupClaimToken();
    const rowsAfterFirst = await db.select().from(s.setupClaimToken);
    expect(rowsAfterFirst).toHaveLength(1);
    expect(rowsAfterFirst[0]!.tokenHash).toBe(hashClaimToken(first.token));
    const days = (rowsAfterFirst[0]!.expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);

    const second = await issueSetupClaimToken();
    const rowsAfterSecond = await db.select().from(s.setupClaimToken);
    expect(rowsAfterSecond).toHaveLength(1);
    expect(rowsAfterSecond[0]!.tokenHash).toBe(hashClaimToken(second.token));
    expect(second.token).not.toBe(first.token);
  });

  it('refuses to issue once an installation admin exists', async () => {
    const { token } = await issueSetupClaimToken();
    await claimInstallation({ token, email: 'owner@example.com', name: 'Owner', password: 'x'.repeat(12) });
    await expect(issueSetupClaimToken()).rejects.toBeInstanceOf(SetupAlreadyClaimedError);
  });

  // The bug this guards against: an upgraded pre-WS-B install has real
  // admin_user rows but NONE flagged installation-admin (until the
  // post-migrate promotion in 0075_promote_installation_admin.sql runs).
  // Gating on hasInstallationAdmin() alone would issue a claim link for an
  // already-live install.
  it('refuses to issue once ANY admin_user exists, even with no installation admin', async () => {
    await db.insert(s.adminUser).values({ email: 'legacy-owner@example.com' });
    expect(await hasInstallationAdmin()).toBe(false);
    expect(await hasAnyAdmin()).toBe(true);
    await expect(issueSetupClaimToken()).rejects.toBeInstanceOf(SetupAlreadyClaimedError);
  });
});

describe('claimInstallation', () => {
  it('creates the installation admin + a placeholder store when none is unclaimed', async () => {
    const { token } = await issueSetupClaimToken();
    const result = await claimInstallation({
      token, email: 'Owner@Example.com', name: 'Ada Owner', password: 'correct horse battery',
    });

    const [admin] = await db.select().from(s.adminUser).where(eq(s.adminUser.id, result.adminId));
    expect(admin?.email).toBe('owner@example.com'); // normalized
    expect(admin?.name).toBe('Ada Owner');
    expect(admin?.isInstallationAdmin).toBe(true);

    const [membership] = await db
      .select()
      .from(s.adminUserStore)
      .where(eq(s.adminUserStore.adminUserId, result.adminId));
    expect(membership?.storeId).toBe(result.storeId);
    expect(membership?.role).toBe('owner');

    const [store] = await db.select().from(s.store).where(eq(s.store.id, result.storeId));
    expect(store?.slug).toBe(result.storeSlug);
    expect((store?.config as { published?: boolean } | null)?.published).toBe(false);

    const [claimedToken] = await db.select().from(s.setupClaimToken);
    expect(claimedToken?.usedAt).not.toBeNull();

    const [audit] = await db.select().from(s.auditLog).where(eq(s.auditLog.storeId, result.storeId));
    expect(audit?.action).toBe('claim');
    expect(audit?.entity).toBe('installation');
  });

  it('reuses an existing unclaimed (bootstrap) store instead of minting a new one', async () => {
    const [bootstrap] = await db
      .insert(s.store)
      .values({ slug: 'bootstrap', name: 'Bootstrap Store', config: { hostnames: ['shop.example.net'] } })
      .returning({ id: s.store.id, slug: s.store.slug });

    const { token } = await issueSetupClaimToken();
    const result = await claimInstallation({
      token, email: 'owner@example.com', name: 'Owner', password: 'correct horse battery',
    });

    expect(result.storeId).toBe(bootstrap!.id);
    expect(result.storeSlug).toBe('bootstrap');
    const [store] = await db.select().from(s.store).where(eq(s.store.id, bootstrap!.id));
    // Pre-existing config is preserved, published is forced false regardless.
    expect((store?.config as { hostnames?: string[] })?.hostnames).toEqual(['shop.example.net']);
    expect((store?.config as { published?: boolean })?.published).toBe(false);
  });

  // Under the current invariant, a store already owned by SOME admin can only
  // coexist with a valid, still-issuable claim token in a manufactured test
  // state (issueSetupClaimToken/claimInstallation both refuse the moment ANY
  // admin_user row exists — see hasAnyAdmin()). This proves claimInstallation
  // enforces that guard independently, not just issueSetupClaimToken — same
  // pattern as the "already claimed" test below, generalized from
  // "installation admin exists" to "any admin exists at all".
  it('refuses to claim once ANY admin_user exists, even one unrelated to installation status, with a fresh valid token row', async () => {
    const [owned] = await db.insert(s.store).values({ slug: 'owned', name: 'Owned Store' }).returning({ id: s.store.id });
    const [otherAdmin] = await db.insert(s.adminUser).values({ email: 'staff@example.com' }).returning({ id: s.adminUser.id });
    await db.insert(s.adminUserStore).values({ adminUserId: otherAdmin!.id, storeId: owned!.id, role: 'owner' });

    // Bypass issueSetupClaimToken's own guard (already covered above) to
    // prove claimInstallation checks independently.
    const tokenHash = hashClaimToken('manufactured-token-value');
    await db.insert(s.setupClaimToken).values({ tokenHash, expiresAt: new Date(Date.now() + 60_000) });

    await expect(
      claimInstallation({ token: 'manufactured-token-value', email: 'owner@example.com', name: 'Owner', password: 'correct horse battery' }),
    ).rejects.toBeInstanceOf(SetupAlreadyClaimedError);
  });

  it('rejects an invalid token', async () => {
    await expect(
      claimInstallation({ token: 'not-a-real-token', email: 'a@example.com', name: 'A', password: 'x'.repeat(12) }),
    ).rejects.toBeInstanceOf(InvalidClaimTokenError);
  });

  it('rejects an expired token', async () => {
    const tokenHash = hashClaimToken('expired-token-value');
    await db.insert(s.setupClaimToken).values({ tokenHash, expiresAt: new Date(Date.now() - 1000) });
    await expect(
      claimInstallation({ token: 'expired-token-value', email: 'a@example.com', name: 'A', password: 'x'.repeat(12) }),
    ).rejects.toBeInstanceOf(InvalidClaimTokenError);
  });

  it('rejects a token that was already used', async () => {
    const { token } = await issueSetupClaimToken();
    await claimInstallation({ token, email: 'a@example.com', name: 'A', password: 'x'.repeat(12) });
    // Reset installation-admin state so the SECOND call fails on the token
    // check specifically, not the earlier hasInstallationAdmin() guard.
    await db.update(s.adminUser).set({ isInstallationAdmin: false });
    await expect(
      claimInstallation({ token, email: 'b@example.com', name: 'B', password: 'x'.repeat(12) }),
    ).rejects.toBeInstanceOf(InvalidClaimTokenError);
  });

  it('refuses once an installation admin already exists, even with a fresh valid token row', async () => {
    const { token: firstToken } = await issueSetupClaimToken();
    await claimInstallation({ token: firstToken, email: 'a@example.com', name: 'A', password: 'x'.repeat(12) });
    // Manually insert a second unused token row (bypassing issueSetupClaimToken's
    // own guard) to prove claimInstallation ALSO checks independently.
    const secondHash = hashClaimToken('second-token-value');
    await db.insert(s.setupClaimToken).values({ tokenHash: secondHash, expiresAt: new Date(Date.now() + 60_000) });
    await expect(
      claimInstallation({ token: 'second-token-value', email: 'b@example.com', name: 'B', password: 'x'.repeat(12) }),
    ).rejects.toBeInstanceOf(SetupAlreadyClaimedError);
  });

  it('CONCURRENCY: two concurrent claims with the same token produce exactly one installation admin', async () => {
    const { token } = await issueSetupClaimToken();
    const attempt = (email: string) =>
      claimInstallation({ token, email, name: 'Racer', password: 'x'.repeat(12) }).then(
        (v) => ({ ok: true as const, v }),
        (e) => ({ ok: false as const, e }),
      );

    const [a, b] = await Promise.all([attempt('a@example.com'), attempt('b@example.com')]);
    const outcomes = [a, b];
    const winners = outcomes.filter((o) => o.ok);
    const losers = outcomes.filter((o) => !o.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect((losers[0] as { e: unknown }).e).toBeInstanceOf(InvalidClaimTokenError);

    expect(await hasInstallationAdmin()).toBe(true);
    const admins = await db.select().from(s.adminUser).where(eq(s.adminUser.isInstallationAdmin, true));
    expect(admins).toHaveLength(1);
    const memberships = await db.select().from(s.adminUserStore);
    expect(memberships).toHaveLength(1);
    expect(memberships[0]!.role).toBe('owner');
  });

  it('leaves no unused token behind after a successful claim', async () => {
    const { token } = await issueSetupClaimToken();
    await claimInstallation({ token, email: 'a@example.com', name: 'A', password: 'x'.repeat(12) });
    const unused = await db.select().from(s.setupClaimToken).where(isNull(s.setupClaimToken.usedAt));
    expect(unused).toHaveLength(0);
  });
});
