/** Source wire names & persisted identities stay confined to import compatibility. */
import { vendureProratedUnitPriceWithTax } from './vendure-money.js';
import { MAX_CREDIT_CENTS } from '../account-credit/math.js';

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export const importedFinancialReconciliationPath = ['vendure', 'financialReconciliationV1'] as const;
/** Presence is a quarantine, including malformed markers. Only a separately
 * reconciled operational record may regain monetary capabilities. */
export function importedFinancialReconciliationRequired(metadata: unknown): boolean {
  return object(metadata) && object(metadata.vendure) && Object.hasOwn(metadata.vendure, 'financialReconciliationV1');
}
export function importedSourceMetadata(metadata: unknown) {
  return (metadata as { vendure?: { sourceKey?: unknown; id?: unknown; editBasisV1?: unknown; placedQuantity?: number } } | null)?.vendure;
}
export function importedEditSource(metadata: unknown): { present: true; value: unknown } | { present: false } {
  return metadata != null && typeof metadata === 'object' && Object.hasOwn(metadata, 'vendure')
    ? { present: true, value: (metadata as { vendure: unknown }).vendure }
    : { present: false };
}
export interface ImportedPricingBasis {
  kind: 'vendure-order-edit-basis-v1'; storeId: string; orderId: string; currency: string;
  sourceKey: string; sourceOrderId: string; editBasisV1: unknown;
}
export function importedPricingBasis(input: Omit<ImportedPricingBasis, 'kind'>): ImportedPricingBasis {
  return { kind: 'vendure-order-edit-basis-v1', ...input };
}
export const isImportedPricingBasis = (value: unknown): value is Record<string, unknown> & { kind: ImportedPricingBasis['kind'] } =>
  object(value) && value.kind === 'vendure-order-edit-basis-v1';
export function importedOrderEditMetadata(source: { sourceOrderId: unknown; sourceKey: unknown; editBasisV1: unknown }) {
  return { vendure: { id: source.sourceOrderId, sourceKey: source.sourceKey, editBasisV1: source.editBasisV1 } };
}
export const importedCreditUnitId = (sourceBasisDigest: string, orderLineId: string, sourceSlot: number): string =>
  `vendure:${sourceBasisDigest}:${orderLineId}:${sourceSlot}`;
export function isImportedCreditUnitId(id: unknown, orderLineId: string): boolean {
  const born = typeof id === 'string' ? id.split(':') : [];
  return born.length === 4 && born[0] === 'vendure' && /^[a-f0-9]{64}$/.test(born[1]!) &&
    born[2] === orderLineId && /^(0|[1-9]\d*)$/.test(born[3]!) && Number.isSafeInteger(Number(born[3]));
}
/** Legacy refund facts have stricter money admission than quantity-only custody. */
export function importedRefundUnitBasis(metadata: unknown): number | null {
  const raw = object(metadata) ? metadata.vendure : undefined;
  if (raw === undefined) return null;
  const cents = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= MAX_CREDIT_CENTS;
  const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  if (!object(raw) || !cents(raw.quantity) || !cents(raw.placedQuantity) || !cents(raw.listPrice) ||
      typeof raw.listPriceIncludesTax !== 'boolean' || !Array.isArray(raw.adjustments) || !Array.isArray(raw.taxLines) ||
      !raw.adjustments.every(a => object(a) && finite(a.amount)) || !raw.taxLines.every(t => object(t) && finite(t.taxRate) && t.taxRate >= 0)) {
    throw new Error('Imported refund unit requires complete source money facts');
  }
  const unit = raw.placedQuantity > 0 ? vendureProratedUnitPriceWithTax({ quantity: raw.quantity,
    orderPlacedQuantity: raw.placedQuantity, listPrice: raw.listPrice, listPriceIncludesTax: raw.listPriceIncludesTax,
    adjustments: raw.adjustments, taxLines: raw.taxLines }) : 0;
  if (!cents(unit)) throw new Error('Imported refund unit is outside integer cents');
  return unit;
}
