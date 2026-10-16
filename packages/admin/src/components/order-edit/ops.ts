import type { AddressForm, EditContext, StagedEdit, WireOp } from './types';

const nz = (v: string) => (v.trim() ? v.trim() : undefined);

/** Parse a user-typed money string ("12.50", "-3") to integer cents; null when invalid. */
export function parseCents(raw: string): number | null {
  const t = raw.trim().replace(/^\$/, '');
  if (!/^-?\d+(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}

export const addressToWire = (a: AddressForm) => ({
  fullName: nz(a.fullName), line1: a.line1.trim(), line2: nz(a.line2), city: a.city.trim(),
  province: nz(a.province), postalCode: nz(a.postalCode), country: a.country.trim().toUpperCase(), phone: nz(a.phone),
});

/** Turn the staged page state into the wire op list the API expects (order matters:
 *  quantity changes first, then swaps, adds, coupon, shipping, adjustments, addresses). */
export function buildOps(ctx: EditContext, st: StagedEdit): WireOp[] {
  const ops: WireOp[] = [];
  for (const l of ctx.lines) {
    const q = st.qty[l.id];
    if (q != null && q !== l.quantity) ops.push({ op: 'set_quantity', lineId: l.id, quantity: q });
  }
  for (const [lineId, sw] of Object.entries(st.swaps)) ops.push({ op: 'swap_variant', lineId, sku: sw.sku, ...(sw.quantity ? { quantity: sw.quantity } : {}) });
  for (const a of st.adds) if (a.quantity > 0) ops.push({ op: 'add_item', sku: a.sku, quantity: a.quantity, ...(a.unitPrice != null ? { unitPrice: a.unitPrice } : {}) });
  if (st.coupon.mode === 'remove') ops.push({ op: 'remove_coupon' });
  else if (st.coupon.mode === 'apply' && st.coupon.code.trim()) ops.push({ op: 'apply_coupon', code: st.coupon.code.trim() });
  if (st.shipping.mode === 'method' && st.shipping.code) ops.push({ op: 'set_shipping_method', code: st.shipping.code });
  else if (st.shipping.mode === 'custom') ops.push({ op: 'set_shipping_amount', amount: Math.max(0, st.shipping.amountCents) });
  else if (st.shipping.mode === 'none') ops.push({ op: 'remove_shipping' });
  for (const id of st.adjRemove) ops.push({ op: 'remove_adjustment', adjustmentId: id });
  for (const a of st.adjAdd) if (a.label.trim() && a.amountCents !== 0) ops.push({ op: 'add_adjustment', label: a.label.trim(), amount: a.amountCents });
  for (const kind of ['shipping', 'billing'] as const) {
    const a = st.address[kind];
    if (a) ops.push({ op: 'set_address', kind, address: addressToWire(a), ...(st.address.saveToAddressBook ? { saveToAddressBook: true } : {}) });
  }
  return ops;
}

export const addressFromStored = (a: Partial<Record<keyof AddressForm, string | null>> | null): AddressForm => ({
  fullName: a?.fullName ?? '', line1: a?.line1 ?? '', line2: a?.line2 ?? '', city: a?.city ?? '',
  province: a?.province ?? '', postalCode: a?.postalCode ?? '', country: a?.country ?? '', phone: a?.phone ?? '',
});

export const addressValid = (a: AddressForm) => !!a.line1.trim() && !!a.city.trim() && /^[A-Za-z]{2}$/.test(a.country.trim());

/** Human labels for API warning codes. */
export const WARNING_TEXT: Record<string, string> = {
  SHIPPING_METHOD_INELIGIBLE: 'The current shipping method is not offered for this order any more — review the shipping line.',
  SHIPPING_METHOD_INFERRED: 'This older order has no recorded shipping method; it was inferred from the shipping total. Confirm the shipping line.',
  SHIPPING_BASE_UNKNOWN: 'The original shipping charge was waived by the removed discount and was never recorded — set the shipping method or amount explicitly.',
  PROMOTION_MISSING: 'The coupon on this order no longer exists, so its discount is dropped.',
};

/** Order-stored address JSON (canonical or legacy Vendure-ish keys) -> form values. */
export function storedToForm(a: Record<string, unknown> | null): AddressForm {
  const g = (...ks: string[]) => { for (const k of ks) if (a?.[k] != null && String(a[k]).trim()) return String(a[k]); return ''; };
  return {
    fullName: g('fullName'), line1: g('line1', 'streetLine1'), line2: g('line2', 'streetLine2'), city: g('city'),
    province: g('province', 'state'), postalCode: g('postalCode', 'zip'), country: g('country', 'countryCode').toUpperCase(), phone: g('phone'),
  };
}

/**
 * Refund-now eligibility for the chosen tender. The preview cannot pick a
 * payment itself, so with several refundable payments it reports "select which
 * payment to refund" — which the operator must be able to act on, not a dead end.
 * Mirrors the server's refundFeasibility (commit re-validates authoritatively).
 */
export function refundSelection(
  refund: { feasible: boolean; reason?: string; payments: { id: string; available: number }[] } | null,
  amount: number, paymentId: string,
): { selectable: boolean; ok: boolean; reason?: string } {
  if (!refund) return { selectable: true, ok: true };
  if (refund.feasible) return { selectable: true, ok: true };
  const needsPick = refund.payments.length > 1 && /select which payment/i.test(refund.reason ?? '');
  if (!needsPick) return { selectable: false, ok: false, reason: refund.reason };
  if (!paymentId) return { selectable: true, ok: false, reason: 'Select which payment to refund.' };
  const p = refund.payments.find((x) => x.id === paymentId);
  if (!p) return { selectable: true, ok: false, reason: 'The selected payment has nothing left to refund.' };
  if (amount > p.available) return { selectable: true, ok: false, reason: 'The refund exceeds what is left on that payment.' };
  if (amount === p.available) return { selectable: true, ok: false, reason: 'This would refund the whole payment — cancel or refund the order instead.' };
  return { selectable: true, ok: true };
}
