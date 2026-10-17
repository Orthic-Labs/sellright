import { and, eq } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import * as s from '../db/schema.js';
import { migrationId } from '../import/context.js';

type ImportedRow = typeof s.importedOrderModification.$inferSelect;
type ScopedLink = { id: string; storeId: string; orderId: string };
type HistoryLine = ScopedLink & { variantName: string };

export interface ImportedAddressChange {
  fields: { label: string; value: string }[];
}

/** Display facts only. Source records, source identifiers & executable settlement
 * payloads never cross the admin API boundary. Local source timestamps remain
 * text until their timezone is independently established. */
export interface ImportedOrderHistoryEntry {
  kind: 'imported';
  id: string;
  createdAt: string | null;
  updatedAt: string | null;
  sourceCreatedAtText: string | null;
  sourceUpdatedAtText: string | null;
  priceChange: number;
  note: string;
  lineChanges: { lineId: string | null; label: string; quantityDelta: number }[];
  addressChanges: { shipping: ImportedAddressChange | null; billing: ImportedAddressChange | null };
  links: { refundId: string | null; paymentId: string | null };
  actionable: false;
}

function object(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value != null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

function sourceId(value: unknown): string | null {
  if (typeof value === 'string' && /^\d+$/.test(value)) return value;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
}

const ADDRESS_FIELDS = [
  ['fullName', 'Name'], ['company', 'Company'], ['streetLine1', 'Address'], ['streetLine2', 'Address line 2'],
  ['city', 'City'], ['province', 'Province'], ['postalCode', 'Postal code'], ['countryCode', 'Country'], ['phoneNumber', 'Phone'],
] as const;

function addressChange(text: string | null): ImportedAddressChange | null {
  if (!text) return null;
  const value = object(text);
  if (!value || !Object.keys(value).length) return null;
  // Whitelist scalar address facts; never forward arbitrary JSON or render HTML.
  return { fields: ADDRESS_FIELDS.flatMap(([key, label]) => typeof value[key] === 'string' ? [{ label, value: value[key] as string }] : []) };
}

export function projectImportedOrderHistory(
  rows: readonly ImportedRow[],
  context: { storeId: string; orderId: string; lines: readonly HistoryLine[]; payments: readonly ScopedLink[]; refunds: readonly ScopedLink[] },
): ImportedOrderHistoryEntry[] {
  const belongs = (row: ScopedLink) => row.storeId === context.storeId && row.orderId === context.orderId;
  const lines = new Map(context.lines.filter(belongs).map(line => [line.id, line]));
  const payments = new Set(context.payments.filter(belongs).map(payment => payment.id));
  const refunds = new Set(context.refunds.filter(belongs).map(refund => refund.id));
  return rows.filter(row => row.scopeDisposition === 'selected_channel' && row.storeId === context.storeId && row.orderId === context.orderId)
    .map((row): ImportedOrderHistoryEntry => ({
      kind: 'imported', id: row.id, createdAt: null, updatedAt: null,
      sourceCreatedAtText: row.sourceCreatedAt, sourceUpdatedAtText: row.sourceUpdatedAt,
      priceChange: row.priceChange, note: row.note,
      lineChanges: row.sourceReferences.flatMap(text => {
        const ref = object(text);
        if (!ref || ref.discriminator !== 'OrderModificationLine' || sourceId(ref.modificationId) !== row.sourceId ||
            typeof ref.quantity !== 'number' || !Number.isSafeInteger(ref.quantity)) return [];
        const originalLineId = sourceId(ref.orderLineId);
        const line = originalLineId == null ? undefined : lines.get(migrationId(row.storeId, row.sourceKey, 'order-line', originalLineId));
        return [{ lineId: line?.id ?? null, label: line?.variantName ?? 'Imported order line', quantityDelta: ref.quantity }];
      }),
      addressChanges: { shipping: addressChange(row.shippingAddressChange), billing: addressChange(row.billingAddressChange) },
      links: { refundId: row.refundId && refunds.has(row.refundId) ? row.refundId : null,
        paymentId: row.paymentId && payments.has(row.paymentId) ? row.paymentId : null },
      actionable: false,
    }))
    // Source-local ordering only; do not compare these texts with native UTC instants.
    .sort((a, b) => (b.sourceCreatedAtText ?? '').localeCompare(a.sourceCreatedAtText ?? '') || a.id.localeCompare(b.id));
}

/** Caller already resolved an authorized order inside withStore. Keep explicit
 * store/order predicates as well as RLS for every imported-data relationship. */
export async function loadImportedOrderHistory(tx: Tx, storeId: string, orderId: string, lines: readonly HistoryLine[]) {
  const rows = await tx.select().from(s.importedOrderModification).where(and(
    eq(s.importedOrderModification.storeId, storeId), eq(s.importedOrderModification.orderId, orderId),
    eq(s.importedOrderModification.scopeDisposition, 'selected_channel'),
  ));
  if (!rows.length) return [];
  const payments = await tx.select({ id: s.payment.id, storeId: s.payment.storeId, orderId: s.payment.orderId }).from(s.payment)
    .where(and(eq(s.payment.storeId, storeId), eq(s.payment.orderId, orderId)));
  const refunds = await tx.select({ id: s.refund.id, storeId: s.refund.storeId, orderId: s.refund.orderId }).from(s.refund)
    .where(and(eq(s.refund.storeId, storeId), eq(s.refund.orderId, orderId)));
  return projectImportedOrderHistory(rows, { storeId, orderId, lines, payments, refunds });
}
