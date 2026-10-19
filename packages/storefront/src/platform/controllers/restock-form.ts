import type { FormResult } from '~/platform/views';
import type { RestockRequestInput } from '~/providers/shop/waitlist/waitlist';
import { EMAIL_PATTERN, type FormPort } from './forms';

export const PRODUCT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Waitlist admission needs complete, valid live coverage of enabled manifest SKUs.
 * The stock endpoint omits disabled/deleted variants; absence cannot prove sold out.
 * Purchase stock merging remains independent of this stricter waitlist-only check. */
export function hasAuthoritativeRestockStock(variants: readonly { sku: string; enabled?: boolean }[], stock: unknown): boolean {
	const enabled = variants.filter((v) => v.enabled !== false);
	const expected = new Set(enabled.map((v) => v.sku));
	if (!enabled.length || expected.size !== enabled.length || enabled.some((v) => !v.sku.trim())) return false;
	if (!stock || typeof stock !== 'object' || !('variants' in stock) || !Array.isArray(stock.variants)) return false;
	if (stock.variants.length !== expected.size) return false;
	const seen = new Set<string>();
	for (const value of stock.variants) {
		if (!value || typeof value !== 'object') return false;
		const row = value as { sku?: unknown; inStock?: unknown; availableQuantity?: unknown };
		const quantity = row.availableQuantity;
		if (typeof row.sku !== 'string' || !expected.has(row.sku) || seen.has(row.sku) || typeof row.inStock !== 'boolean') return false;
		if (quantity !== null && !(typeof quantity === 'number' && Number.isInteger(quantity) && quantity >= 0)) return false;
		if (row.inStock !== (quantity === null || (typeof quantity === 'number' && quantity > 0))) return false;
		seen.add(row.sku);
	}
	return seen.size === expected.size;
}

/** Shared form policy: one request, one fresh token, no variant fanout. */
export async function submitRestock(port: FormPort, request: (input: RestockRequestInput) => Promise<{ success: boolean; message?: string }>, productId: string, rawEmail: string, honeypot: string): Promise<FormResult> {
	const fail = (message: string, reason: 'invalid' | 'turnstile' | 'server'): FormResult => {
		port.setMessage(message);
		port.setStatus('error');
		return { ok: false, reason };
	};
	if (port.getStatus() === 'sending') return { ok: false, reason: 'busy' };
	const email = rawEmail.trim();
	if (!PRODUCT_UUID.test(productId)) return fail('This product cannot be tracked for restock.', 'invalid');
	if (!EMAIL_PATTERN.test(email) || email.length > 320) return fail('Please enter a valid email address.', 'invalid');
	const turnstileToken = port.getToken();
	if (port.turnstileRequired && !turnstileToken) return fail('Please complete the security check.', 'turnstile');
	port.setStatus('sending');
	port.setMessage('');
	port.clearToken();
	port.resetWidget();
	try {
		const result = await request({ productId, email, turnstileToken, honeypot });
		if (!result.success) return fail(result.message || 'Could not submit. Please try again.', 'server');
		port.setStatus('success');
		return { ok: true };
	} catch {
		return fail('Could not submit. Please try again.', 'server');
	}
}
