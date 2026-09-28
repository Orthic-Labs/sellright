/**
 * Customer/account data provider — native SellRight client (PASS 3). Talks to
 * the API exclusively through `~/sellright/client`; zero Vendure shapes, no
 * `~/generated/graphql-shop` imports, no `~/utils/sellright-adapters` mapping
 * to a Vendure-ish Customer/Order. Every export returns the API's own native
 * payload (or a thin wrapper around it), and pagination carries the server's
 * real `total` — never the page array's length.
 *
 * The build guard (`guard-graphql-customer.sh`) requires this file carry no
 * runtime `graphql-tag` — it has none.
 */
import { sellright, SellRightError } from '~/sellright/client';
import { describeAccountError, type AccountError } from '~/sellright/types/account';
import type {
	AccountOrderDetail,
	AccountOrderList,
	Address,
	AuthCustomer,
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

// ─────────────────────────────────────────────────────────────────────────────
// Compatibility shims — Vendure-ish shapes for checkout/cart call sites.
//
// Checkout (`components/checkout/**`, `routes/checkout/**`,
// `components/shipping/**`, `services/local-address-sync.ts`,
// `utils/addressStorage.ts`) is explicitly out of scope for this pass and must
// not be edited. Those files were built against the old PASS-2 exports of
// this module (Vendure-shaped `Customer`/`Address`, `{ createCustomerAddress:
// {...} }` mutation wrappers). Rather than touch checkout to consume the new
// native functions above, these thin wrappers preserve the exact old
// names/shapes on top of the new native calls — same adapters
// (`~/utils/sellright-adapters`) checkout already depended on transitively,
// just re-wired to the native client instead of the old `~/utils/sellright`
// `sr*` helpers. Account/auth code itself never calls these — it uses the
// native functions above directly.
import { adaptCustomer, toAddressInput } from '~/utils/sellright-adapters';
// Vendure-ish types, used ONLY for the cast at this shim boundary — matching
// exactly what PASS 2 did (`as unknown as Customer`) so the unedited checkout
// call sites type-check against the same shape they always have.
import type { Customer } from '~/generated/graphql-shop';

export async function getActiveCustomerQuery(): Promise<Customer> {
	const me = await getMe();
	return (me ? adaptCustomer(me) : null) as unknown as Customer;
}

export async function getActiveCustomerCached(): Promise<Customer> {
	const cacheKey = 'active-customer-legacy';
	const cached = getCached<Customer>(cacheKey);
	if (cached !== null) return cached;
	const result = await getActiveCustomerQuery();
	setCached(cacheKey, result);
	return result;
}

export async function getActiveCustomerAddressesQuery(): Promise<Customer> {
	const [me, addresses] = await Promise.all([getMe(), getAddresses()]);
	return (me ? adaptCustomer(me, addresses) : null) as unknown as Customer;
}

export async function getActiveCustomerAddressesCached(): Promise<Customer> {
	const cacheKey = 'customer-addresses-legacy';
	const cached = getCached<Customer>(cacheKey);
	if (cached !== null) return cached;
	const result = await getActiveCustomerAddressesQuery();
	setCached(cacheKey, result);
	return result;
}

type LegacyAddressFields = {
	fullName?: string | null;
	streetLine1?: string | null;
	streetLine2?: string | null;
	city?: string | null;
	province?: string | null;
	postalCode?: string | null;
	countryCode?: string | null;
	phoneNumber?: string | null;
	defaultShippingAddress?: boolean | null;
	defaultBillingAddress?: boolean | null;
};

// `any` return (matching PASS 2's own `as any`): checkout reads
// `.createCustomerAddress.__typename`, a Vendure-ism this shim's input never
// carries — same pre-existing quirk as before, not something this pass
// introduces or is scoped to fix (checkout is out of bounds here).
export async function createCustomerAddressMutation(
	input: LegacyAddressFields & Record<string, unknown>,
	_token?: string,
): Promise<any> {
	const { id } = await createAddress(toAddressInput(input) as NewAddressInput);
	return { createCustomerAddress: { id, ...input } };
}

export async function updateCustomerAddressMutation(
	input: LegacyAddressFields & { id: string } & Record<string, unknown>,
	_token?: string,
): Promise<any> {
	const { id, ...rest } = input;
	await updateAddress(id, toAddressInput(rest) as AddressPatch);
	return { updateCustomerAddress: input };
}
