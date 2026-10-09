/**
 * Customer/account data provider — the native SellRight client. Talks to
 * the API exclusively through `~/sellright/client`; every export returns the
 * API's own native payload (or a thin wrapper around it), and pagination
 * carries the server's real `total` — never the page array's length.
 */
import { sellright, SellRightError } from '~/sellright/client';
import { describeAccountError, type AccountError } from '~/sellright/types/account';
import type {
	AccountOrderDetail,
	AccountOrderList,
	Address,
	AuthCustomer,
	OrderReturns,
	NewAddressInput,
	AddressPatch,
} from '~/sellright/types/account';

// Query result cache — unrelated to stock/pricing data (never touches the
// locked stock architecture); this only memoizes the current customer's own
// profile/address/order reads for a few minutes to avoid refetching on every
// account sub-page nav within one visit.
const customerCache = new Map<string, { data: unknown; timestamp: number }>();
const CUSTOMER_CACHE_DURATION = 3 * 60 * 1000; // 3 minutes

function getCached<T>(key: string): T | null {
	const cached = customerCache.get(key);
	if (cached && Date.now() - cached.timestamp < CUSTOMER_CACHE_DURATION) {
		return cached.data as T;
	}
	return null;
}

function setCached(key: string, data: unknown): void {
	customerCache.set(key, { data, timestamp: Date.now() });
	if (customerCache.size > 30) {
		const oldestKey = customerCache.keys().next().value;
		if (oldestKey) customerCache.delete(oldestKey);
	}
}

export const clearCustomerCacheAfterMutation = (): void => customerCache.clear();

/** A 401 means "not signed in" — resolve `null` rather than throw, mirroring
 *  every other read below. Any other failure still propagates. */
function nullOn401(e: unknown): null {
	if (e instanceof SellRightError && e.status === 401) return null;
	throw e;
}

export async function getMe(): Promise<AuthCustomer | null> {
	try {
		const { data } = await sellright().GET('/v1/shop/auth/me');
		return data!;
	} catch (e) {
		return nullOn401(e);
	}
}

export async function getMeCached(): Promise<AuthCustomer | null> {
	const cacheKey = 'me';
	const cached = getCached<AuthCustomer | null>(cacheKey);
	if (cached !== null) return cached;
	const result = await getMe();
	setCached(cacheKey, result);
	return result;
}

export async function getAddresses(): Promise<Address[]> {
	try {
		const { data } = await sellright().GET('/v1/shop/account/addresses');
		return data?.items ?? [];
	} catch (e) {
		if (e instanceof SellRightError && e.status === 401) return [];
		throw e;
	}
}

export type ChangePasswordResult = { ok: true } | ({ ok: false } & AccountError);

export async function changePassword(currentPassword: string, newPassword: string): Promise<ChangePasswordResult> {
	try {
		await sellright().POST('/v1/shop/account/password', { body: { currentPassword, newPassword } });
		clearCustomerCacheAfterMutation();
		return { ok: true };
	} catch (e) {
		// 401 on this endpoint means "current password is wrong" (the session
		// itself is already known-good — account pages are behind the auth
		// guard) — never conflate it with "unauthenticated".
		return { ok: false, ...describeAccountError(e, { 401: 'wrong_password' }) };
	}
}

export async function deleteAddress(id: string): Promise<{ ok: boolean }> {
	const { data } = await sellright().DELETE('/v1/shop/account/addresses/{id}', { params: { path: { id } } });
	clearCustomerCacheAfterMutation();
	return data!;
}

/** Real pagination — `total` is the server's true order count, not the
 *  returned page's array length (which under-reports past `limit` orders). */
export async function getOrders(opts: { limit?: number; offset?: number } = {}): Promise<AccountOrderList> {
	try {
		const { data } = await sellright().GET('/v1/shop/account/orders', {
			params: { query: { limit: opts.limit, offset: opts.offset } },
		});
		return data!;
	} catch (e) {
		if (e instanceof SellRightError && e.status === 401) return { items: [], total: 0, limit: opts.limit ?? 20, offset: opts.offset ?? 0 };
		throw e;
	}
}

/** Owned order detail by code (account history). Distinct from the
 *  checkout-confirmation order lookup, which is unauthenticated/receipt-token
 *  based and out of this file's scope. */
export async function getOrderByCode(code: string): Promise<AccountOrderDetail | null> {
	try {
		const { data } = await sellright().GET('/v1/shop/account/orders/{code}', { params: { path: { code } } });
		return data!;
	} catch (e) {
		if (e instanceof SellRightError && (e.status === 404 || e.status === 401)) return null;
		throw e;
	}
}

/** What can still be returned on an owned order + the return requests made so far (live, never cached). */
export async function getOrderReturns(code: string): Promise<OrderReturns | null> {
	try {
		const { data } = await sellright().GET('/v1/shop/account/orders/{code}/returns', { params: { path: { code } } });
		return data!;
	} catch (e) {
		if (e instanceof SellRightError && (e.status === 404 || e.status === 401)) return null;
		throw e;
	}
}

export type RequestReturnResult = { ok: true; id: string } | ({ ok: false } & AccountError);

/** Ask to return shipped units of an owned order. 409 = nothing (or not that many) can be returned. */
export async function requestOrderReturn(
	code: string,
	input: { lines: Array<{ sku: string; quantity: number }>; reason: string },
): Promise<RequestReturnResult> {
	try {
		const { data } = await sellright().POST('/v1/shop/account/orders/{code}/returns', { params: { path: { code } }, body: input });
		return { ok: true, id: data!.id };
	} catch (e) {
		return { ok: false, ...describeAccountError(e, { 409: 'not_returnable' }) };
	}
}

export async function createAddress(input: NewAddressInput): Promise<{ id: string }> {
	const { data } = await sellright().POST('/v1/shop/account/addresses', { body: input });
	clearCustomerCacheAfterMutation();
	return data!;
}

export async function updateAddress(id: string, input: AddressPatch): Promise<{ ok: boolean }> {
	const { data } = await sellright().PATCH('/v1/shop/account/addresses/{id}', {
		params: { path: { id } },
		body: input,
	});
	clearCustomerCacheAfterMutation();
	return data!;
}

// ── Cached reads for account sub-pages ──────────────────────────────────────

export async function getAddressesCached(): Promise<Address[]> {
	const cacheKey = 'addresses';
	const cached = getCached<Address[]>(cacheKey);
	if (cached) return cached;
	const result = await getAddresses();
	setCached(cacheKey, result);
	return result;
}
