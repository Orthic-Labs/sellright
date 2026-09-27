/**
 * One-click install: claim token issuance + redemption (plan §1.3/§1.4).
 *
 * Two authorities exist after this module runs:
 *   - installation administrator (admin_user.is_installation_admin) — system
 *     operations (backup/restore trigger, recovery-kit download, add-store).
 *   - store owner (admin_user_store.role = 'owner') — unchanged, per-store.
 * `claimInstallation` grants BOTH to the same new admin_user in one
 * transaction, because the person claiming a fresh install is, by
 * definition, both.
 *
 * Concurrency: two requests racing to claim with the DIFFERENCE tokens
 * cannot happen (issueSetupClaimToken invalidates every prior unused token
 * before minting a new one, and /v1/setup/* 404s once ANY admin_user exists
 * — see hasAnyAdmin()). Two requests racing with the SAME token are decided
 * by the atomic `UPDATE ... WHERE used_at IS NULL
 * RETURNING id`: Postgres row-level locking on that UPDATE means exactly one
 * concurrent transaction observes a returned row; the loser sees zero rows
 * and fails with InvalidClaimTokenError. The partial unique index added in
 * drizzle/0072_installation_admin.sql
 * (admin_user_installation_admin_unique) is a second, independent backstop:
 * even a bug in the token logic could never commit two installation admins.
 */
import { createHash, randomBytes } from 'node:crypto';
import { eq, isNull, sql } from 'drizzle-orm';
import { unsafeUnscopedDb as db } from '../db/client.js';
import * as s from '../db/schema.js';
import { hashPassword } from './password.js';
import { normalizeEmail } from './email.js';

const TOKEN_BYTES = 16; // 128 bits, plan §1.4
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days, plan §1.4
const PLACEHOLDER_STORE_NAME = 'My Store';

export function generateClaimToken(): string {
  return randomBytes(TOKEN_BYTES).toString('hex');
}

export function hashClaimToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** True once any admin_user holds installation-wide authority. NOT the right
 *  check for "has this install been claimed" — see hasAnyAdmin() below, which
 *  every `/v1/setup/*` route actually gates on. Kept for callers that
 *  genuinely need the installation-admin fact itself (e.g. tests asserting a
 *  claim succeeded). */
export async function hasInstallationAdmin(): Promise<boolean> {
  const [row] = await db
    .select({ id: s.adminUser.id })
    .from(s.adminUser)
    .where(eq(s.adminUser.isInstallationAdmin, true))
    .limit(1);
  return !!row;
}

/**
 * True once ANY admin_user row exists — this, not hasInstallationAdmin(), is
 * the correct "has this install been claimed" signal. An EXISTING deployment
 * upgraded to a release that introduced admin_user.is_installation_admin
 * (0072_installation_admin.sql) has real admins but none flagged
 * installation-admin until the post-migrate promotion (see
 * 0075_promote_installation_admin.sql) runs. Gating `/v1/setup/*` on
 * hasInstallationAdmin() alone would read every such upgrade as "unclaimed",
 * 200 the claim screen, and lock every existing admin out behind it. Every
 * `/v1/setup/*` route (and issueSetupClaimToken/claimInstallation
 * themselves) MUST check this and refuse once true — the setup surface only
 * ever exists for a genuinely empty, brand-new install.
 */
export async function hasAnyAdmin(): Promise<boolean> {
  const [row] = await db.select({ id: s.adminUser.id }).from(s.adminUser).limit(1);
  return !!row;
}

/** Thrown by every /v1/setup/* handler once claimed (or mid-claim, if a
 *  second request loses the race) — 404, not 403: an outside observer must
 *  not be able to distinguish "already claimed" from "route never existed". */
export class SetupAlreadyClaimedError extends Error {
  readonly httpStatus = 404 as const;
  constructor(message = 'not found') {
    super(message);
    this.name = 'SetupAlreadyClaimedError';
  }
}

export class InvalidClaimTokenError extends Error {
  readonly httpStatus = 404 as const;
  constructor(message = 'not found') {
    super(message);
    this.name = 'InvalidClaimTokenError';
  }
}

/**
 * `sellright setup-link` calls this (via a thin script — see
 * scripts/setup-link.ts). Only while unclaimed. Invalidates any prior unused
 * token so at most one claim link is ever live. Returns the ONE-TIME plaintext
 * token; only its SHA-256 hash is persisted.
 */
export async function issueSetupClaimToken(): Promise<{ token: string; expiresAt: Date }> {
  if (await hasAnyAdmin()) throw new SetupAlreadyClaimedError();
  const token = generateClaimToken();
  const tokenHash = hashClaimToken(token);
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);
  await db.transaction(async (tx) => {
    await tx.delete(s.setupClaimToken).where(isNull(s.setupClaimToken.usedAt));
    await tx.insert(s.setupClaimToken).values({ tokenHash, expiresAt });
  });
  return { token, expiresAt };
}

export interface ClaimInput {
  token: string;
  email: string;
  name: string;
  password: string;
}

export interface ClaimResult {
  adminId: string;
  storeId: string;
  storeSlug: string;
}

function randomSlug(): string {
  return `store-${randomBytes(4).toString('hex')}`;
}

/**
 * Redeem a claim token: create the installation administrator, attach them
 * as 'owner' of the first store (reusing an existing store with no owner —
 * e.g. the appliance's BOOTSTRAP_STORE_SLUG store — if one exists, otherwise
 * minting a minimal placeholder store), and invalidate the token. One
 * transaction; see the module doc comment for the concurrency argument.
 */
export async function claimInstallation(input: ClaimInput): Promise<ClaimResult> {
  if (await hasAnyAdmin()) throw new SetupAlreadyClaimedError();

  const email = normalizeEmail(input.email);
  const name = input.name.trim();
  if (!name) throw new InvalidClaimTokenError('name is required'); // route validates length; defensive here too
  const tokenHash = hashClaimToken(input.token);
  // Argon2id hashing is deliberately done OUTSIDE the transaction: it's pure
  // CPU work with no DB dependency, and holding a Postgres transaction open
  // across ~100ms of hashing would needlessly extend lock/connection hold
  // time under concurrent claim attempts.
  const passwordHash = await hashPassword(input.password);

  return db.transaction(async (tx) => {
    // Atomic claim of the token — see module doc comment. `sql` template
    // params are parameterized by drizzle, not string-interpolated.
    const claimed = await tx.execute(sql`
      UPDATE "setup_claim_token" SET used_at = now()
      WHERE token_hash = ${tokenHash} AND used_at IS NULL AND expires_at > now()
      RETURNING id`);
    if ((claimed.rowCount ?? 0) === 0) throw new InvalidClaimTokenError();

    // Prefer an existing store nobody owns yet (the appliance's bootstrap
    // store) over minting a new one. FOR UPDATE ... SKIP LOCKED so this can
    // never deadlock against another concurrent claim attempt on the same
    // store row (only one will ever reach here, per the token gate above,
    // but this keeps the query safe standalone too).
    const unclaimed = await tx.execute(sql`
      SELECT store.id, store.slug FROM "store"
      LEFT JOIN "admin_user_store" ON "admin_user_store".store_id = "store".id
      WHERE "admin_user_store".store_id IS NULL
      ORDER BY "store".slug
      LIMIT 1
      FOR UPDATE OF "store" SKIP LOCKED`);

    let storeId: string;
    let storeSlug: string;
    if (unclaimed.rows.length > 0) {
      const row = unclaimed.rows[0] as { id: string; slug: string };
      storeId = row.id;
      storeSlug = row.slug;
      // Newly claimed stores stay private until Publish (plan §1.5), even if
      // this is a pre-existing bootstrap store whose config predates the
      // `published` field (isStorePublished's `?? true` default would
      // otherwise leave it public through onboarding).
      await tx.execute(sql`
        UPDATE "store" SET config = COALESCE(config, '{}'::jsonb) || '{"published": false}'::jsonb
        WHERE id = ${storeId}`);
    } else {
      storeSlug = randomSlug();
      const [created] = await tx
        .insert(s.store)
        .values({ slug: storeSlug, name: PLACEHOLDER_STORE_NAME, config: { published: false } })
        .returning({ id: s.store.id, slug: s.store.slug });
      storeId = created!.id;
      storeSlug = created!.slug;
    }

    const [createdAdmin] = await tx
      .insert(s.adminUser)
      .values({ email, name, passwordHash, isInstallationAdmin: true })
      .returning({ id: s.adminUser.id });
    const adminId = createdAdmin!.id;

    await tx.insert(s.adminUserStore).values({ adminUserId: adminId, storeId, role: 'owner' });

    // audit_log (unlike store/admin_user/admin_user_store — see rls-tables.test.ts's
    // EXEMPT set) DOES have FORCE ROW LEVEL SECURITY, and this transaction runs on
    // unsafeUnscopedDb (correctly — no store exists yet at the top of this
    // function), so app.current_store was never set. Under the restricted
    // NOSUPERUSER/NOBYPASSRLS runtime role this insert would silently violate the
    // tenant policy and throw (masked in tests that connect as a privileged
    // Postgres role, which bypasses RLS entirely) — set it explicitly, now that
    // storeId is known, exactly like withStore()/runStoreTransaction() do.
    await tx.execute(sql`SELECT set_config('app.current_store', ${storeId}, true)`);

    await tx.insert(s.auditLog).values({
      storeId,
      actor: email,
      entity: 'installation',
      entityId: adminId,
      action: 'claim',
    });

    return { adminId, storeId, storeSlug };
  });
}
