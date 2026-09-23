/**
 * Customer provider — migrated from Vendure GraphQL to the SellRight REST shop
 * API (PASS 2). The exported function names + return shapes match what the
 * account pages / checkout already consume (Vendure-ish Customer/Address/Order);
 * the adapters in ~/utils/sellright-adapters do the shape mapping. The build
 * guard (guard-graphql-customer.sh) requires this file carry no runtime
 * graphql-tag — REST has none, so it passes.
 */
import type {
	CreateAddressInput,
	Customer,
	UpdateAddressInput,
} from '~/generated/graphql-shop';
import {
	srMe,
	srGetAddresses,
	srChangePassword,
	srDeleteAddress,
	srAccountOrders,
	srAccountOrder,
	srUpdateAddress,
	srCreateAddress,
	srLogout,
	srErrorStatus,
} from '~/utils/sellright';
import type { Order } from '~/generated/graphql-shop';
import {
	adaptCustomer,
	adaptAccountOrders,
	adaptOrderDetail,
	toAddressInput,
} from '~/utils/sellright-adapters';

// 🚀 CUSTOMER QUERY CACHE - 3-minute cache for customer data
const customerCache = new Map<string, { data: any; timestamp: number }>();
const CUSTOMER_CACHE_DURATION = 3 * 60 * 1000; // 3 minutes

const getCachedCustomerQuery = (key: string) => {
	const cached = customerCache.get(key);
	if (cached && Date.now() - cached.timestamp < CUSTOMER_CACHE_DURATION) {
		return cached.data;
	}
	return null;
};

const setCachedCustomerQuery = (key: string, data: any) => {
	customerCache.set(key, { data, timestamp: Date.now() });
	// Keep customer cache reasonable
	if (customerCache.size > 30) {
		const oldestKey = customerCache.keys().next().value;
		if (oldestKey) {
			customerCache.delete(oldestKey);
		}
	}
};

// Clear customer cache when data changes (mutations)
const clearCustomerCache = () => {
	customerCache.clear();
};

/** A 401 means "not logged in" — return null (the Vendure activeCustomer null). */
const nullOn401 = (e: unknown): null => {
	if (srErrorStatus(e) === 401) return null;
	throw e;
};

export const getActiveCustomerQuery = async (): Promise<Customer> => {
	try {
		const me = await srMe();
		return adaptCustomer(me) as unknown as Customer;
	} catch (e) {
		return nullOn401(e) as unknown as Customer;
	}
};

export const getActiveCustomerAddressesQuery = async (): Promise<Customer> => {
	try {
		const [me, addrs] = await Promise.all([srMe(), srGetAddresses()]);
		return adaptCustomer(me, addrs.items) as unknown as Customer;
	} catch (e) {
		return nullOn401(e) as unknown as Customer;
	}
};

export const updateCustomerPasswordMutation = async (
	currentPassword: string,
	newPassword: string
) => {
	try {
		await srChangePassword(currentPassword, newPassword);
		clearCustomerCacheAfterMutation();
		return { __typename: 'Success', success: true } as { __typename: string; message?: string; success?: boolean };
	} catch (e) {
		// 401 → wrong current password (or unauthenticated). Map to the Vendure
		// InvalidCredentialsError the password page switches on.
		if (srErrorStatus(e) === 401) {
			return { __typename: 'InvalidCredentialsError', message: 'Current password is incorrect' } as { __typename: string; message?: string; success?: boolean };
		}
		throw e;
	}
};

export const deleteCustomerAddressMutation = async (id: string) => {
	const result = await srDeleteAddress(id);
	clearCustomerCacheAfterMutation();
	return result;
};

export const getActiveCustomerOrdersQuery = async (): Promise<Customer> => {
	try {
		const orders = await srAccountOrders();
		// Shape like Vendure's activeCustomer.orders.items.
		return { orders: { items: adaptAccountOrders(orders), totalItems: orders.items.length } } as unknown as Customer;
	} catch (e) {
		return nullOn401(e) as unknown as Customer;
	}
};

/** Owned order detail by code (account history) — REST account-order endpoint.
 *  Distinct from the checkout-confirmation getOrderByCodeQuery (still Vendure),
 *  which needs payment/shipping detail this endpoint doesn't carry. */
export const getAccountOrderByCodeQuery = async (code: string): Promise<Order | null> => {
	try {
		const o = await srAccountOrder(code);
		return adaptOrderDetail(o) as unknown as Order;
	} catch (e) {
		if (srErrorStatus(e) === 404 || srErrorStatus(e) === 401) return null;
		throw e;
	}
};

export const updateCustomerAddressMutation = async (
	input: UpdateAddressInput,
	_token?: string | undefined
) => {
	// UpdateAddressInput carries the Vendure address id + the changed fields.
	const { id, ...rest } = input as UpdateAddressInput & { id: string };
	await srUpdateAddress(id, toAddressInput(rest as any));
	clearCustomerCacheAfterMutation();
	// Callers read result.updateCustomerAddress; return the input echoed back.
	return { updateCustomerAddress: { ...input } } as any;
};

export const createCustomerAddressMutation = async (
	input: CreateAddressInput,
	_token?: string | undefined
) => {
	const { id } = await srCreateAddress(toAddressInput(input as any));
	clearCustomerCacheAfterMutation();
	return { createCustomerAddress: { id, ...input } } as any;
};

export const logoutMutation = async () => {
	try {
		await srLogout();
	} catch {
		// logout is best-effort — a 403 (stale CSRF) still clears client state.
	}
	clearCustomerCache();
	return { success: true } as any;
};

// 🚀 CACHED CUSTOMER QUERIES - Better performance for account pages

export const getActiveCustomerCached = async () => {
	const cacheKey = 'active-customer';
	const cached = getCachedCustomerQuery(cacheKey);
	if (cached) return cached;

	const result = await getActiveCustomerQuery();
	setCachedCustomerQuery(cacheKey, result);
	return result;
};

export const getActiveCustomerAddressesCached = async () => {
	const cacheKey = 'customer-addresses';
	const cached = getCachedCustomerQuery(cacheKey);
	if (cached) return cached;

	const result = await getActiveCustomerAddressesQuery();
	setCachedCustomerQuery(cacheKey, result);
	return result;
};

export const getActiveCustomerOrdersCached = async () => {
	const cacheKey = 'customer-orders';
	const cached = getCachedCustomerQuery(cacheKey);
	if (cached) return cached;

	const result = await getActiveCustomerOrdersQuery();
	setCachedCustomerQuery(cacheKey, result);
	return result;
};

// Clear cache after mutations that change customer data
export const clearCustomerCacheAfterMutation = () => {
	clearCustomerCache();
};
