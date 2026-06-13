import { randomBytes } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import * as s from '../db/schema.js';
import { buildLicenseGrants, type FulfillmentType } from './entitlements.js';

function newLicenseKey(appKey: string): string {
  return `SR-${appKey.toUpperCase()}-${randomBytes(16).toString('hex').toUpperCase()}`;
}

export async function issueLicensesForPaidOrder(
  tx: Tx,
  opts: { storeId: string; orderId: string; customerId: string | null; paidAt?: Date },
): Promise<number> {
  // Serialize concurrent issuance for the same order. issueLicensesForPaidOrder
  // can fire from both the checkout settle path and the Stripe webhook reconcile —
  // without this lock two transactions both read 0 existing rows and both insert,
  // double-issuing. The lock makes the count-then-insert below atomic per order.
  await tx.execute(sql`SELECT 1 FROM "order" WHERE id = ${opts.orderId} FOR UPDATE`);

  const lines = await tx
    .select({
      orderLineId: s.orderLine.id,
      quantity: s.orderLine.quantity,
      fulfillmentType: s.productVariant.fulfillmentType,
      appKey: s.productVariant.appKey,
      licenseSeats: s.productVariant.licenseSeats,
      updatesDurationDays: s.productVariant.updatesDurationDays,
      licenseDurationDays: s.productVariant.licenseDurationDays,
      metadata: s.productVariant.metafields,
    })
    .from(s.orderLine)
    .innerJoin(s.productVariant, eq(s.productVariant.id, s.orderLine.variantId))
    .where(eq(s.orderLine.orderId, opts.orderId));

  if (!lines.length) return 0;
  const grants = buildLicenseGrants(lines.map((line) => ({
    ...line,
    fulfillmentType: line.fulfillmentType as FulfillmentType,
  })), opts.paidAt ?? new Date());
  if (!grants.length) return 0;

  // Idempotency + correct partial top-up: count licenses already issued PER
  // orderLineId and only issue the shortfall. A quantity=2 line wants 2 license
  // rows; a presence-only check would skip the 2nd if the 1st already exists
  // (under-issue) or, on a clean retry, re-issue both (double-issue).
  const existing = await tx
    .select({ orderLineId: s.license.orderLineId })
    .from(s.license)
    .where(inArray(s.license.orderLineId, [...new Set(grants.map((g) => g.orderLineId))]));
  const remaining = new Map<string, number>();
  for (const row of existing) remaining.set(row.orderLineId, (remaining.get(row.orderLineId) ?? 0) + 1);
  const toIssue = grants.filter((grant) => {
    const already = remaining.get(grant.orderLineId) ?? 0;
    if (already > 0) { remaining.set(grant.orderLineId, already - 1); return false; } // already issued
    return true;
  });
  if (!toIssue.length) return 0;

  await tx.insert(s.license).values(toIssue.map((grant) => ({
    storeId: opts.storeId,
    customerId: opts.customerId,
    orderId: opts.orderId,
    orderLineId: grant.orderLineId,
    appKey: grant.appKey,
    licenseKey: newLicenseKey(grant.appKey),
    seats: grant.seats,
    updatesUntil: grant.updatesUntil,
    expiresAt: grant.expiresAt,
    metadata: grant.metadata as object | null,
  })));
  return toIssue.length;
}
