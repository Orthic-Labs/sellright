/**
 * Pure helpers for the account "Request a return" panel (no framework or
 * network imports, so they are unit-testable under `node --test`).
 */

export type ReturnStatus = 'requested' | 'approved' | 'received' | 'refunded' | 'rejected';

/** Shopper-facing copy for each return status the API reports. */
export const RETURN_STATUS_LABEL: Record<ReturnStatus, { label: string; hint: string }> = {
	requested: { label: 'Return requested', hint: 'We are reviewing your request.' },
	approved: { label: 'Return approved', hint: 'Your refund is being processed.' },
	received: { label: 'Return received', hint: 'We have your items and are processing your refund.' },
	refunded: { label: 'Refunded', hint: 'Your refund has been issued to your original payment method.' },
	rejected: { label: 'Return not approved', hint: 'Contact us if you have questions about this decision.' },
};

/** Label for a status, tolerating a status this storefront does not know yet. */
export const returnStatusLabel = (status: string): { label: string; hint: string } =>
	RETURN_STATUS_LABEL[status as ReturnStatus] ?? { label: 'Return requested', hint: 'We are reviewing your request.' };

export const MIN_RETURN_REASON_LENGTH = 3;

export type ReturnRequestBuild =
	| { ok: true; lines: Array<{ sku: string; quantity: number }>; reason: string }
	| { ok: false; message: string };

/**
 * Turn the form state (per-SKU quantity picks + free-text reason) into the API
 * body. Only positive whole quantities count; nothing about what is eligible
 * is decided here — the API re-checks every line and answers 409 when too many
 * units are asked for.
 */
export const buildReturnRequest = (qty: Record<string, number>, reason: string): ReturnRequestBuild => {
	const lines = Object.entries(qty)
		.filter(([sku, n]) => sku && Number.isInteger(n) && n > 0)
		.map(([sku, quantity]) => ({ sku, quantity }));
	if (lines.length === 0) return { ok: false, message: 'Choose at least one item to return.' };
	const trimmed = reason.trim();
	if (trimmed.length < MIN_RETURN_REASON_LENGTH) return { ok: false, message: 'Tell us briefly why you are returning it.' };
	return { ok: true, lines, reason: trimmed };
};
