/**
 * Atomic migration phase (invoke through import/run.ts): source store-credit
 * balances → loyalty points ledger `import` entries.
 *
 * Source: the store-credit plugin tables `account_credit` (one row per issued
 * credit; `balance` is the remaining cents) and `account_credit_transaction`
 * (its history). Only the remaining balance migrates — history stays in the
 * source snapshot. Each enabled credit with a positive balance in the
 * migration currency becomes one `import` ledger row for the customer whose
 * normalized email matches, converted at the TARGET store's
 * pointsPerDollarOff and rounded UP (a customer never loses value to
 * rounding). Deterministic ids + source_ref make the phase replay-safe.
 *
 * Nothing is dropped silently: absent tables, an unconfigured points rate,
 * unmatched customers, disabled/other-currency credits and still-pending
 * reservations all land on the manifest exclusion list with counts.
 */
import { and, eq, inArray } from 'drizzle-orm';
import * as s from '../db/schema.js';
import { normalizeEmail } from '../auth/email.js';
import { centsToPoints, type LoyaltySettings } from '../money/loyalty.js';
import type { ImportContext } from './context.js';

export interface CreditRow { id: unknown; email: string | null; currency: string | null; balance: number | string | null; disabled: boolean | null }

/** Pure mapping, exported for unit tests. */
export function mapCreditsToPoints(rows: CreditRow[], opts: { currency: string; pointsPerDollarOff: number; customerByEmail: ReadonlyMap<string, string> }) {
  const entries: Array<{ sourceId: string; customerId: string; points: number; cents: number }> = [];
  const skipped = { disabled: 0, zero: 0, currency: 0, noCustomer: 0 };
  for (const row of rows) {
    const cents = Math.max(0, Math.trunc(Number(row.balance ?? 0)));
    if (row.disabled) { skipped.disabled++; continue; }
    if (cents <= 0) { skipped.zero++; continue; }
    if ((row.currency ?? opts.currency) !== opts.currency) { skipped.currency++; continue; }
    const customerId = row.email ? opts.customerByEmail.get(normalizeEmail(row.email)) : undefined;
    if (!customerId) { skipped.noCustomer++; continue; }
    entries.push({ sourceId: String(row.id), customerId, points: centsToPoints(cents, opts.pointsPerDollarOff), cents });
  }
  return { entries, skipped };
}

export async function importLoyalty(ctx: ImportContext, settings: LoyaltySettings | null): Promise<{ imported: number; points: number }> {
  const { tx, q, storeId } = ctx;
  const exclude = (detail: string, count?: number) =>
    ctx.exclusions.push({ type: 'unmappable-source-row', table: 'account_credit', detail, count });
  if (!ctx.sourceColumns.has('account_credit')) {
    ctx.exclusions.push({ type: 'source-extension-absent', table: 'account_credit', detail: 'no store-credit plugin table in source; no balances to import' });
    return { imported: 0, points: 0 };
  }
  const sourceRows = (await q(
    `SELECT id, "emailNormalized" AS email, "currencyCode" AS currency, balance, disabled FROM account_credit ORDER BY id`,
  )) as CreditRow[];

  // R23 fix: `account_credit.balance` is NOT already net of pending holds —
  // reserving credit (checkout applying a DDC- coupon to an order still in
  // PendingPayment) writes a PENDING transaction with delta:0 and only
  // decrements `balance` on SETTLE. So a customer with balance=2550 and a
  // 100-cent pending reservation has 2450 cents TRULY available; importing
  // the gross 2550 would let them spend the reserved 100 cents again while
  // the old (pre-cutover) order can still settle and consume it too —
  // double-counted value. Reconcile by subtracting each credit's own
  // outstanding pending holds before converting to points.
  let rows = sourceRows;
  let pendingHoldCents = 0;
  let creditsWithPendingHolds = 0;
  if (ctx.sourceColumns.has('account_credit_transaction')) {
    const pendingByCredit = await q(
      `SELECT "accountCreditId" AS credit_id, sum(amount)::int AS pending
       FROM account_credit_transaction WHERE status = 'PENDING' GROUP BY "accountCreditId"`,
    );
    const pendingMap = new Map<string, number>(pendingByCredit.map((p) => [String(p.credit_id), Number(p.pending ?? 0)]));
    if (pendingMap.size) {
      creditsWithPendingHolds = pendingMap.size;
      rows = sourceRows.map((r) => {
        const pending = pendingMap.get(String(r.id)) ?? 0;
        if (pending <= 0) return r;
        pendingHoldCents += pending;
        // Floor at 0: a data inconsistency (holds exceeding balance) must
        // never import as negative or wrap to a large unsigned value.
        return { ...r, balance: Math.max(0, Math.trunc(Number(r.balance ?? 0)) - pending) };
      });
      exclude(
        `pending store-credit reservations reconciled: ${pendingHoldCents} cents held back across ${creditsWithPendingHolds} credit(s) (imported balance is net of these holds; the pre-cutover order behind each hold still settles/releases against the ORIGINAL system and must not be replayed here)`,
        creditsWithPendingHolds,
      );
    }
  }
  const live = rows.filter((r) => !r.disabled && Number(r.balance ?? 0) > 0);
  if (!live.length) return { imported: 0, points: 0 };
  if (!settings || !(settings.pointsPerDollarOff > 0)) {
    const cents = live.reduce((n, r) => n + Number(r.balance ?? 0), 0);
    exclude(`store-credit balances NOT imported: target store has no loyalty.pointsPerDollarOff configured (${cents} cents outstanding) — set migration config "loyalty" and re-run`, live.length);
    return { imported: 0, points: 0 };
  }
  const emails = [...new Set(live.map((r) => (r.email ? normalizeEmail(r.email) : '')).filter(Boolean))];
  const customers = emails.length
    ? await tx.select({ id: s.customer.id, email: s.customer.email }).from(s.customer)
        .where(and(eq(s.customer.storeId, storeId), inArray(s.customer.email, emails)))
    : [];
  const { entries, skipped } = mapCreditsToPoints(rows, {
    currency: ctx.currency, pointsPerDollarOff: settings.pointsPerDollarOff,
    customerByEmail: new Map(customers.map((c) => [c.email, c.id])),
  });
  if (skipped.noCustomer) exclude('store-credit balances whose email matches no imported customer', skipped.noCustomer);
  if (skipped.currency) exclude(`store-credit balances in a currency other than ${ctx.currency}`, skipped.currency);
  if (skipped.disabled) exclude('disabled store credits not imported', skipped.disabled);
  for (const e of entries) {
    await tx.insert(s.loyaltyLedger).values({
      id: ctx.id('loyalty-import', e.sourceId), storeId, customerId: e.customerId, kind: 'import', points: e.points,
      sourceRef: `import:account_credit:${ctx.sourceKey}:${e.sourceId}`, actor: 'system:import', reason: 'store_credit_migration',
      metadata: { sourceCreditId: e.sourceId, sourceBalanceCents: e.cents, pointsPerDollarOff: settings.pointsPerDollarOff },
    });
  }
  return { imported: entries.length, points: entries.reduce((n, e) => n + e.points, 0) };
}
