/**
 * Order editing (G13): a refund issued to hand back the difference when an edit
 * LOWERED an order's total. It is tagged by refund.metadata.source (atomic with the
 * refund row's creation — no later write needed) so the two places that must
 * treat it differently can recognise it:
 *  - settle.ts `editRefundedTotal`: the order's grandTotal was already reduced
 *    by the edit, so this refund must not read as "the customer owes it again";
 *  - refunds.ts `finalizeRefund`: the order was not "refunded" in the item/return
 *    sense, so it keeps its state (Paid stays Paid) instead of flipping to
 *    PartiallyRefunded.
 */
export const EDIT_REFUND_PREFIX = '[order-edit]';
export const editRefundReason = (reason?: string | null): string =>
  `${EDIT_REFUND_PREFIX} ${reason?.trim() || 'order edit'}`.slice(0, 500);
/** The authoritative tag is refund.metadata.source, set only server-side by
 *  requestRefund({ source: 'order_edit' }). The reason prefix is display text. */
export const EDIT_REFUND_SOURCE = 'order_edit';
export const isEditRefund = (metadata: unknown): boolean =>
  (metadata as { source?: unknown } | null)?.source === EDIT_REFUND_SOURCE;
