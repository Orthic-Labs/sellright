import type { RequestHandler } from '@qwik.dev/router';
import { srErrorStatus, srNewsletterSignup } from '~/utils/sellright';
import { withVisitorIp } from '~/utils/sellright-visitor-ip.server';

/**
 * POST /newsletter-signup — the homepage's newsletter form posts here
 * (`routes/index.tsx` `handleNewsletterSubmit`). This route didn't exist
 * before: the form was fetching a path the dev proxy (`/v1`, `/assets` only —
 * see vite.config.ts) never forwards, so every signup 404'd. Kept as its own
 * tiny route (rather than pointing the form straight at
 * `/v1/shop/newsletter-signup`) so the storefront owns its own honeypot gate
 * and error-message shaping, matching the `/contact` route's pattern.
 */
/** Honeypot fake-success plus 429/403 message shaping. The call goes through sr() so the visitor IP is forwarded and the API's 5/hr/IP limit is per visitor. */
async function signup(email: string, honeypot?: string, turnstileToken?: string): Promise<{ ok: boolean; message?: string }> {
	if (honeypot) return { ok: true };
	try {
		await srNewsletterSignup({ email, turnstileToken: turnstileToken || undefined });
		return { ok: true };
	} catch (err) {
		if (srErrorStatus(err) === 429) return { ok: false, message: 'Too many signups from this IP. Try again in an hour.' };
		if (srErrorStatus(err) === 403) return { ok: false, message: 'Security check failed. Please try again.' };
		return { ok: false, message: 'Subscription failed. Please try again.' };
	}
}

export const onPost: RequestHandler = async (event) => {
	const { request, json } = event;
	let body: { email?: unknown; honeypot?: unknown; turnstileToken?: unknown };
	try {
		body = await request.json();
	} catch {
		json(400, { ok: false, message: 'Invalid request body.' });
		return;
	}

	const email = typeof body.email === 'string' ? body.email.trim() : '';
	const honeypot = typeof body.honeypot === 'string' ? body.honeypot : undefined;

	if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
		json(400, { ok: false, message: 'Please enter a valid email.' });
		return;
	}

	const turnstileToken = typeof body.turnstileToken === 'string' ? body.turnstileToken : undefined;
	const result = await withVisitorIp(event, () => signup(email, honeypot, turnstileToken));
	json(result.ok ? 200 : result.message?.includes('Too many') ? 429 : result.message?.includes('Security check') ? 403 : 400, result);
};
