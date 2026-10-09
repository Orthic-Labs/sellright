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
import { sql } from 'drizzle-orm';
import { and, eq, inArray } from 'drizzle-orm';
import { withStore, type Tx } from './client.js';
import * as s from './schema.js';

declare const heldBrand: unique symbol;
export type HeldLocks = { readonly [heldBrand]: true };
const mintHeld = (): HeldLocks => ({}) as HeldLocks;

export type PurchaseId = { storeId: string; environment: string; originalTransactionId: string };

export type LockSubject =
  | { kind: 'order'; orderId: string }
  | { kind: 'customer'; customerId: string; scope?: 'all' | 'orders' }
  | { kind: 'checkout'; sourceLicenseId?: string }
  | { kind: 'loyalty'; customerId: string };

export interface LockPlanContribution {
  readonly purchases: readonly PurchaseId[];
  readonly licenseIds: readonly string[];
  readonly orderIds: readonly string[];
  readonly reservationIds: readonly string[];
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
export async function acquirePurchaseLocks(tx: Tx, purchases: readonly PurchaseId[]): Promise<void> {
  const keys = [...new Set(purchases.map(purchaseLockKey))];
  if (!keys.length) return;
  const { rows } = await tx.execute(
    sql`SELECT hashtextextended(k, 0)::text AS h FROM unnest(${sql.param(keys)}::text[]) AS k`,
  );
  const hashes = [...new Set((rows as { h: string }[]).map((r) => BigInt(r.h)))].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  for (const h of hashes) await tx.execute(sql`SELECT pg_advisory_xact_lock(${h.toString()}::bigint)`);
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
  }
}

/** drizzle wraps driver errors ("Failed query: …") and keeps the pg error on `cause`. */
function isLockTimeout(e: unknown): boolean {
  for (let cur: unknown = e, depth = 0; cur && typeof cur === 'object' && depth < 5; depth++) {
    if ((cur as { code?: string }).code === '55P03') return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

function union(a: LockPlanContribution, b: LockPlanContribution): LockPlanContribution {
  return {
    purchases: [...a.purchases, ...b.purchases],
    licenseIds: [...new Set([...a.licenseIds, ...b.licenseIds])],
    orderIds: [...new Set([...a.orderIds, ...b.orderIds])],
    reservationIds: [...new Set([...a.reservationIds, ...b.reservationIds])],
  };
}

function subsetOf(a: LockPlanContribution, b: LockPlanContribution): boolean {
  const setB = new Set(b.licenseIds.map(canonical));
  const setO = new Set(b.orderIds.map(canonical));
  const setR = new Set(b.reservationIds.map(canonical));
  const setP = new Set(b.purchases.map(purchaseLockKey));
  return (
    a.licenseIds.every((id) => setB.has(canonical(id))) &&
    a.orderIds.every((id) => setO.has(canonical(id))) &&
    a.reservationIds.every((id) => setR.has(canonical(id))) &&
    a.purchases.every((p) => setP.has(purchaseLockKey(p)))
  );
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
      const orders = await tx
        .select({ id: s.order.id })
        .from(s.order)
        .where(and(eq(s.order.storeId, storeId), eq(s.order.customerId, subject.customerId)));
      return { purchases: [], licenseIds: [], orderIds: orders.map((r) => r.id), reservationIds: [] };
    }
    case 'checkout':
      return {
        purchases: [],
        licenseIds: subject.sourceLicenseId ? [subject.sourceLicenseId] : [],
        orderIds: [],
        reservationIds: [],
      };
  }
}

async function planFor(tx: Tx, storeId: string, subjects: readonly LockSubject[]): Promise<LockPlanContribution> {
  let plan: LockPlanContribution = EMPTY;
  for (const subject of subjects) plan = union(plan, await planOne(tx, storeId, subject));
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
 * Plan → lock → verify. `fn` runs inside the locked transaction after L2/L3 and
 * receives the held brand. A list of subjects is planned as the union of its members.
 * Restarts on plan growth (LockSetGrew) or lock timeout (55P03), up to maxRestarts.
 */
export async function withLockedSet<T>(
  storeId: string,
  subject: LockSubject | readonly LockSubject[],
  fn: (tx: Tx, held: HeldLocks, plan: LockPlanContribution) => Promise<T>,
  opts: { maxRestarts?: number } = {},
): Promise<T> {
  const subjects = Array.isArray(subject) ? subject : [subject as LockSubject];
  let plan = await withStore(storeId, (tx) => planFor(tx, storeId, subjects));
  for (let attempt = 0; ; attempt++) {
    try {
      return await withStore(storeId, async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
        await acquirePurchaseLocks(tx, plan.purchases); // L1
        await lockRows(tx, 'license', storeId, plan.licenseIds); // L2
        await lockRows(tx, 'order', storeId, plan.orderIds); // L3
        const again = await planFor(tx, storeId, subjects); // re-plan UNDER the locks
        if (!subsetOf(again, plan)) throw new LockSetGrew(again); // rollback releases every lock
        await lockRows(tx, 'order_reservation', storeId, plan.reservationIds); // L4
        return fn(tx, mintHeld(), plan);
      });
    } catch (e) {
      if (!(e instanceof LockSetGrew) && !isLockTimeout(e)) throw e;
      if (attempt >= (opts.maxRestarts ?? 3)) throw new LockSetUnstable();
      plan = e instanceof LockSetGrew ? union(plan, e.grown) : plan;
    }
  }
}

