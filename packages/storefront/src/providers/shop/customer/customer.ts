import {
	CreateAddressInput,
	Customer,
	UpdateAddressInput,
	ActiveCustomerOrdersQueryVariables,
} from '~/generated/graphql-shop';
import {
	ActiveCustomerDocument,
	type ActiveCustomerQuery,
	type ActiveCustomerQueryVariables,
	ActiveCustomerAddressesDocument,
	type ActiveCustomerAddressesQuery,
	type ActiveCustomerAddressesQueryVariables,
	UpdateCustomerPasswordMutationDocument,
	type UpdateCustomerPasswordMutationMutation,
	type UpdateCustomerPasswordMutationMutationVariables,
	DeleteCustomerAddressDocument,
	type DeleteCustomerAddressMutation,
	type DeleteCustomerAddressMutationVariables,
	ActiveCustomerOrdersDocument,
	type ActiveCustomerOrdersQuery,
	UpdateCustomerAddressMutationDocument,
	type UpdateCustomerAddressMutationMutation,
	type UpdateCustomerAddressMutationMutationVariables,
	CreateCustomerAddressMutationDocument,
	type CreateCustomerAddressMutationMutation,
	type CreateCustomerAddressMutationMutationVariables,
	LogoutDocument,
	type LogoutMutation,
	type LogoutMutationVariables,
} from '~/generated/graphql-shop-typed';
import { requester } from '~/utils/api';

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

export const getActiveCustomerQuery = async () => {
	const res = await requester<ActiveCustomerQuery, ActiveCustomerQueryVariables>(
		ActiveCustomerDocument,
		undefined
	);
	return res.activeCustomer as Customer;
};

export const getActiveCustomerAddressesQuery = async () => {
	const res = await requester<ActiveCustomerAddressesQuery, ActiveCustomerAddressesQueryVariables>(
		ActiveCustomerAddressesDocument,
		undefined
	);
	return res.activeCustomer as Customer;
};

export const updateCustomerPasswordMutation = async (
	currentPassword: string,
	newPassword: string
) => {
	const res = await requester<
		UpdateCustomerPasswordMutationMutation,
		UpdateCustomerPasswordMutationMutationVariables
	>(UpdateCustomerPasswordMutationDocument, { currentPassword, newPassword });
	return res.updateCustomerPassword;
};

export const deleteCustomerAddressMutation = async (id: string) => {
	const result = await requester<
		DeleteCustomerAddressMutation,
		DeleteCustomerAddressMutationVariables
	>(DeleteCustomerAddressDocument, { id });
	clearCustomerCacheAfterMutation();
	return result;
};

export const getActiveCustomerOrdersQuery = async () => {
	const variables: ActiveCustomerOrdersQueryVariables = {
		options: {
			filter: {
				active: {
					eq: false,
				},
			},
			sort: {
				createdAt: 'DESC',
			},
		},
	};
	const res = await requester<ActiveCustomerOrdersQuery, ActiveCustomerOrdersQueryVariables>(
		ActiveCustomerOrdersDocument,
		variables
	);
	return res.activeCustomer as Customer;
};

export const updateCustomerAddressMutation = async (
	input: UpdateAddressInput,
	token: string | undefined
) => {
	const result = await requester<
		UpdateCustomerAddressMutationMutation,
		UpdateCustomerAddressMutationMutationVariables
	>(UpdateCustomerAddressMutationDocument, { input }, { token });
	clearCustomerCacheAfterMutation();
	return result;
};

export const createCustomerAddressMutation = async (
	input: CreateAddressInput,
	token: string | undefined
) => {
	const result = await requester<
		CreateCustomerAddressMutationMutation,
		CreateCustomerAddressMutationMutationVariables
	>(CreateCustomerAddressMutationDocument, { input }, { token });
	clearCustomerCacheAfterMutation();
	return result;
};

export const logoutMutation = async () => {
	const result = await requester<LogoutMutation, LogoutMutationVariables>(
		LogoutDocument,
		undefined
	);
	clearCustomerCache();
	return result;
};

// 🚀 CACHED CUSTOMER QUERIES - Better performance for account pages

export const getActiveCustomerCached = async () => {
	const cacheKey = 'active-customer';
	const cached = getCachedCustomerQuery(cacheKey);
	if (cached) return cached;

	try {
		const result = await getActiveCustomerQuery();
		setCachedCustomerQuery(cacheKey, result);
		return result;
	} catch (error) {
		console.warn('Customer cache failed, using fallback:', error);
		const result = await getActiveCustomerQuery();
		setCachedCustomerQuery(cacheKey, result);
		return result;
	}
};

export const getActiveCustomerAddressesCached = async () => {
	const cacheKey = 'customer-addresses';
	const cached = getCachedCustomerQuery(cacheKey);
	if (cached) return cached;

	try {
		const result = await getActiveCustomerAddressesQuery();
		setCachedCustomerQuery(cacheKey, result);
		return result;
	} catch (error) {
		console.warn('Customer addresses cache failed, using fallback:', error);
		const result = await getActiveCustomerAddressesQuery();
		setCachedCustomerQuery(cacheKey, result);
		return result;
	}
};

export const getActiveCustomerOrdersCached = async () => {
	const cacheKey = 'customer-orders';
	const cached = getCachedCustomerQuery(cacheKey);
	if (cached) return cached;

	try {
		const result = await getActiveCustomerOrdersQuery();
		setCachedCustomerQuery(cacheKey, result);
		return result;
	} catch (error) {
		console.warn('Customer orders cache failed, using fallback:', error);
		const result = await getActiveCustomerOrdersQuery();
		setCachedCustomerQuery(cacheKey, result);
		return result;
	}
};

// Clear cache after mutations that change customer data
export const clearCustomerCacheAfterMutation = () => {
	clearCustomerCache();
};
