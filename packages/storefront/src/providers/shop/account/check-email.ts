import { srCheckEmail } from '~/utils/sellright';

/**
 * Pre-submit "is this email registered?" check — migrated to the SellRight REST
 * shop API (GET /v1/shop/auth/check-email). The endpoint is rate-limited
 * server-side and preserves the storefront's anti-bot challenge.
 */
export async function checkCustomerEmail(
	email: string,
	turnstileToken?: string,
	honeypot?: string,
): Promise<boolean> {
	try {
		const result = await srCheckEmail(email, turnstileToken, honeypot);
		return result.exists ?? false;
	} catch {
		return false;
	}
}
