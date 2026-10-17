import { OrderEditError } from './order-edit.js';

export type ImportedEditSource = { present: false } | { present: true; value: unknown };
type Refusal = { code: 'ORDER_NOT_EDITABLE' | 'ORDER_SOURCE_STATE_REQUIRES_RECONCILIATION'; message: string };
export interface ImportedEditAdmission { planRefusal: Refusal | null; addressRefusal: Refusal | null }

// These are the source states accepted by import/orders.ts. Admission only
// narrows editing; all existing native, pricing & payment checks still apply.
const KNOWN_SOURCE_STATES = new Set([
  'Cancelled', 'Refunded', 'PartiallyRefunded', 'PaymentSettled', 'PartiallyShipped',
  'Shipped', 'PartiallyDelivered', 'Delivered', 'PaymentAuthorized', 'Modifying',
]);

/** Source provenance is authoritative here, never derived fulfillment status.
 * A direct address save does not reprice, so only source cancellation vetoes it. */
export function classifyImportedEditAdmission(source: ImportedEditSource): ImportedEditAdmission {
  if (!source.present) return { planRefusal: null, addressRefusal: null };
  const state = source.value != null && typeof source.value === 'object' && !Array.isArray(source.value)
    ? (source.value as Record<string, unknown>).state : undefined;
  if (state === 'Cancelled') {
    const refusal: Refusal = { code: 'ORDER_NOT_EDITABLE', message: 'This imported order is cancelled; it cannot be edited.' };
    return { planRefusal: refusal, addressRefusal: refusal };
  }
  if (state === 'Delivered') {
    return { planRefusal: { code: 'ORDER_NOT_EDITABLE', message: 'This imported order was delivered; its pricing cannot be edited.' }, addressRefusal: null };
  }
  if (state === 'Modifying' || typeof state !== 'string' || !KNOWN_SOURCE_STATES.has(state)) {
    return {
      planRefusal: { code: 'ORDER_SOURCE_STATE_REQUIRES_RECONCILIATION', message: 'Reconcile this imported order’s source state before editing its pricing.' },
      addressRefusal: null,
    };
  }
  return { planRefusal: null, addressRefusal: null };
}

export function assertImportedEditAllowed(admission: ImportedEditAdmission, mode: 'plan' | 'address'): void {
  const refusal = mode === 'plan' ? admission.planRefusal : admission.addressRefusal;
  if (refusal) throw new OrderEditError(409, refusal.code, refusal.message);
}
