/**
 * Passwordless customer sign-in ("magic link"), ported upstream from RightSites.
 *
 * Flow: POST /auth/magic-link/request mints a one-time customer_token row
 * (kind 'magic_link', sha256 hash stored — raw token only ever lives in the
 * emailed URL) and enqueues the sign-in email through the durable outbox.
 * POST /auth/magic-link/consume exchanges it for a session.
 *
 * Feature is OFF unless configured: store.config.auth.magicLink (boolean) wins;
 * env.MAGIC_LINK_ENABLED is the deployment default. The endpoints 409 when
 * disabled so an unconfigured deployment exposes nothing.
 *
 * The same email carries a short one-time code (#350) for platforms where the link cannot open the app or storefront.
 * It lives on the SAME customer_token row (payload.codeHash, sha256 salted with the customer id — the raw code only ever
 * lives in the email), so the link and the code share one TTL and one used_at: redeeming either burns both. Only the
 * newest request's code stays redeemable (older rows lose theirs), and POST /auth/magic-link/consume-code is throttled
 * per email in routes/auth.ts, which keeps a 6-digit code out of practical guessing range inside the TTL.
 *
 * The drizzle schema's customerToken.kind enum does not list 'magic_link'
 * (schema-content.ts is owned by another lane — the DB CHECK is widened by
 * migration 0061), so inserts/updates here go through raw SQL, matching the
 * EMAIL_CHANGE_KIND precedent in routes/customer-tokens.ts.
 */
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { env } from '../env.js';
import { storeAuthConfig } from './session.js';

export const MAGIC_LINK_KIND = 'magic_link';

const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

export interface MagicLinkPolicy {
  enabled: boolean;
  ttlMinutes: number;
  /** Path appended to the store's resolved storefront URL in the email. */
  path: string;
}

/** Per-store magic-link policy: store.config.auth.* overrides env defaults. */
export function magicLinkPolicy(config: unknown): MagicLinkPolicy {
  const auth = storeAuthConfig(config);
  const enabled = typeof auth.magicLink === 'boolean' ? auth.magicLink : env.MAGIC_LINK_ENABLED === 'true';
  const ttlMinutes =
    typeof auth.magicLinkTtlMinutes === 'number' && Number.isFinite(auth.magicLinkTtlMinutes) && auth.magicLinkTtlMinutes > 0
      ? auth.magicLinkTtlMinutes
      : env.MAGIC_LINK_TTL_MINUTES;
  const rawPath =
    typeof auth.magicLinkPath === 'string' && auth.magicLinkPath.trim() ? auth.magicLinkPath.trim() : env.MAGIC_LINK_PATH;
  return { enabled, ttlMinutes, path: rawPath.startsWith('/') ? rawPath : `/${rawPath}` };
}

/** Digits in the emailed sign-in code. */
export const MAGIC_CODE_DIGITS = 6;

/** A fresh uniformly random numeric code, zero-padded ("004217"). */
export function generateMagicCode(): string {
  return String(randomInt(0, 10 ** MAGIC_CODE_DIGITS)).padStart(MAGIC_CODE_DIGITS, '0');
}

/** What the shopper typed → the canonical code, or null when it cannot be one. Spaces and hyphens ("123 456") are
 *  ignored; anything else non-numeric or the wrong length is refused. */
export function normalizeMagicCode(input: string): string | null {
  const digits = input.replace(/[\s-]/g, '');
  return /^\d{6}$/.test(digits) ? digits : null;
}

// Salted with the customer so one leaked table does not give a single rainbow table for every account.
const hashCode = (customerId: string, code: string) => createHash('sha256').update(`magic-link-code:${customerId}:${code}`).digest('hex');

/**
 * Mint a one-time sign-in token and its companion code for the customer. Returns the RAW token and the code — only
 * their hashes are persisted. Runs inside the caller's store-scoped tx so the token row and the outbox email commit or
 * roll back together. Any code minted earlier for this customer stops being redeemable (its link keeps working), so at
 * most one code is live per customer.
 */
export async function mintMagicLinkWithCode(tx: Tx, storeId: string, customerId: string, ttlMinutes: number): Promise<{ raw: string; code: string }> {
  const raw = randomBytes(32).toString('base64url');
  const code = generateMagicCode();
  await tx.execute(sql`
    UPDATE customer_token SET payload = payload - 'codeHash'
    WHERE store_id = ${storeId} AND customer_id = ${customerId} AND kind = ${MAGIC_LINK_KIND}
      AND used_at IS NULL AND payload->>'codeHash' IS NOT NULL
  `);
  await tx.execute(sql`
    INSERT INTO customer_token (store_id, customer_id, kind, token_hash, payload, expires_at)
    VALUES (${storeId}, ${customerId}, ${MAGIC_LINK_KIND}, ${hashToken(raw)}, ${JSON.stringify({ codeHash: hashCode(customerId, code) })}::jsonb,
            now() + (${ttlMinutes} * interval '1 minute'))
  `);
  return { raw, code };
}

/** Link-only mint (the code is minted too but discarded). Kept for callers that only need the URL token. */
export async function mintMagicLink(tx: Tx, storeId: string, customerId: string, ttlMinutes: number): Promise<string> {
  return (await mintMagicLinkWithCode(tx, storeId, customerId, ttlMinutes)).raw;
}

/**
 * Atomically consume a magic-link token. A single conditional UPDATE ... WHERE
 * used_at IS NULL ... RETURNING — under concurrency Postgres serializes on the
 * row lock, so two simultaneous redemptions of the same token produce exactly
 * ONE marked row and therefore exactly one session (the RightSites original
 * checked used_at then updated in separate statements, which could issue two
 * sessions for one link). Returns the customer id, or null when the token is
 * unknown, expired, or already used — callers map null to one generic 409.
 */
export async function consumeMagicLink(tx: Tx, storeId: string, rawToken: string): Promise<{ customerId: string } | null> {
  const r = await tx.execute(sql`
    UPDATE customer_token
    SET used_at = now()
    WHERE token_hash = ${hashToken(rawToken)}
      AND kind = ${MAGIC_LINK_KIND}
      AND store_id = ${storeId}
      AND used_at IS NULL
      AND expires_at > now()
    RETURNING customer_id AS "customerId"
  `);
  const row = r.rows[0] as { customerId: string } | undefined;
  return row ?? null;
}

/**
 * Atomically redeem the emailed code for the customer it was sent to. Same single conditional UPDATE as the link
 * (used_at IS NULL, unexpired, store-scoped) on the same row, so a code redeemed here has also burned its link and a
 * redeemed link has burned its code; concurrent redemptions yield one winner. Callers have already locked the customer
 * row and throttled the email. Returns the customer id, or null for a wrong, expired, used or superseded code.
 */
export async function consumeMagicLinkCode(tx: Tx, storeId: string, customerId: string, code: string): Promise<{ customerId: string } | null> {
  const r = await tx.execute(sql`
    UPDATE customer_token
    SET used_at = now()
    WHERE store_id = ${storeId}
      AND customer_id = ${customerId}
      AND kind = ${MAGIC_LINK_KIND}
      AND used_at IS NULL
      AND expires_at > now()
      AND payload->>'codeHash' = ${hashCode(customerId, code)}
    RETURNING customer_id AS "customerId"
  `);
  const row = r.rows[0] as { customerId: string } | undefined;
  return row ?? null;
}
