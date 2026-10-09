/**
 * Pending-effects engine (de-fork plan 2.8; SETTLEMENT-OPS.md section 8).
 * Kind-agnostic: it stores, claims, fences and finishes `order_pending_effect`
 * rows; WHAT an effect does lives in handlers registered by kind (handlers.ts
 * for the built-ins, or a plugin). Which effects an operation may create is the
 * policy in ops.ts, enforced by recordSettlementOperation() (record.ts).
 *
 * Execution contract
 *  - Local effects mutate only the database. Their mutations commit in the SAME
 *    transaction as the row's `done` status (one transaction per effect), so a
 *    crash can never leave "mutated but not done" or "done but not mutated".
 *  - External effects call a provider with the effect id as the idempotency key;
 *    the receipt (applied_operation_receipt) is written in the same transaction
 *    as `done`, and a retry that finds a receipt skips the call.
 *  - A worker claims a row with a fresh claim_token + claimed_at. A claim older
 *    than STALE_CLAIM_MS is reclaimed with a NEW token. EVERY write to the row
 *    checks the token: a slow ex-claimant's write matches zero rows, its
 *    transaction rolls back (its local mutations vanish too), and the new owner's
 *    outcome stands. SKIP LOCKED plus the row lock an in-flight effect holds
 *    means a live holder is never reclaimed mid-commit.
 *  - Failures retry at least(2^attempts * 30 s, 1 h); after MAX_ATTEMPTS (or a
 *    precondition that can never hold) the row is `terminal` and an
 *    `admin_review` row is added for the same operation. Terminal is never
 *    retried automatically; it is admin-visible (audit row, `effect.terminal`
 *    event, the payment-reconciliation list).
 *  - Within one operation a later-rank effect is not claimed while an earlier
 *    one is pending/processing (ops.ts EFFECT_KINDS order).
 *  - `executeEffectsNow` claims and runs just-recorded rows inside the
 *    recording transaction (the default for the built-in paid paths): observable
 *    behaviour is identical to the old direct calls, and a handler failure
 *    aborts the whole settlement exactly as before. `deferred` recording leaves
 *    the rows pending for the worker (jobs/scheduler.ts, scripts/effects-worker.ts).
 */
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { pool, withStore, type Tx } from '../../db/client.js';
import * as s from '../../db/schema.js';
import { emitEvent } from '../../webhooks/emit.js';
import { EFFECT_KINDS, effectRank, type EffectKind } from './ops.js';

export const STALE_CLAIM_MS = 5 * 60_000;
/** After this many failed attempts an effect is terminal (SETTLEMENT-OPS 8.4). */
export const MAX_ATTEMPTS = 8;
/** Retry delay after `attempts` failures: least(2^attempts * 30 s, 1 h). */
export const backoffSeconds = (attempts: number): number => Math.min(2 ** Math.max(attempts, 1) * 30, 3600);

export type EffectStatus = 'pending' | 'processing' | 'done' | 'terminal';
export type EffectRow = typeof s.orderPendingEffect.$inferSelect;
export type EffectMode = 'inline' | 'deferred';

export interface EffectRequest {
  kind: EffectKind;
  payloadVersion?: number;
  /** Immutable once written: identities (invoice_id, order_id, ...), never derived state. */
  payload?: Readonly<Record<string, unknown>>;
  /** Reserved for final-by-design terminal rows: `{action:'final', actor:'system:baseline', rule_id}`. Held outcomes leave it NULL. */
  resolution?: { action: 'final'; actor: string; rule_id: string };
}

/**
 * Handler result: nothing = done; `done` carries the effect's `result`;
 * `retry` = not ready yet (mutate nothing; a `horizonMs` retry is not counted
 * against MAX_ATTEMPTS and goes terminal once first_failed_at + horizon passes);
 * `terminal` = a precondition that can never hold.
 */
export type EffectOutcome = void
  | { done: { result: Record<string, unknown> } }
  | { retry: { reason: string; delayMs?: number; horizonMs?: number } }
  | { terminal: string };

export interface LocalEffectHandler {
  mode?: 'local';
  run(tx: Tx, effect: EffectRow): Promise<EffectOutcome>;
}
export interface ExternalEffectHandler {
  mode: 'external';
  /** Provider call. MUST pass `ctx.idempotencyKey` (the effect id) to the provider. */
  call(effect: EffectRow, ctx: { idempotencyKey: string }): Promise<{ providerRef: string }>;
  /** Optional local follow-up committed in the same transaction as the receipt and `done`. */
  complete?(tx: Tx, effect: EffectRow, providerRef: string): Promise<void>;
}
export type EffectHandler = LocalEffectHandler | ExternalEffectHandler;

const handlers = new Map<string, EffectHandler>();
export function registerEffectHandler(kind: string, handler: EffectHandler): void { handlers.set(kind, handler); }
export function unregisterEffectHandler(kind: string): void { handlers.delete(kind); }
export function getEffectHandler(kind: string): EffectHandler | undefined { return handlers.get(kind); }
export function isExternalEffectKind(kind: string): boolean { return handlers.get(kind)?.mode === 'external'; }

/** Thrown inside a transaction whose claim was lost; the tx rolls back and the new owner's outcome stands. */
export class EffectFencedError extends Error {
  constructor(public readonly effectId: string) { super(`effect ${effectId} claim was lost (fenced)`); }
}

const errText = (e: unknown): string => String(e instanceof Error ? e.message : e).slice(0, 2000);

/**
 * Insert the effect rows for one operation in the caller's transaction (always
 * `pending`; `admin_review` is born `terminal`). Returns ONLY the rows this call
 * created: a replay of the same fact hits the UNIQUE identity and creates nothing.
 * Called by recordSettlementOperation(); the operation row must already exist (FK).
 */
export async function enqueueEffects(
  tx: Tx, storeId: string, op: { kind: string; id: string }, requests: readonly EffectRequest[],
): Promise<EffectRow[]> {
  const created: EffectRow[] = [];
  for (const req of requests) {
    const review = req.kind === 'admin_review';
    const now = new Date();
    const [row] = await tx.insert(s.orderPendingEffect).values({
      storeId, operationKind: op.kind, operationId: op.id, effectKind: req.kind,
      payloadVersion: req.payloadVersion ?? 1, payload: (req.payload ?? {}) as Record<string, unknown>,
      status: review ? 'terminal' : 'pending',
      lastError: review ? String((req.payload as { reason?: unknown } | undefined)?.reason ?? 'held for review') : null,
      firstFailedAt: review ? now : null,
      resolution: req.resolution ?? null,
    }).onConflictDoNothing({
      target: [s.orderPendingEffect.storeId, s.orderPendingEffect.operationKind, s.orderPendingEffect.operationId, s.orderPendingEffect.effectKind],
    }).returning();
    if (!row) continue;
    created.push(row);
    if (review) await announceTerminal(tx, row);
  }
  return created;
}

/**
 * Claim and run the given just-recorded effects INSIDE the caller's transaction,
 * in rank order. External effects are skipped (they are never run inside a
 * database transaction). A missing handler or a handler failure aborts the
 * caller's transaction — the settlement and its effects roll back together.
 */
export async function executeEffectsNow(tx: Tx, effectIds: readonly string[]): Promise<void> {
  if (!effectIds.length) return;
  const rows = await tx.select().from(s.orderPendingEffect)
    .where(and(inArray(s.orderPendingEffect.id, [...effectIds]), eq(s.orderPendingEffect.status, 'pending')));
  for (const row of rows.sort((a, b) => effectRank(a.effectKind) - effectRank(b.effectKind))) {
    const handler = handlers.get(row.effectKind);
    if (handler?.mode === 'external') continue;
    if (!handler) throw new Error(`no handler registered for effect kind "${row.effectKind}"`);
    const [claimed] = await tx.update(s.orderPendingEffect).set({
      status: 'processing', claimToken: randomUUID(), claimedAt: new Date(), attempts: row.attempts + 1, updatedAt: new Date(),
    }).where(and(eq(s.orderPendingEffect.id, row.id), eq(s.orderPendingEffect.status, 'pending'))).returning();
    if (!claimed) continue;
    await applyOutcome(tx, claimed, await handler.run(tx, claimed));
  }
}

async function applyOutcome(tx: Tx, row: EffectRow, out: EffectOutcome): Promise<'done' | 'retry' | 'terminal'> {
  if (out && 'retry' in out) return markRetryOrTerminal(tx, row, out.retry);
  if (out && 'terminal' in out) { await markTerminal(tx, row, out.terminal); return 'terminal'; }
  const result = out && 'done' in out ? out.done.result : {};
  const done = await tx.update(s.orderPendingEffect)
    .set({ status: 'done', lastError: null, result, updatedAt: new Date() })
    .where(and(eq(s.orderPendingEffect.id, row.id), eq(s.orderPendingEffect.claimToken, row.claimToken!), eq(s.orderPendingEffect.status, 'processing')))
    .returning({ id: s.orderPendingEffect.id });
  if (!done.length) throw new EffectFencedError(row.id);
  return 'done';
}

async function markRetryOrTerminal(
  tx: Tx, row: EffectRow, retry: { reason: string; delayMs?: number; horizonMs?: number },
): Promise<'retry' | 'terminal'> {
  const now = new Date();
  const firstFailedAt = row.firstFailedAt ?? now;
  const horizonPassed = retry.horizonMs != null && now.getTime() - firstFailedAt.getTime() > retry.horizonMs;
  // "not ready" retries (horizonMs) are bounded by time; failures by attempts.
  if (horizonPassed || (retry.horizonMs == null && row.attempts >= MAX_ATTEMPTS)) {
    await markTerminal(tx, row, retry.reason);
    return 'terminal';
  }
  const upd = await tx.update(s.orderPendingEffect).set({
    status: 'pending', claimToken: null, claimedAt: null,
    nextAttemptAt: new Date(now.getTime() + (retry.delayMs ?? backoffSeconds(row.attempts) * 1000)),
    lastError: retry.reason, firstFailedAt, updatedAt: now,
  }).where(and(eq(s.orderPendingEffect.id, row.id), eq(s.orderPendingEffect.claimToken, row.claimToken!), eq(s.orderPendingEffect.status, 'processing')))
    .returning({ id: s.orderPendingEffect.id });
  if (!upd.length) throw new EffectFencedError(row.id);
  return 'retry';
}

async function markTerminal(tx: Tx, row: EffectRow, reason: string): Promise<void> {
  const now = new Date();
  const upd = await tx.update(s.orderPendingEffect).set({
    status: 'terminal', claimToken: null, claimedAt: null, lastError: reason,
    firstFailedAt: row.firstFailedAt ?? now, updatedAt: now,
  }).where(and(eq(s.orderPendingEffect.id, row.id), eq(s.orderPendingEffect.claimToken, row.claimToken!), eq(s.orderPendingEffect.status, 'processing')))
    .returning();
  if (!upd.length) throw new EffectFencedError(row.id);
  await announceTerminal(tx, upd[0]!);
  if (row.effectKind !== 'admin_review') {
    // The operation needs a human: add the review task for the same operation (idempotent).
    await enqueueEffects(tx, row.storeId, { kind: row.operationKind, id: row.operationId },
      [{ kind: 'admin_review', payload: { reason, failedEffectKind: row.effectKind, failedEffectId: row.id } }]);
  }
}

/** Admin-visible signal for a terminal effect: audit row + webhook event (same transaction as the transition). */
async function announceTerminal(tx: Tx, row: EffectRow): Promise<void> {
  await tx.insert(s.auditLog).values({
    storeId: row.storeId, actor: 'system:pending-effects', entity: 'order_pending_effect', entityId: row.id,
    action: 'effect_terminal',
    data: {
      needsReconciliation: true, operationKind: row.operationKind, operationId: row.operationId,
      effectKind: row.effectKind, attempts: row.attempts, reason: row.lastError,
    },
  });
  await emitEvent(tx, row.storeId, 'effect.terminal', {
    id: row.id, operationKind: row.operationKind, operationId: row.operationId, effectKind: row.effectKind, reason: row.lastError,
  });
}

/** Persist the licence an operation issued/linked (the identity links outlive delayed issuance). */
export async function recordOperationLicense(tx: Tx, storeId: string, op: { kind: string; id: string }, licenseId: string): Promise<void> {
  await tx.update(s.settlementOperation).set({ licenseId }).where(and(
    eq(s.settlementOperation.storeId, storeId), eq(s.settlementOperation.operationKind, op.kind), eq(s.settlementOperation.operationId, op.id),
  ));
}

// ── worker side ──────────────────────────────────────────────────────────────

const RANK_ARRAY = sql`ARRAY[${sql.join(EFFECT_KINDS.map((k) => sql`${k}`), sql`, `)}]::text[]`;

/**
 * Claim a batch of due effects for one store: due `pending` rows, plus
 * `processing` rows whose claim is older than STALE_CLAIM_MS (reclaimed with a
 * NEW claim_token). A row is skipped while an earlier-rank sibling of the same
 * operation is still pending/processing. Commits immediately — no transaction
 * is held across handler execution.
 */
export async function claimDueEffects(storeId: string, limit = 50): Promise<EffectRow[]> {
  return withStore(storeId, async (tx) => {
    const res = await tx.execute(sql`
      UPDATE order_pending_effect e
      SET status = 'processing', claim_token = gen_random_uuid(), claimed_at = now(),
          attempts = e.attempts + 1, updated_at = now()
      WHERE e.id IN (
        SELECT c.id FROM order_pending_effect c
        WHERE c.store_id = ${storeId}
          AND ((c.status = 'pending' AND c.next_attempt_at <= now())
            OR (c.status = 'processing' AND c.claimed_at < now() - make_interval(secs => ${STALE_CLAIM_MS / 1000})))
          AND NOT EXISTS (
            SELECT 1 FROM order_pending_effect p
            WHERE p.store_id = c.store_id AND p.operation_kind = c.operation_kind AND p.operation_id = c.operation_id
              AND p.id <> c.id AND p.status IN ('pending', 'processing') AND p.effect_kind <> 'admin_review'
              AND coalesce(array_position(${RANK_ARRAY}, p.effect_kind), ${EFFECT_KINDS.length})
                < coalesce(array_position(${RANK_ARRAY}, c.effect_kind), ${EFFECT_KINDS.length}))
        ORDER BY c.next_attempt_at, c.created_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED)
      RETURNING e.id`);
    const ids = (res.rows as Array<{ id: string }>).map((r) => r.id);
    if (!ids.length) return [];
    const rows = await tx.select().from(s.orderPendingEffect).where(inArray(s.orderPendingEffect.id, ids));
    return rows.sort((a, b) => effectRank(a.effectKind) - effectRank(b.effectKind));
  });
}

export type ProcessResult = 'done' | 'retry' | 'terminal' | 'stale';

/** Execute one claimed effect (worker path). Never throws for handler failures; they become retry/terminal. */
export async function processClaimedEffect(effect: EffectRow): Promise<ProcessResult> {
  const handler = handlers.get(effect.effectKind);
  try {
    if (!handler) return await failClaimed(effect, `no handler registered for effect kind "${effect.effectKind}"`);
    if (handler.mode === 'external') return await processExternal(effect, handler);
    return await withStore(effect.storeId, async (tx): Promise<ProcessResult> => {
      const [cur] = await claimedRow(tx, effect);
      if (!cur) return 'stale';
      return applyOutcome(tx, cur, await handler.run(tx, cur));
    });
  } catch (e) {
    if (e instanceof EffectFencedError) return 'stale';
    return failClaimed(effect, errText(e));
  }
}

const claimedRow = (tx: Tx, effect: EffectRow) => tx.select().from(s.orderPendingEffect).where(and(
  eq(s.orderPendingEffect.id, effect.id), eq(s.orderPendingEffect.claimToken, effect.claimToken!), eq(s.orderPendingEffect.status, 'processing'),
)).limit(1).for('update');

async function processExternal(effect: EffectRow, handler: ExternalEffectHandler): Promise<ProcessResult> {
  // 1. fenced look-up of an existing receipt: a present receipt means the provider call already happened
  const existing = await withStore(effect.storeId, async (tx) => {
    const [cur] = await claimedRow(tx, effect);
    if (!cur) return 'stale' as const;
    const [receipt] = await tx.select().from(s.appliedOperationReceipt).where(eq(s.appliedOperationReceipt.effectId, effect.id)).limit(1);
    return receipt ?? null;
  });
  if (existing === 'stale') return 'stale';
  // 2. provider call outside any transaction, keyed by the effect id (skipped when a receipt exists)
  const providerRef = existing ? existing.providerRef : (await handler.call(effect, { idempotencyKey: effect.id })).providerRef;
  // 3. receipt + local follow-up + `done` in ONE transaction
  return withStore(effect.storeId, async (tx): Promise<ProcessResult> => {
    const [cur] = await claimedRow(tx, effect);
    if (!cur) return 'stale';
    await tx.insert(s.appliedOperationReceipt).values({ effectId: effect.id, storeId: effect.storeId, providerRef }).onConflictDoNothing();
    if (handler.complete) await handler.complete(tx, cur, providerRef);
    return applyOutcome(tx, cur, undefined);
  });
}

/** Record a failed attempt (fenced): retry with backoff, or terminal once attempts are exhausted. */
async function failClaimed(effect: EffectRow, reason: string): Promise<ProcessResult> {
  return withStore(effect.storeId, async (tx): Promise<ProcessResult> => {
    try {
      return await markRetryOrTerminal(tx, effect, { reason });
    } catch (e) {
      if (e instanceof EffectFencedError) return 'stale';
      throw e;
    }
  });
}

/** One worker pass over every store. Rank gating needs one round per rank step, so loop a few rounds. */
export async function runEffectsPass(opts: { limit?: number; rounds?: number; log?: (m: string) => void } = {}): Promise<Record<ProcessResult, number>> {
  const totals: Record<ProcessResult, number> = { done: 0, retry: 0, terminal: 0, stale: 0 };
  const stores = await pool.query<{ id: string }>('SELECT id FROM store');
  for (const st of stores.rows) {
    for (let round = 0; round < (opts.rounds ?? EFFECT_KINDS.length); round++) {
      const claimed = await claimDueEffects(st.id, opts.limit ?? 50);
      if (!claimed.length) break;
      for (const effect of claimed) totals[await processClaimedEffect(effect)]++;
      opts.log?.(`[effects] ${st.id}: ${claimed.length} attempted`);
    }
  }
  return totals;
}

// ── admin side ───────────────────────────────────────────────────────────────

/** Effects needing attention: terminal rows, and pending rows that have already failed once. */
export async function listEffectsNeedingAttention(tx: Tx, limit = 100) {
  return tx.select().from(s.orderPendingEffect)
    // review queue: status='terminal' AND resolution IS NULL AND resolved_by IS NULL (plus retrying rows)
    .where(sql`(${s.orderPendingEffect.status} = 'terminal' AND ${s.orderPendingEffect.resolution} IS NULL AND ${s.orderPendingEffect.resolvedBy} IS NULL) OR (${s.orderPendingEffect.status} = 'pending' AND ${s.orderPendingEffect.firstFailedAt} IS NOT NULL)`)
    .orderBy(desc(s.orderPendingEffect.updatedAt), asc(s.orderPendingEffect.id)).limit(limit);
}

/** Put a terminal effect back in the queue (admin retry). `admin_review` rows are tasks, not executable effects. */
export async function requeueTerminalEffect(tx: Tx, effectId: string): Promise<boolean> {
  const rows = await tx.update(s.orderPendingEffect).set({
    status: 'pending', attempts: 0, claimToken: null, claimedAt: null, lastError: null, firstFailedAt: null,
    nextAttemptAt: new Date(), updatedAt: new Date(),
  }).where(and(eq(s.orderPendingEffect.id, effectId), eq(s.orderPendingEffect.status, 'terminal'),
    sql`${s.orderPendingEffect.effectKind} <> 'admin_review'`)).returning({ id: s.orderPendingEffect.id });
  return rows.length > 0;
}
