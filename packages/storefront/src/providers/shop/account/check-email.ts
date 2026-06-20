import { srCheckEmail } from '~/utils/sellright';

/**
 * Pre-submit "is this email registered?" check — migrated to the SellRight REST
 * shop API (GET /v1/shop/auth/check-email). The endpoint is rate-limited
 * server-side; the turnstile/honeypot args are kept for call-site compatibility
 * but the REST endpoint does not take them.
 */
export async function checkCustomerEmail(
	email: string,
	_turnstileToken?: string,
	_honeypot?: string,
): Promise<boolean> {
	try {
		const result = await srCheckEmail(email);
		return result.exists ?? false;
	} catch {
		return false;
	}
}
