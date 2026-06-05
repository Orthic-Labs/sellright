/**
 * Unified Customer Cache Service
 *
 * Replaces multiple cached GraphQL queries with a single, efficient cache-until-invalidated system.
 * Customer data rarely changes, so we cache indefinitely until explicit invalidation.
 */

import { Customer } from '~/generated/graphql-shop';
import {
	ActiveCustomerDocument,
	type ActiveCustomerQuery,
	type ActiveCustomerQueryVariables,
	ActiveCustomerAddressesDocument,
	type ActiveCustomerAddressesQuery,
	type ActiveCustomerAddressesQueryVariables,
	ActiveCustomerOrdersDocument,
	type ActiveCustomerOrdersQuery,
	type ActiveCustomerOrdersQueryVariables,
} from '~/generated/graphql-shop-typed';
import { requester } from '~/utils/api';

interface CustomerData {
	profile: Customer | null;
	addresses: Customer | null;
	orders: Customer | null;
}

interface CacheEntry<T> {
	data: T;
	timestamp: number;
	valid: boolean;
}

class CustomerCacheService {
	private static instance: CustomerCacheService;
	private cache = new Map<keyof CustomerData, CacheEntry<any>>();
	private subscribers = new Set<() => void>();

	private constructor() {
		// Setup cross-tab invalidation
		if (typeof window !== 'undefined') {
			window.addEventListener('storage', (e) => {
				if (e.key === 'customer-cache-invalidate') {
					this.invalidateAll();
				}
			});
		}
	}

	static getInstance(): CustomerCacheService {
		if (!CustomerCacheService.instance) {
			CustomerCacheService.instance = new CustomerCacheService();
		}
		return CustomerCacheService.instance;
	}

	/**
	 * Get customer profile data
	 */
	async getProfile(): Promise<Customer | null> {
		return this.getCachedOrFetch('profile', async () => {
			const res = await requester<ActiveCustomerQuery, ActiveCustomerQueryVariables>(
				ActiveCustomerDocument,
				undefined
			);
			return res.activeCustomer as Customer;
		});
	}

	/**
	 * Get customer addresses
	 */
	async getAddresses(): Promise<Customer | null> {
		return this.getCachedOrFetch('addresses', async () => {
			const res = await requester<ActiveCustomerAddressesQuery, ActiveCustomerAddressesQueryVariables>(
				ActiveCustomerAddressesDocument,
				undefined
			);
			return res.activeCustomer as Customer;
		});
	}

	/**
	 * Get customer orders
	 */
	async getOrders(): Promise<Customer | null> {
		return this.getCachedOrFetch('orders', async () => {
			const res = await requester<ActiveCustomerOrdersQuery, ActiveCustomerOrdersQueryVariables>(
				ActiveCustomerOrdersDocument,
				undefined
			);
			return res.activeCustomer as Customer;
		});
	}

	/**
	 * Generic cache-or-fetch method
	 */
	private async getCachedOrFetch<T>(
		key: keyof CustomerData,
		fetcher: () => Promise<T>
	): Promise<T> {
		const cached = this.cache.get(key);

		// Return cached data if valid
		if (cached && cached.valid) {
			return cached.data;
		}

		try {
			const data = await fetcher();
			this.cache.set(key, {
				data,
				timestamp: Date.now(),
				valid: true
			});
			return data;
		} catch (error) {
			console.warn(`Customer cache fetch failed for ${key}:`, error);
			// Return stale data if available, otherwise rethrow
			if (cached) {
				return cached.data;
			}
			throw error;
		}
	}

	/**
	 * Invalidate specific cache entry
	 */
	invalidate(key: keyof CustomerData): void {
		const cached = this.cache.get(key);
		if (cached) {
			cached.valid = false;
		}
		this.notifySubscribers();
	}

	/**
	 * Invalidate all cache entries (after mutations)
	 */
	invalidateAll(): void {
		for (const [, entry] of this.cache) {
			entry.valid = false;
		}

		// Notify other tabs
		if (typeof window !== 'undefined') {
			try {
				localStorage.setItem('customer-cache-invalidate', Date.now().toString());
				localStorage.removeItem('customer-cache-invalidate');
			} catch (_e) {
				// Ignore localStorage errors
			}
		}

		this.notifySubscribers();
	}

	/**
	 * Subscribe to cache changes
	 */
	subscribe(callback: () => void): () => void {
		this.subscribers.add(callback);
		return () => this.subscribers.delete(callback);
	}

	/**
	 * Notify all subscribers of cache changes
	 */
	private notifySubscribers(): void {
		for (const callback of this.subscribers) {
			try {
				callback();
			} catch (error) {
				console.warn('Customer cache subscriber error:', error);
			}
		}
	}

	/**
	 * Clear all cache data (on logout)
	 */
	clear(): void {
		this.cache.clear();
		this.notifySubscribers();
	}

	/**
	 * Get cache statistics for debugging
	 */
	getStats() {
		const stats = {
			size: this.cache.size,
			entries: {} as Record<string, { valid: boolean; age: number }>
		};

		for (const [key, entry] of this.cache) {
			stats.entries[key] = {
				valid: entry.valid,
				age: Date.now() - entry.timestamp
			};
		}

		return stats;
	}
}

// Export singleton instance
export const customerCache = CustomerCacheService.getInstance();

// Convenience functions that replace the old cached queries
export const getActiveCustomerCached = () => customerCache.getProfile();
export const getActiveCustomerAddressesCached = () => customerCache.getAddresses();
export const getActiveCustomerOrdersCached = () => customerCache.getOrders();

// Invalidation function for mutations
export const clearCustomerCacheAfterMutation = () => customerCache.invalidateAll();

// Clear cache on logout
export const clearCustomerCacheOnLogout = () => customerCache.clear();

export default CustomerCacheService;
