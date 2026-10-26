import { sellright } from '~/sellright/client';

export interface EmailStatus {
	exists: boolean;
	/** The account exists but has no password (imported from another platform): offer "set your password" (the
	 *  reset-password email) instead of a password prompt that can never succeed. Only true alongside `exists`. */
	needsPasswordSetup: boolean;
}

/**
 * Pre-submit "is this email registered?" check — native SellRight client
 * (GET /v1/shop/auth/check-email). Rate-limited server-side (10/min/IP; over
 * the limit the API answers a silent exists:false, as the previous platform did); forwards
 * the Turnstile token and honeypot value as query params so the anti-bot
 * challenge is preserved end to end, never silently dropped.
 */
export async function checkEmailStatus(
	email: string,
	turnstileToken?: string,
	honeypot?: string,
): Promise<EmailStatus> {
	try {
		const { data } = await sellright().GET('/v1/shop/auth/check-email', {
			params: { query: { email, turnstileToken, honeypot } },
		});
		const exists = data?.exists ?? false;
		return { exists, needsPasswordSetup: exists && data?.needsPasswordSetup === true };
	} catch {
		return { exists: false, needsPasswordSetup: false };
	}
}

export async function checkCustomerEmail(
	email: string,
	turnstileToken?: string,
	honeypot?: string,
): Promise<boolean> {
	return (await checkEmailStatus(email, turnstileToken, honeypot)).exists;
}
