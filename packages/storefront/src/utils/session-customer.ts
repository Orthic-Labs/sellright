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

export async function fetchSessionCustomer(fetchImpl: typeof fetch = fetch): Promise<SessionResult> {
	try {
		const response = await fetchImpl(SESSION_ENDPOINT, { cache: 'no-store', credentials: 'same-origin', headers: { accept: 'application/json' } });
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
