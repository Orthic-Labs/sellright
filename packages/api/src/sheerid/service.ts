/**
 * PAR-04: SheerID verification lifecycle.
 *
 *   start  → pending row + hosted verify URL (customer is redirected there)
 *   done   → webhook handler fetches authoritative details via the provider
 *            adapter (network OUTSIDE the txn — no-external-io rule), then
 *            applyVerificationDetails writes everything in one tx
 *   revoke → admin action flips rows to 'revoked' and recomputes the customer
 *   expire → sweepExpiredVerifications flips stale 'success' rows to 'expired'
 *            and recomputes (call from a scheduler — see report)
 *
 * The customer-table fields (sheeridVerifications / activeVerifications /
 * verificationMetadata) remain the coupon-eligibility read model — the
 * verified_customer condition (money/coupon.ts) and session resolution read
 * them directly, so every write path here recomputes them. Imported-from-
 * Vendure customers carry those fields WITHOUT a backing row in
 * sheerid_verification; recompute keeps those legacy entries (matched by
 * verificationId absence) so an expiry sweep can't silently wipe an import.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import * as s from '../db/schema.js';
import { sheeridVerification } from '../db/schema-ops.js';
import { emitEvent } from '../webhooks/emit.js';
import {
  DEFAULT_SEGMENTS, SheerIdClient, SheerIdError,
  sheeridConfig,
  type SheerIdConfig, type SheerIdTransport, type SheerIdVerificationDetails,
} from './provider.js';

export interface VerificationEntry {
  programId: string;
  category: string;
  verificationId: string | null;
  status: 'verified';
  discountPercent: number;
  verifiedAt: string;
  expiresAt: string | null;
}

function cfgSegments(cfg: SheerIdConfig | null): Record<string, { category?: string; discountPercent?: number }> {
  return { ...DEFAULT_SEGMENTS, ...(cfg?.segments ?? {}) };
}

function ttlMs(cfg: SheerIdConfig | null): number {
  const days = cfg?.verificationTtlDays ?? 365;
  return Math.max(1, days) * 24 * 60 * 60 * 1000;
}

/** Resolve the configured default program id. */
export function sheeridProgram(cfg: SheerIdConfig | null, requested?: string): string | null {
  return requested ?? cfg?.programId ?? null;
}

/** Start a verification: persist a pending row and return the hosted URL the
 *  storefront sends the customer to. */
export async function startVerification(
  tx: Tx,
  storeId: string,
  customerId: string,
  programId: string,
): Promise<{ id: string }> {
  const [row] = await tx
    .insert(sheeridVerification)
    .values({ storeId, customerId, programId, status: 'pending' })
    .returning({ id: sheeridVerification.id });
  return { id: row!.id };
}

/**
 * Recompute the customer's three verification fields from (a) this store's
 * sheerid_verification rows and (b) pre-existing jsonb entries that have no
 * backing row (imported data). Called after every status change — success,
 * failure, revocation, expiry — so active_verifications is always the union
 * of currently-valid categories. This is what flips `verified_customer`
 * coupon eligibility.
 */
export async function recomputeCustomerVerifications(tx: Tx, storeId: string, customerId: string): Promise<string[]> {
  const [cust] = await tx
    .select({
      sheeridVerifications: s.customer.sheeridVerifications,
      verificationMetadata: s.customer.verificationMetadata,
    })
    .from(s.customer)
    .where(eq(s.customer.id, customerId))
    .limit(1);
  if (!cust) return [];

  // ALL rows for the customer (any status) — a jsonb entry whose
  // verificationId has a backing row is row-managed, so it drops whenever the
  // row is revoked/expired/failed, not only when it's superseded.
  const allRows = await tx
    .select()
    .from(sheeridVerification)
    .where(eq(sheeridVerification.customerId, customerId));
  const rows = allRows.filter((r) => r.status === 'success');

  const now = Date.now();
  const byVid = new Map(allRows.map((r) => [r.verificationId, r]));

  // Keep legacy jsonb entries that have no verificationId we manage (imported
  // rows) — but drop ones whose own expiresAt has passed.
  const legacy = (Array.isArray(cust.sheeridVerifications) ? (cust.sheeridVerifications as VerificationEntry[]) : [])
    .filter((e) => {
      if (e?.verificationId && byVid.has(e.verificationId)) return false; // row-managed
      if (e?.expiresAt && Date.parse(e.expiresAt) <= now) return false;   // expired legacy
      return e?.status === 'verified' && !!e?.category;
    });

  const fromRows: VerificationEntry[] = rows
    .filter((r) => r.category && (!r.expiresAt || r.expiresAt.getTime() > now))
    .map((r) => ({
      programId: r.programId,
      category: r.category!,
      verificationId: r.verificationId,
      status: 'verified' as const,
      discountPercent: r.discountPercent ?? 0,
      verifiedAt: r.updatedAt.toISOString(),
      expiresAt: r.expiresAt?.toISOString() ?? null,
    }));

  const entries = [...legacy, ...fromRows];
  const active = [...new Set(entries.map((e) => e.category))];
  const metadata: Record<string, unknown> = {};
  for (const e of entries) {
    metadata[e.category] = { discountPercent: e.discountPercent, expiresAt: e.expiresAt, lastVerified: e.verifiedAt };
  }

  await tx.update(s.customer).set({
    sheeridVerifications: entries as unknown as object,
    activeVerifications: active,
    verificationMetadata: metadata as object,
    updatedAt: new Date(),
  }).where(eq(s.customer.id, customerId));
  return active;
}

export interface ApplyResult {
  outcome: 'verified' | 'failed' | 'skipped' | 'revoked' | 'expired';
  customerId?: string;
  category?: string;
  verificationId: string;
  reason?: string;
}

/**
 * Persist the outcome of a SheerID verification (webhook-driven). Idempotent:
 * a redelivered webhook for an already-terminal row returns the recorded
 * outcome without rewriting the customer.
 */
export async function applyVerificationDetails(
  tx: Tx,
  storeId: string,
  details: SheerIdVerificationDetails,
  cfg: SheerIdConfig | null,
): Promise<ApplyResult> {
  const verificationId = String(details.verificationId ?? '');
  if (!verificationId) throw new SheerIdError('verificationId missing from SheerID details');

  // Idempotency: terminal rows are authoritative already.
  const [existing] = await tx
    .select()
    .from(sheeridVerification)
    .where(and(eq(sheeridVerification.verificationId, verificationId), eq(sheeridVerification.storeId, storeId)))
    .limit(1);
  if (existing && existing.status !== 'pending') {
    return {
      outcome: existing.status === 'success' ? 'verified' : existing.status === 'revoked' || existing.status === 'expired' ? existing.status : 'failed',
      customerId: existing.customerId ?? undefined,
      category: existing.category ?? undefined,
      verificationId,
      reason: 'duplicate delivery',
    };
  }

  const step = details.lastResponse?.currentStep;
  const segment = details.lastResponse?.segment;
  const customerId = details.personInfo?.metadata?.customerId ?? null;

  if (!step) throw new SheerIdError('currentStep missing from SheerID details');

  // Map segment → program/category via store config over the DD default map.
  const mapped = segment ? cfgSegments(cfg)[segment] : undefined;
  const category = mapped?.category ?? null;
  const discountPercent = mapped?.discountPercent ?? null;
  const programId = existing?.programId ?? cfg?.programId ?? segment ?? 'unknown';

  const succeeded = step === 'success' && !!category && !!customerId && customerId !== 'anonymous';

  const patch = {
    verificationId,
    customerId: customerId && customerId !== 'anonymous' ? customerId : null,
    category,
    discountPercent,
    programId,
    status: (succeeded ? 'success' : 'failed') as 'success' | 'failed',
    expiresAt: succeeded ? new Date(Date.now() + ttlMs(cfg)) : null,
    details: {
      currentStep: step, segment,
      subSegment: details.lastResponse?.subSegment ?? null,
    } as object,
    updatedAt: new Date(),
  };

  if (existing) {
    await tx.update(sheeridVerification).set(patch).where(eq(sheeridVerification.id, existing.id));
  } else {
    // The webhook only knows SheerID's verificationId + personInfo.customerId
    // — claim the customer's latest still-pending attempt row so the lifecycle
    // stays one row per attempt (start → success/failed) instead of leaving an
    // orphan 'pending' beside a new row.
    const claimed = customerId && customerId !== 'anonymous'
      ? await tx.execute(sql`
          UPDATE sheerid_verification SET
            verification_id = ${patch.verificationId},
            customer_id = ${patch.customerId},
            category = ${patch.category},
            discount_percent = ${patch.discountPercent},
            program_id = ${patch.programId},
            status = ${patch.status},
            expires_at = ${patch.expiresAt},
            details = ${JSON.stringify(patch.details)}::jsonb,
            updated_at = now()
          WHERE id = (
            SELECT id FROM sheerid_verification
            WHERE store_id = ${storeId} AND customer_id = ${patch.customerId}
              AND status = 'pending' AND verification_id IS NULL
            ORDER BY created_at DESC LIMIT 1
          )
          RETURNING id`)
      : { rows: [] as unknown[] };
    if (!claimed.rows.length) {
      await tx.insert(sheeridVerification).values({ storeId, ...patch });
    }
  }

  if (!customerId || customerId === 'anonymous') {
    return { outcome: 'skipped', verificationId, reason: 'no customer metadata' };
  }

  await recomputeCustomerVerifications(tx, storeId, customerId);
  await tx.insert(s.auditLog).values({
    storeId,
    actor: 'sheerid:webhook',
    entity: 'customer',
    entityId: customerId,
    action: succeeded ? 'verification_succeeded' : 'verification_failed',
    data: { verificationId, segment, category },
  });
  if (succeeded) {
    await emitEvent(tx, storeId, 'customer.verified', { customerId, category, verificationId });
  }
  return {
    outcome: succeeded ? 'verified' : 'failed',
    customerId, category: category ?? undefined, verificationId,
  };
}

/**
 * Revoke a customer's verified status in a category (fraud, abuse, SheerID
 * audit). Flips the row(s) to 'revoked' and recomputes — the customer's
 * verified_customer coupon eligibility drops on the next read.
 */
export async function revokeVerification(
  tx: Tx,
  storeId: string,
  args: { customerId: string; category: string },
  actor: string,
): Promise<{ revoked: number }> {
  const updated = await tx
    .update(sheeridVerification)
    .set({ status: 'revoked', updatedAt: new Date() })
    .where(and(
      eq(sheeridVerification.storeId, storeId),
      eq(sheeridVerification.customerId, args.customerId),
      eq(sheeridVerification.category, args.category),
      eq(sheeridVerification.status, 'success'),
    ))
    .returning({ id: sheeridVerification.id });

  // Also strip matching legacy (imported, row-less) entries by rewriting the
  // customer's fields — recompute keeps only still-valid categories.
  const [cust] = await tx
    .select({ sheeridVerifications: s.customer.sheeridVerifications })
    .from(s.customer).where(eq(s.customer.id, args.customerId)).limit(1);
  if (cust) {
    const entries = (Array.isArray(cust.sheeridVerifications) ? (cust.sheeridVerifications as VerificationEntry[]) : [])
      .filter((e) => e?.category !== args.category);
    await tx.update(s.customer).set({ sheeridVerifications: entries as unknown as object }).where(eq(s.customer.id, args.customerId));
  }
  await recomputeCustomerVerifications(tx, storeId, args.customerId);

  await tx.insert(s.auditLog).values({
    storeId, actor, entity: 'customer', entityId: args.customerId,
    action: 'verification_revoked', data: { category: args.category, rows: updated.length },
  });
  return { revoked: updated.length };
}

/**
 * Expiry sweep: flip 'success' rows past expires_at to 'expired' and recompute
 * each affected customer. Returns customer ids that lost a category — the
 * scheduler logs the count. Designed to be called per-store by a job.
 */
export async function sweepExpiredVerifications(tx: Tx, storeId: string): Promise<{ expired: number }> {
  const stale = await tx
    .update(sheeridVerification)
    .set({ status: 'expired', updatedAt: new Date() })
    .where(and(
      eq(sheeridVerification.storeId, storeId),
      eq(sheeridVerification.status, 'success'),
      sql`${sheeridVerification.expiresAt} IS NOT NULL AND ${sheeridVerification.expiresAt} < now()`,
    ))
    .returning({ customerId: sheeridVerification.customerId });
  const customers = [...new Set(stale.map((r) => r.customerId).filter((x): x is string => !!x))];
  for (const customerId of customers) {
    await recomputeCustomerVerifications(tx, storeId, customerId);
  }
  return { expired: stale.length };
}

/** Fetch details with a configured client (transport injectable for tests). */
export async function fetchVerificationDetails(
  cfg: SheerIdConfig,
  verificationId: string,
  transport?: SheerIdTransport,
): Promise<SheerIdVerificationDetails> {
  return new SheerIdClient(cfg, transport).getVerificationDetails(verificationId);
}

export { sheeridConfig, SheerIdError, SheerIdClient };
export type { SheerIdConfig, SheerIdTransport, SheerIdVerificationDetails };
