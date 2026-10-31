/**
 * ADR-0001 §1 (I-2): the signed-in customer is a per-visitor value, so it never renders into the page HTML. The browser
 * asks `/api/session/` (a `no-store` endpoint) once per page load; this is that endpoint's logic. It is what the root
 * layout's auth loader did before: the same cookie gate (no API read for a visitor without credentials), the same
 * `sr_legacy_cart` hint for HttpOnly legacy transport, and the same `/v1/shop/auth/me` read that adopts imported
 * credentials (its Set-Cookie headers are forwarded onto this endpoint's response).
 */
import { AUTH_TOKEN } from '~/constants';
import { bootstrapCustomer } from '~/providers/shop/account/bootstrap.server';
import { srErrorStatus } from '~/utils/sellright';
import type { SessionCustomer, SessionPayload } from '~/utils/session-customer';

/** Set while the browser holds HttpOnly legacy transport; CartService reads it to run the one-time legacy cart claim. */
export const LEGACY_CART_HINT_COOKIE = 'sr_legacy_cart';

type CookieJar = {
	get(name: string): { value: string } | null | undefined;
	set(name: string, value: string, options: { path: string; maxAge: number; sameSite: 'lax'; secure: boolean }): void;
};

export type SessionRequest = {
	cookie: CookieJar;
	headers: Pick<Headers, 'append'>;
	url: URL;
	sharedMap?: Map<string, unknown>;
	isDemo: boolean;
};

const ANONYMOUS: SessionPayload = { customer: null };

/** Throws on any API failure other than 401 (the endpoint answers that with a non-200 the client ignores). */
export async function resolveSessionCustomer({ cookie, headers, url, sharedMap, isDemo }: SessionRequest): Promise<SessionPayload> {
	const hasToken = !!cookie.get(AUTH_TOKEN)?.value;
	const hasLegacyTransport = !!(cookie.get('authToken')?.value || cookie.get('__vendure_session')?.value);
	if (isDemo || (!hasToken && !hasLegacyTransport)) return ANONYMOUS;
	// HttpOnly legacy transport is invisible to JS. Presence prompts one proof-checked cart request, never authentication.
	if (!hasToken && hasLegacyTransport) {
		cookie.set(LEGACY_CART_HINT_COOKIE, '1', { path: '/', maxAge: 3600, sameSite: 'lax', secure: url.protocol === 'https:' });
	}
	try {
		const data = await bootstrapCustomer(headers, sharedMap);
		const customer: SessionCustomer = {
			id: data.id, firstName: data.firstName ?? '', lastName: data.lastName ?? '', emailAddress: data.email,
		};
		return { customer };
	} catch (error) {
		if (srErrorStatus(error) !== 401) throw error;
		return ANONYMOUS;
	}
}
