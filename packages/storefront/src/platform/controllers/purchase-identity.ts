// Hashed customer identifiers for the purchase conversion (ad platforms' enhanced matching). Raw email and phone never
// leave this module: only the SHA-256 hex of the normalised value does (email trimmed + lowercased; phone in E.164).
import type { CountryCode } from 'libphonenumber-js';

export interface PurchaseUserData {
	sha256EmailAddress?: string;
	sha256PhoneNumber?: string;
}

export const normalizeEmail = (email: string | null | undefined): string | null => {
	const e = (email ?? '').trim().toLowerCase();
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
};

/** E.164 (+15032271234) for a phone in the order's shipping country, or null when it does not parse as valid. */
export async function normalizePhoneE164(phone: string | null | undefined, country: string | null | undefined): Promise<string | null> {
	const raw = (phone ?? '').trim();
	if (!raw) return null;
	const { parsePhoneNumberFromString } = await import('libphonenumber-js');
	const parsed = parsePhoneNumberFromString(raw, (country || 'US').toUpperCase() as CountryCode);
	return parsed?.isValid() ? parsed.number : null;
}

export async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Hashed identifiers for one order; empty when it carries none (a field is present only when its value normalised). */
export async function purchaseUserData(order: { email?: string | null; phone?: string | null; country?: string | null }): Promise<PurchaseUserData> {
	const out: PurchaseUserData = {};
	const email = normalizeEmail(order.email);
	if (email) out.sha256EmailAddress = await sha256Hex(email);
	const phone = await normalizePhoneE164(order.phone, order.country).catch(() => null);
	if (phone) out.sha256PhoneNumber = await sha256Hex(phone);
	return out;
}
