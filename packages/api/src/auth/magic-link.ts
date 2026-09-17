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
 * The drizzle schema's customerToken.kind enum does not list 'magic_link'
 * (schema-content.ts is owned by another lane — the DB CHECK is widened by
 * migration 0061), so inserts/updates here go through raw SQL, matching the
 * EMAIL_CHANGE_KIND precedent in routes/customer-tokens.ts.
 */
import { createHash, randomBytes } from 'node:crypto';
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

/**
 * Mint a one-time sign-in token for the customer. Returns the RAW token — only
 * its sha256 is persisted. Runs inside the caller's store-scoped tx so the
 * token row and the outbox email commit or roll back together.
 */
export async function mintMagicLink(tx: Tx, storeId: string, customerId: string, ttlMinutes: number): Promise<string> {
  const raw = randomBytes(32).toString('base64url');
  await tx.execute(sql`
    INSERT INTO customer_token (store_id, customer_id, kind, token_hash, expires_at)
    VALUES (${storeId}, ${customerId}, ${MAGIC_LINK_KIND}, ${hashToken(raw)}, now() + (${ttlMinutes} * interval '1 minute'))
  `);
  return raw;
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
