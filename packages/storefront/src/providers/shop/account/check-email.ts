import { sellright } from '~/sellright/client';

/**
 * Pre-submit "is this email registered?" check — native SellRight client
 * (GET /v1/shop/auth/check-email). Rate-limited server-side; forwards the
 * Turnstile token and honeypot value as query params so the anti-bot
 * challenge is preserved end to end, never silently dropped.
 */
export async function checkCustomerEmail(
	email: string,
	turnstileToken?: string,
	honeypot?: string,
): Promise<boolean> {
	try {
		const { data } = await sellright().GET('/v1/shop/auth/check-email', {
			params: { query: { email, turnstileToken, honeypot } },
		});
		return data?.exists ?? false;
	} catch {
		return false;
	}
}
