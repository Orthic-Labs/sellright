// Global lock set helper (de-fork plan 3.3 prerequisite; STOREKIT.md §5.2–§5.3).
//
// withLockedSet plans the rows a set of subjects touches, takes the locks in the
// global class order (L1 purchase advisories → L2 licence rows → L3 order rows →
// L4 order_reservation rows), re-plans under the locks, and restarts only when the
// plan grew. Callers receive a HeldLocks brand that only this module can mint.
//
// Classes implemented here: L2 (license), L3 (order), L4 (order_reservation). L1
// (purchase advisory) is used by the StoreKit fork only (purchaseLockKey/
// acquirePurchaseLocks, exported for it). L4 rows are the reservations of the planned
// orders (migration 0091, PAYMENT-TIMING §3.5): planned with their orders, locked after
// L3 and after the re-plan check, so a reservation can never be locked before its order.
import { AsyncLocalStorage } from 'node:async_hooks';
import { sql } from 'drizzle-orm';
import { and, eq, inArray } from 'drizzle-orm';
import { withStore, type Tx } from './client.js';
import * as s from './schema.js';

declare const heldBrand: unique symbol;
export type HeldLocks = { readonly [heldBrand]: true };

/** What withLockedSet promised and actually took, keyed by the HeldLocks object (STOREKIT §5.5). */
interface Witness {
  tx: Tx | null;                        // the transaction the locks were taken in (set once fn starts)
  advisoryHashes: bigint[];             // L1 keys acquired with pg_advisory_xact_lock
  promisedLicenseIds: string[];         // L2 rows promised by the plan
  promisedOrderIds: string[];           // L3 rows promised by the plan
  lockedRows: Set<string>;              // `license:<id>` / `order:<id>` taken by lockRows in this tx
}
const witnesses = new WeakMap<object, Witness>();
const mintHeld = (w: Witness): HeldLocks => {
  const held = {} as HeldLocks;
  witnesses.set(held, w);
  return held;
};

/** Thrown by assertHeld when a hook runs without the locks its plan promised. */
export class HeldLocksMissing extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HeldLocksMissing';
  }
}

const lockGuardActive = () => process.env.NODE_ENV !== 'production';

/** X-49: the set whose fn is running, scoped to its async context. `tx` identifies the transaction. */
interface LockSetContext { tx: Tx; held: HeldLocks; plan: LockPlanContribution }
const lockSetContext = new AsyncLocalStorage<LockSetContext>();

/** The set held on `tx` (its plan and HeldLocks), or null when no withLockedSet fn is running on `tx`. */
export function currentLockSet(tx: Tx): { held: HeldLocks; plan: LockPlanContribution } | null {
  const ctx = lockSetContext.getStore();
  return ctx && ctx.tx === tx ? { held: ctx.held, plan: ctx.plan } : null;
}

/**
 * Runtime guard (STOREKIT §5.5, debug/test builds only; a no-op in production): the held brand must come
 * from withLockedSet in this same transaction, every promised L1 advisory key must be granted to this
 * backend in pg_locks, and every promised L2/L3 row must have been taken by lockRows in this transaction.
 * Row locks are not visible in pg_locks, so rows are checked by bookkeeping, not by the catalogue.
 */
export async function assertHeld(tx: Tx, held: HeldLocks): Promise<void> {
  if (!lockGuardActive()) return;
  const w = witnesses.get(held);
  if (!w) throw new HeldLocksMissing('HeldLocks was not minted by withLockedSet');
  if (w.tx !== tx) throw new HeldLocksMissing('HeldLocks belongs to a different transaction');
  for (const id of w.promisedLicenseIds) {
    if (!w.lockedRows.has(`license:${id.toLowerCase()}`)) throw new HeldLocksMissing(`license ${id} not locked by this set`);
  }
  for (const id of w.promisedOrderIds) {
    if (!w.lockedRows.has(`order:${id.toLowerCase()}`)) throw new HeldLocksMissing(`order ${id} not locked by this set`);
  }
  if (w.advisoryHashes.length) {
    const { rows } = await tx.execute(
      sql`SELECT classid::text AS hi, objid::text AS lo FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND granted`,
    );
    const granted = new Set(
      (rows as { hi: string; lo: string }[]).map((r) => BigInt.asIntN(64, (BigInt(r.hi) << 32n) | BigInt(r.lo)).toString()),
    );
    for (const h of w.advisoryHashes) {
      if (!granted.has(BigInt.asIntN(64, h).toString())) throw new HeldLocksMissing(`purchase advisory ${h} not granted`);
    }
  }
}

export type PurchaseId = { storeId: string; environment: string; originalTransactionId: string };

export type LockSubject =
  | { kind: 'order'; orderId: string }
  | { kind: 'notification'; purchase: PurchaseId }
  | { kind: 'link'; purchases: readonly PurchaseId[] }
  | { kind: 'customer'; customerId: string; scope?: 'all' | 'orders' }
  | { kind: 'checkout'; sourceLicenseId?: string }
  | { kind: 'loyalty'; customerId: string };

export interface LockPlanContribution {
  readonly purchases: readonly PurchaseId[];
  readonly licenseIds: readonly string[];
  readonly orderIds: readonly string[];
  /** Contributors never add reservations; the planner derives L4 from the planned orders. */
  readonly reservationIds?: readonly string[];
}

export class LockSetGrew extends Error {
  constructor(readonly grown: LockPlanContribution) {
    super('lock set grew under lock');
    this.name = 'LockSetGrew';
  }
}

export class LockSetUnstable extends Error {
  constructor() {
    super('lock set unstable after restarts');
    this.name = 'LockSetUnstable';
  }
}

const EMPTY: LockPlanContribution = { purchases: [], licenseIds: [], orderIds: [], reservationIds: [] };

/** Pure key derivation for the StoreKit purchase lock (STOREKIT §5.2, verbatim). */
export const purchaseLockKey = (p: PurchaseId): string =>
  `${p.storeId}:${p.environment}:${p.originalTransactionId}`;

/** L1: transaction advisory locks, sorted ascending by the 64-bit hash, de-duplicated. */
export async function acquirePurchaseLocks(tx: Tx, purchases: readonly PurchaseId[]): Promise<bigint[]> {
  const keys = [...new Set(purchases.map(purchaseLockKey))];
  if (!keys.length) return [];
  const { rows } = await tx.execute(
    sql`SELECT hashtextextended(k, 0)::text AS h FROM unnest(${sql.param(keys)}::text[]) AS k`,
  );
  const hashes = [...new Set((rows as { h: string }[]).map((r) => BigInt(r.h)))].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  for (const h of hashes) await tx.execute(sql`SELECT pg_advisory_xact_lock(${h.toString()}::bigint)`);
  return hashes;
}

const canonical = (id: string) => id.toLowerCase();

/** Unlocked order id lookup by public code (plan input for an order set; never locks). */
export async function orderIdByCode(storeId: string, code: string): Promise<string | null> {
  const [row] = await withStore(storeId, (tx) =>
    tx.select({ id: s.order.id }).from(s.order).where(and(eq(s.order.storeId, storeId), eq(s.order.code, code))).limit(1));
  return row?.id ?? null;
}

/** L2/L3/L4: one statement per id, sorted by canonical lowercase uuid (= Postgres uuid byte order). */
async function lockRows(
  tx: Tx,
  table: 'license' | 'order' | 'order_reservation',
  storeId: string,
  ids: readonly string[],
  taken: Set<string>,
): Promise<void> {
  const sorted = [...new Set(ids.map(canonical))].sort();
  for (const id of sorted) {
    if (table === 'license') {
      await tx.execute(sql`SELECT 1 FROM ${s.license} WHERE id = ${id} AND store_id = ${storeId} FOR UPDATE`);
    } else if (table === 'order') {
      await tx.execute(sql`SELECT 1 FROM ${s.order} WHERE id = ${id} AND store_id = ${storeId} FOR UPDATE`);
    } else {
      await tx.execute(sql`SELECT 1 FROM ${s.orderReservation} WHERE id = ${id} AND store_id = ${storeId} FOR UPDATE`);
    }
    taken.add(`${table}:${id}`);
  }
}

/** drizzle wraps driver errors ("Failed query: …") and keeps the pg error on `cause`. */
function pgErrorCode(e: unknown): string | undefined {
  for (let cur: unknown = e, depth = 0; cur && typeof cur === 'object' && depth < 5; depth++) {
    const code = (cur as { code?: string }).code;
    if (code) return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

function isLockTimeout(e: unknown): boolean {
  return pgErrorCode(e) === '55P03';
}

/**
 * Postgres deadlock_detected (40P01) or serialization_failure (40001). The aborted transaction rolled back, releasing
 * every lock it held, so restarting it is safe: money recording is idempotent by operation id (X-45 backstop).
 */
export function isDeadlockOrSerializationFailure(e: unknown): boolean {
  const code = pgErrorCode(e);
  return code === '40P01' || code === '40001';
}

function union(a: LockPlanContribution, b: LockPlanContribution): LockPlanContribution {
  return {
    purchases: [...a.purchases, ...b.purchases],
    licenseIds: [...new Set([...a.licenseIds, ...b.licenseIds])],
    orderIds: [...new Set([...a.orderIds, ...b.orderIds])],
    reservationIds: [...new Set([...(a.reservationIds ?? []), ...(b.reservationIds ?? [])])],
  };
}

function subsetOf(a: LockPlanContribution, b: LockPlanContribution): boolean {
  const setB = new Set(b.licenseIds.map(canonical));
  const setO = new Set(b.orderIds.map(canonical));
  const setR = new Set((b.reservationIds ?? []).map(canonical));
  const setP = new Set(b.purchases.map(purchaseLockKey));
  return (
    a.licenseIds.every((id) => setB.has(canonical(id))) &&
    a.orderIds.every((id) => setO.has(canonical(id))) &&
    (a.reservationIds ?? []).every((id) => setR.has(canonical(id))) &&
    a.purchases.every((p) => setP.has(purchaseLockKey(p)))
  );
}

/** StoreKit purchase subjects: the purchase identities (L1) and the licence bound to each
 *  existing purchase row (L2). A purchase with no row yet contributes no licence. */
async function planPurchases(tx: Tx, storeId: string, purchases: readonly PurchaseId[]): Promise<LockPlanContribution> {
  const licenseIds: string[] = [];
  for (const p of purchases) {
    const rows = await tx
      .select({ licenseId: s.storekitPurchase.licenseId })
      .from(s.storekitPurchase)
      .where(and(
        eq(s.storekitPurchase.storeId, storeId),
        eq(s.storekitPurchase.environment, p.environment),
        eq(s.storekitPurchase.originalTransactionId, p.originalTransactionId),
      ));
    for (const r of rows) if (r.licenseId) licenseIds.push(r.licenseId);
  }
  return { purchases: [...purchases], licenseIds, orderIds: [], reservationIds: [] };
}

/** Unlocked (or under-lock) read of the rows one subject touches. */
async function planOne(tx: Tx, storeId: string, subject: LockSubject): Promise<LockPlanContribution> {
  switch (subject.kind) {
    case 'order': {
      const licenses = await tx
        .select({ id: s.license.id })
        .from(s.license)
        .where(and(eq(s.license.storeId, storeId), eq(s.license.orderId, subject.orderId)));
      return { purchases: [], licenseIds: licenses.map((r) => r.id), orderIds: [subject.orderId], reservationIds: [] };
    }
    case 'customer': {
      const orders = await tx
        .select({ id: s.order.id })
        .from(s.order)
        .where(and(eq(s.order.storeId, storeId), eq(s.order.customerId, subject.customerId)));
      const licenses =
        subject.scope === 'orders'
          ? []
          : await tx
              .select({ id: s.license.id })
              .from(s.license)
              .where(and(eq(s.license.storeId, storeId), eq(s.license.customerId, subject.customerId)));
      return { purchases: [], licenseIds: licenses.map((r) => r.id), orderIds: orders.map((r) => r.id), reservationIds: [] };
    }
    case 'loyalty': {
      // Only the orders whose held-back edit earn settleDeferredEditEarns (loyalty/ledger.ts)
      // patches under the advisory: the same predicate, so the plan covers every row written.
      const orders = await tx
        .select({ id: s.order.id })
        .from(s.order)
        .where(and(eq(s.order.storeId, storeId), eq(s.order.customerId, subject.customerId),
          sql`${s.order.metadata}->'loyalty'->'deferredEarn' is not null`));
      return { purchases: [], licenseIds: [], orderIds: orders.map((r) => r.id), reservationIds: [] };
    }
    case 'checkout':
      return {
        purchases: [],
        licenseIds: subject.sourceLicenseId ? [subject.sourceLicenseId] : [],
        orderIds: [],
        reservationIds: [],
      };
    case 'notification':
      return planPurchases(tx, storeId, [subject.purchase]);
    case 'link':
      return planPurchases(tx, storeId, subject.purchases);
  }
}

/** Extra plan contributors (registered policies' lockPlan hooks, STOREKIT §5.3). Empty by default. */
export type LockPlanContributor = (tx: Tx, subject: LockSubject) => Promise<LockPlanContribution>;
const contributors: LockPlanContributor[] = [];

/** Register a plan contributor. Called once per module by the policy host; never per request. */
export function registerLockPlanContributor(fn: LockPlanContributor): void {
  contributors.push(fn);
}

async function planFor(tx: Tx, storeId: string, subjects: readonly LockSubject[]): Promise<LockPlanContribution> {
  let plan: LockPlanContribution = EMPTY;
  for (const subject of subjects) {
    plan = union(plan, await planOne(tx, storeId, subject));
    for (const contribute of contributors) plan = union(plan, await contribute(tx, subject));
  }
  // L4: every planned order's reservations (an order's holds are locked with the order).
  if (plan.orderIds.length) {
    const rows = await tx
      .select({ id: s.orderReservation.id })
      .from(s.orderReservation)
      .where(and(eq(s.orderReservation.storeId, storeId), inArray(s.orderReservation.orderId, [...plan.orderIds])));
    plan = union(plan, { purchases: [], licenseIds: [], orderIds: [], reservationIds: rows.map((r) => r.id) });
  }
  return plan;
}

/**
 * X-49 pass-through: true when the set held on `tx` already covers every row `subjects` plans.
 * Re-plans the subjects on `tx` (unlocked reads) and checks them against the held plan.
 */
export async function lockSetCovers(tx: Tx, storeId: string, subject: LockSubject | readonly LockSubject[]): Promise<boolean> {
  const held = currentLockSet(tx);
  if (!held) return false;
  const subjects = Array.isArray(subject) ? subject : [subject as LockSubject];
  return subsetOf(await planFor(tx, storeId, subjects), held.plan);
}

/**
 * X-49 in-transaction acquisition: when no covering set is held on `tx`, take the rows `subject` plans
 * on THIS transaction (purchases L1, licences L2, orders L3, reservations L4; each class sorted), then
 * re-plan under the locks. No nested transaction, so the locks commit or roll back with the caller's
 * work. Growth under the lock throws LockSetGrew and the caller's transaction rolls back.
 * Returns 'held' when a covering set already exists, 'locked' when it acquired the rows here.
 */
export async function lockSetInTx(tx: Tx, storeId: string, subject: LockSubject | readonly LockSubject[]): Promise<'held' | 'locked'> {
  if (await lockSetCovers(tx, storeId, subject)) return 'held';
  const subjects = Array.isArray(subject) ? subject : [subject as LockSubject];
  const plan = await planFor(tx, storeId, subjects);
  await acquirePurchaseLocks(tx, plan.purchases);
  const taken = new Set<string>();
  await lockRows(tx, 'license', storeId, plan.licenseIds, taken);
  await lockRows(tx, 'order', storeId, plan.orderIds, taken);
  const again = await planFor(tx, storeId, subjects);
  if (!subsetOf(again, plan)) throw new LockSetGrew(again);
  await lockRows(tx, 'order_reservation', storeId, plan.reservationIds ?? [], taken);
  return 'locked';
}

/**
 * In-transaction form of withLockedSet for helpers that run on an existing transaction (effects, inline
 * settlement, placement tenders). A covering set already held on `tx` is reused (the HeldLocks brand of that set);
 * otherwise the subject's rows are locked on this same transaction in class order (L1 → L2 → L3 → L4), re-planned
 * under the locks, and the brand is minted for `fn`. Growth under the lock throws LockSetGrew, which rolls the
 * caller's transaction back.
 */
export async function withLockedSetInTx<T>(
  tx: Tx,
  storeId: string,
  subject: LockSubject | readonly LockSubject[],
  fn: (tx: Tx, held: HeldLocks, plan: LockPlanContribution) => Promise<T>,
): Promise<T> {
  const covering = currentLockSet(tx);
  if (covering && (await lockSetCovers(tx, storeId, subject))) return fn(tx, covering.held, covering.plan);
  const subjects = Array.isArray(subject) ? subject : [subject as LockSubject];
  const plan = await planFor(tx, storeId, subjects);
  const advisoryHashes = await acquirePurchaseLocks(tx, plan.purchases);
  const taken = new Set<string>();
  await lockRows(tx, 'license', storeId, plan.licenseIds, taken);
  await lockRows(tx, 'order', storeId, plan.orderIds, taken);
  const again = await planFor(tx, storeId, subjects);
  if (!subsetOf(again, plan)) throw new LockSetGrew(again);
  await lockRows(tx, 'order_reservation', storeId, plan.reservationIds ?? [], taken);
  const held = mintHeld({
    tx,
    advisoryHashes,
    promisedLicenseIds: plan.licenseIds.map(canonical),
    promisedOrderIds: plan.orderIds.map(canonical),
    lockedRows: taken,
  });
  return lockSetContext.run({ tx, held, plan }, () => fn(tx, held, plan));
}

/**
 * X-49 order-row acquisition for paths that update only the orders' own rows (no licence writes):
 * pass-through when a covering set is held on `tx`, else the order rows are locked here, sorted, on
 * this same transaction. Taking only L3 keeps the class order when the caller already holds L2 licences.
 */
export async function lockOrderRowsInTx(tx: Tx, storeId: string, orderIds: readonly string[]): Promise<'held' | 'locked'> {
  if (!orderIds.length) return 'held';
  if (await lockSetCovers(tx, storeId, orderIds.map((orderId) => ({ kind: 'order' as const, orderId })))) return 'held';
  await lockRows(tx, 'order', storeId, orderIds, new Set());
  return 'locked';
}

/**
 * Plan → lock → verify. `fn` runs inside the locked transaction after L2/L3 and
 * receives the held brand. A list of subjects is planned as the union of its members.
 * Restarts on plan growth (LockSetGrew) or lock timeout (55P03), up to maxRestarts.
 *
 * `mustCommit` (X-45): for a transaction that records money a provider has already
 * moved. No lock_timeout is set (the statement waits for the holder), and plan growth
 * is retried until the set is stable, so the call never surfaces LockSetUnstable.
 */
export async function withLockedSet<T>(
  storeId: string,
  subject: LockSubject | readonly LockSubject[],
  fn: (tx: Tx, held: HeldLocks, plan: LockPlanContribution) => Promise<T>,
  opts: { maxRestarts?: number; mustCommit?: boolean } = {},
): Promise<T> {
  const subjects = Array.isArray(subject) ? subject : [subject as LockSubject];
  let plan = await withStore(storeId, (tx) => planFor(tx, storeId, subjects));
  let transientRetries = 0;
  for (let attempt = 0; ; attempt++) {
    try {
      return await withStore(storeId, async (tx) => {
        const taken = new Set<string>();
        if (opts.mustCommit) await tx.execute(sql`SET LOCAL lock_timeout = 0`);
        else await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
        const advisoryHashes = await acquirePurchaseLocks(tx, plan.purchases); // L1
        await lockRows(tx, 'license', storeId, plan.licenseIds, taken); // L2
        await lockRows(tx, 'order', storeId, plan.orderIds, taken); // L3
        const again = await planFor(tx, storeId, subjects); // re-plan UNDER the locks
        if (!subsetOf(again, plan)) throw new LockSetGrew(again); // rollback releases every lock
        await lockRows(tx, 'order_reservation', storeId, plan.reservationIds ?? [], taken); // L4
        const witness: Witness = {
          tx,
          advisoryHashes,
          promisedLicenseIds: plan.licenseIds.map(canonical),
          promisedOrderIds: plan.orderIds.map(canonical),
          lockedRows: taken,
        };
        const held = mintHeld(witness);
        // X-49: the set is visible to helpers on this transaction for the duration of fn.
        return lockSetContext.run({ tx, held, plan }, () => fn(tx, held, plan));
      });
    } catch (e) {
      if (isDeadlockOrSerializationFailure(e)) {
        // Backstop: restart the whole transaction (the rollback released every lock). Bounded, with jitter.
        if (transientRetries >= (opts.maxRestarts ?? 3)) throw e;
        transientRetries++;
        await new Promise((resolve) => setTimeout(resolve, 10 + Math.floor(Math.random() * 40) * transientRetries));
        continue;
      }
      if (!(e instanceof LockSetGrew) && !isLockTimeout(e)) throw e;
      if (opts.mustCommit) {
        // No lock_timeout in this mode, so only growth can arrive here. The plan
        // strictly grows over a finite row set, so the retry loop terminates.
        if (!(e instanceof LockSetGrew)) throw e;
        plan = union(plan, e.grown);
        continue;
      }
      if (attempt >= (opts.maxRestarts ?? 3)) throw new LockSetUnstable();
      plan = e instanceof LockSetGrew ? union(plan, e.grown) : plan;
    }
  }
}

