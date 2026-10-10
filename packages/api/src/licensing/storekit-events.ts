/**
 * StoreKit stage log writer (de-fork plan 2.9; migration 0088).
 *
 * Every StoreKit operation passes up to three stages, each recorded as one
 * `storekit_event` row:
 *
 *   verify  signature / environment verification of an Apple JWS
 *   apply   the state-changing work (purchase/licence mutation) — recorded in
 *           the SAME transaction as that work, so a row exists iff it committed
 *   replay  a re-delivery of an already-processed notification (no-op)
 *
 * Resolution rules (the health gate counts apply failures with
 * `resolved_by_event_id IS NULL`):
 *
 *   - a successful `verify` resolves only earlier `verify` failures of the same
 *     tenant-scoped operation;
 *   - a COMMITTED successful `apply` resolves earlier `apply` failures of the
 *     same operation, in that transaction;
 *   - `replay` rows never resolve anything, and a successful verify never
 *     resolves an apply failure (apply failures stay unresolved across any
 *     number of verify successes until an apply commits).
 *
 * Operation identity is tenant-scoped: uniqueness is (store_id, operation_id).
 *   - verify rows of a notification use `payload:<sha256 of the signed payload>`
 *     — the only identity that exists when verification itself fails (this
 *     relies on Apple re-sending the same signedPayload bytes on retry:
 *     *unverified* against Apple's documentation; a re-signed retry only
 *     leaves a NON-gating verify failure unresolved);
 *   - apply and replay rows use `notification:<notificationUUID>`, taken from
 *     the VERIFIED payload, so an apply failure is resolved by the committed
 *     apply of the same notification even if the retry's bytes differ;
 *   - the link endpoint uses `link:<sha256 of app key + signed transaction>`
 *     for both its stages.
 */
import { createHash } from 'node:crypto';
import { and, eq, gt, isNull, ne, sql } from 'drizzle-orm';
import { withStore, type Tx } from '../db/client.js';
import { withSavepoint } from '../db/savepoint.js';
import * as s from '../db/schema.js';
import { err as logErr } from '../lib/logger.js';

export type StoreKitStage = 'verify' | 'apply' | 'replay';
export type StoreKitOutcome = 'ok' | 'failed';

export interface StoreKitEventInput {
  storeId: string;
  operationId: string;
  stage: StoreKitStage;
  outcome: StoreKitOutcome;
  error?: string | null;
}

const digest = (v: string) => createHash('sha256').update(v).digest('hex');

/** Verify-stage operation id for an App Store Server Notification (digest of the signed payload). */
export const storeKitPayloadOperationId = (signedPayload: string): string => `payload:${digest(signedPayload)}`;

/** Apply/replay-stage operation id: the VERIFIED notificationUUID. */
export const storeKitNotificationOperationId = (notificationUUID: string): string => `notification:${notificationUUID}`;

/** Operation id for a link-storekit call (digest of the signed transaction + app key). */
export const storeKitLinkOperationId = (appKey: string, signedTransactionInfo: string): string =>
  `link:${digest(`${appKey}\n${signedTransactionInfo}`)}`;

const MAX_ERROR = 500;
/**
 * Error text safe to persist: drizzle wraps driver errors in a message that
 * embeds the full SQL and its bound parameters ("Failed query: … params: …"),
 * which can carry customer data — so prefer the innermost cause's message and
 * cut anything from a `params:` marker on.
 */
export function storeKitErrorText(e: unknown): string {
  let cur: unknown = e;
  for (let i = 0; i < 5 && cur instanceof Error && cur.cause instanceof Error; i++) cur = cur.cause;
  const msg = cur instanceof Error ? cur.message : String(cur);
  return msg.split(/\nparams:/)[0]!.slice(0, MAX_ERROR);
}

/**
 * Record one stage event inside the caller's transaction and apply the
 * stage-aware resolution rule. For `apply` success the caller MUST pass the
 * transaction that performs the apply so the resolution commits with it.
 */
export async function recordStoreKitEvent(tx: Tx, input: StoreKitEventInput): Promise<{ id: string; resolved: number }> {
  const [row] = await tx.insert(s.storekitEvent).values({
    storeId: input.storeId,
    operationId: input.operationId,
    stage: input.stage,
    outcome: input.outcome,
    error: input.outcome === 'failed' ? (input.error ?? 'unspecified').slice(0, MAX_ERROR) : null,
  }).returning({ id: s.storekitEvent.id });
  const id = row!.id;
  // replay never resolves; a failure resolves nothing.
  if (input.outcome !== 'ok' || input.stage === 'replay') return { id, resolved: 0 };
  const resolved = await tx.update(s.storekitEvent)
    .set({ resolvedByEventId: id })
    .where(and(
      eq(s.storekitEvent.storeId, input.storeId),
      eq(s.storekitEvent.operationId, input.operationId),
      eq(s.storekitEvent.stage, input.stage), // same stage only
      eq(s.storekitEvent.outcome, 'failed'),
      isNull(s.storekitEvent.resolvedByEventId),
      ne(s.storekitEvent.id, id),
    ))
    .returning({ id: s.storekitEvent.id });
  return { id, resolved: resolved.length };
}

/**
 * Record an event in its own short transaction (verify outcomes, and apply
 * failures recorded after the apply transaction rolled back). Instrumentation
 * must never change the HTTP outcome, so a failure to record is logged and
 * swallowed.
 */
export async function recordStoreKitEventDetached(input: StoreKitEventInput): Promise<void> {
  try {
    await withStore(input.storeId, (tx) => recordStoreKitEvent(tx, input));
  } catch (e) {
    logErr.error('storekit_event write failed', e, { stage: input.stage, outcome: input.outcome });
  }
}

/**
 * Record an event inside the caller's (customer-affecting) transaction WITHOUT
 * letting an instrumentation failure roll that work back: the insert runs in a
 * savepoint, and a failure is logged and swallowed. A successful insert (and
 * its stage-aware resolution) still commits atomically with the caller's work.
 */
export async function recordStoreKitEventSafe(tx: Tx, input: StoreKitEventInput): Promise<void> {
  try {
    await withSavepoint(tx, () => recordStoreKitEvent(tx, input));
  } catch (e) {
    logErr.error('storekit_event write failed (savepoint rolled back)', e, { stage: input.stage, outcome: input.outcome });
  }
}

/**
 * Unauthenticated verify failures are bounded: one row per (store, operation)
 * per hour (operation = payload digest, so a replayed junk body adds nothing),
 * plus the caller's per-(ip, app) budget (`allow`). Returns whether a row was
 * written. Never throws.
 */
export async function recordStoreKitVerifyFailureBounded(
  input: Omit<StoreKitEventInput, 'stage' | 'outcome'>,
  allow: () => Promise<boolean>,
): Promise<boolean> {
  try {
    const dup = await withStore(input.storeId, async (tx) => (await tx.select({ id: s.storekitEvent.id }).from(s.storekitEvent).where(and(
      eq(s.storekitEvent.storeId, input.storeId), eq(s.storekitEvent.operationId, input.operationId),
      eq(s.storekitEvent.stage, 'verify'), eq(s.storekitEvent.outcome, 'failed'),
      gt(s.storekitEvent.createdAt, sql`now() - interval '1 hour'`),
    )).limit(1)).length > 0);
    if (dup) return false;
    if (!(await allow())) return false;
    await recordStoreKitEventDetached({ ...input, stage: 'verify', outcome: 'failed' });
    return true;
  } catch (e) {
    logErr.error('storekit verify-failure bound check failed', e);
    return false;
  }
}
