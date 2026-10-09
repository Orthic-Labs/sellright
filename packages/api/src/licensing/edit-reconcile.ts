/**
 * Order editing x license entitlements.
 *
 * Policy (safer choice): an edit may ADD licensed lines (licenses are issued
 * once the balance is fully settled) but may NOT remove, reduce or repoint a
 * line that already has non-revoked licenses — that would leave a live
 * entitlement the order no longer pays for. Callers (order-edit commit) must run
 * `licensedLineEditViolations` and reject; `reconcileEditedOrderLicenses` is the
 * settlement-side top-up plus a defensive revoke of entitlements whose line no
 * longer exists at positive quantity.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import * as s from '../db/schema.js';
import { issueLicensesForPaidOrder } from './issue.js';

export interface ProposedLine { id: string; variantId: string | null; quantity: number }

/** Order-line ids whose proposed state would strand issued (non-revoked) licenses. */
export async function licensedLineEditViolations(tx: Tx, storeId: string, orderId: string, proposed: ProposedLine[]): Promise<string[]> {
  const rows = await tx.select({ lineId: s.license.orderLineId, n: sql<number>`count(*)::int` }).from(s.license)
    .where(and(eq(s.license.storeId, storeId), eq(s.license.orderId, orderId), eq(s.license.source, 'order'),
      sql`${s.license.status} <> 'revoked'`, sql`${s.license.orderLineId} is not null`))
    .groupBy(s.license.orderLineId);
  if (!rows.length) return [];
  const lines = await tx.select({ id: s.orderLine.id, variantId: s.orderLine.variantId }).from(s.orderLine)
    .where(and(eq(s.orderLine.storeId, storeId), eq(s.orderLine.orderId, orderId)));
  const current = new Map(lines.map(l => [l.id, l.variantId]));
  const next = new Map(proposed.map(p => [p.id, p]));
  const bad: string[] = [];
  for (const r of rows) {
    const id = r.lineId!;
    const p = next.get(id);
    if (!p || p.quantity < r.n || (current.has(id) && (current.get(id) ?? null) !== (p.variantId ?? null))) bad.push(id);
  }
  return bad;
}

/** Called when an edit's balance is fully settled: issue licenses for added
 *  lines (idempotent per line) and revoke any entitlement stranded on a
 *  zero-quantity line. Returns counts. */
export async function reconcileEditedOrderLicenses(
  tx: Tx, opts: { storeId: string; orderId: string; customerId: string | null; paidAt?: Date },
): Promise<{ issued: number; revoked: number }> {
  const now = new Date();
  const revokedRows = await tx.update(s.license).set({ status: 'revoked', updatedAt: now })
    .where(and(eq(s.license.storeId, opts.storeId), eq(s.license.orderId, opts.orderId), eq(s.license.source, 'order'),
      sql`${s.license.status} <> 'revoked'`,
      sql`exists (select 1 from order_line ol where ol.id = ${s.license.orderLineId} and ol.store_id = ${opts.storeId} and ol.quantity <= 0)`))
    .returning({ id: s.license.id });
  if (revokedRows.length) await tx.update(s.licenseActivation).set({
    state: 'revoked', revokedAt: now, updatedAt: now, generation: sql`${s.licenseActivation.generation} + 1`,
  }).where(and(eq(s.licenseActivation.storeId, opts.storeId),
    inArray(s.licenseActivation.licenseId, revokedRows.map(l => l.id)), eq(s.licenseActivation.state, 'active')));
  // issueLicensesForPaidOrder skips zero-quantity lines' grants via buildLicenseGrants (qty 0 => none).
  const issued = await issueLicensesForPaidOrder(tx, opts);
  return { issued, revoked: revokedRows.length };
}
