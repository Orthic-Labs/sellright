/**
 * ADR-0001 §1 (I-2): the browser side of "who is signed in". The page HTML carries no customer identity; the root layout
 * calls `fetchSessionCustomer()` once per page load (and per client navigation, where the old root loader re-ran) and
 * puts the answer into `appState.customer`. Nothing here is cached beyond the call: every read is a fresh `no-store`
 * request.
 */
import { CUSTOMER_NOT_DEFINED_ID } from '~/constants';

/** The `no-store` endpoint (src/routes/api/session/index.ts). */
export const SESSION_ENDPOINT = '/api/session/';

export type SessionCustomer = { id: string; firstName: string; lastName: string; emailAddress?: string };
export type SessionPayload = { customer: SessionCustomer | null };

/** `unknown`: the read failed (network, 5xx, malformed body). The caller keeps whatever state it has. */
export type SessionResult = { status: 'signed-in'; customer: SessionCustomer } | { status: 'anonymous' } | { status: 'unknown' };

export const anonymousCustomer = (): SessionCustomer => ({ id: CUSTOMER_NOT_DEFINED_ID, firstName: '', lastName: '', emailAddress: '' });

const isCustomer = (value: unknown): value is SessionCustomer => {
	const c = value as Partial<SessionCustomer> | null;
	return !!c && typeof c.id === 'string' && c.id.length > 0 && c.id !== CUSTOMER_NOT_DEFINED_ID
		&& typeof c.firstName === 'string' && typeof c.lastName === 'string';
};

/**
 * #412: this page's session read. Object holder so the minifier cannot fold it. `latest` is the most recent read for the current
 * page (the root layout starts one on every load and client navigation), so a page asking "who is signed in" takes that answer
 * instead of a second GET /api/session/. `early` is a read such a page had to start itself because the layout's had not begun
 * yet; the layout's next read joins it once instead of sending its own. Nothing outlives the page.
 */
const pageRead: { latest?: Promise<SessionResult>; early?: Promise<SessionResult> } = {};

/**
 * Lane 11: the readable cookies that can mean "this browser may be signed in". Sign-in (API auth/cookies.ts setCustomerCookies)
 * sets the HttpOnly `sr_cust` together with the readable `sr_cust_csrf`, same path and lifetime, and sign-out clears both. The
 * imported legacy transport is `authToken` (the previous Damned store wrote it from JS, so it is readable) or the endpoint's own
 * `sr_legacy_cart` hint. Without any of them the endpoint can only answer "anonymous", so the page skips the request.
 */
export const SESSION_MARKER_COOKIES = ['sr_cust_csrf', 'authToken', 'sr_legacy_cart'] as const;

/** Whether `cookieHeader` (document.cookie) carries a session marker (non-empty value). Pure. */
export function hasSessionMarker(cookieHeader: string): boolean {
	return SESSION_MARKER_COOKIES.some((name) => new RegExp(`(?:^|;\\s*)${name}=[^;\\s]`).test(cookieHeader));
}

/** The page's own read: anonymous at once (no request) when the browser holds no session marker. */
function readPageSession(): Promise<SessionResult> {
	if (typeof document !== 'undefined' && !hasSessionMarker(document.cookie)) return Promise.resolve({ status: 'anonymous' });
	return readSessionCustomer(fetch);
}

/** A fresh `no-store` read of the session (the layout's per page). An explicit `fetchImpl` always reads on its own. */
export function fetchSessionCustomer(fetchImpl?: typeof fetch): Promise<SessionResult> {
	if (fetchImpl) return readSessionCustomer(fetchImpl);
	const early = pageRead.early;
	pageRead.early = undefined;
	if (early) return early;
	const read = readPageSession();
	pageRead.latest = read;
	return read;
}

/** The session read for the current page (in flight or settled); starts it when the layout has not yet. */
export function pageSessionCustomer(): Promise<SessionResult> {
	if (pageRead.latest) return pageRead.latest;
	const read = readPageSession();
	pageRead.latest = read;
	pageRead.early = read;
	return read;
}

/** Test seam: forget the page's reads. */
export function resetPageSessionForTest(): void {
	pageRead.latest = undefined;
	pageRead.early = undefined;
}

async function readSessionCustomer(fetchImpl: typeof fetch): Promise<SessionResult> {
	try {
		const response = await fetchImpl(SESSION_ENDPOINT, { cache: 'no-store', credentials: 'same-origin', priority: 'low', headers: { accept: 'application/json' } });
		if (!response.ok) return { status: 'unknown' };
		const body = (await response.json()) as Partial<SessionPayload> | null;
		if (!body || !('customer' in body)) return { status: 'unknown' };
		if (body.customer === null) return { status: 'anonymous' };
		return isCustomer(body.customer) ? { status: 'signed-in', customer: body.customer } : { status: 'unknown' };
	} catch {
		return { status: 'unknown' };
	}
}

/**
 * Next `appState.customer` for a session read, or `null` to leave it unchanged. Fields the page added for the same
 * customer (phone, title from the account area or checkout) stay; a different customer replaces them.
 */
export function nextCustomer<T extends { id: string }>(current: T, result: SessionResult): T | SessionCustomer | null {
	if (result.status === 'unknown') return null;
	if (result.status === 'anonymous') return current.id === CUSTOMER_NOT_DEFINED_ID ? null : anonymousCustomer();
	return current.id === result.customer.id ? { ...current, ...result.customer } : { ...result.customer };
}
