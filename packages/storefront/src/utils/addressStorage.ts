/**
 * Centralized address storage management that respects authentication state
 * Priority: Customer saved address → LocalCartService storage
 */

import { getActiveCustomerQuery, getActiveCustomerAddressesQuery } from '~/providers/shop/customer/customer';
import { Address } from '~/generated/graphql-shop';
import { $ } from '@qwik.dev/core';
import { LocalCartService } from '~/services/LocalCartService';

export interface StoredAddressInfo {
  countryCode: string;
  countryName?: string;
  source: 'customer' | 'session' | 'geolocation';
  isAuthenticated: boolean;
}

export interface CustomerAddress {
  countryCode: string;
  countryName: string;
  fullName: string;
  streetLine1: string;
  streetLine2?: string;
  city: string;
  province: string;
  postalCode: string;
  phoneNumber?: string;
}

/**
 * Load address information from customer data or LocalCartService
 * 1. If customer is authenticated, load their default shipping address
 * 2. If not authenticated or no customer address, use LocalCartService
 * 3. Return null if no data available - no automatic fallbacks
 */
export async function loadPriorityAddress(): Promise<StoredAddressInfo | null> {
	try {
		const activeCustomer = await getActiveCustomerQuery();
		if (activeCustomer) {
			const customerAddresses = await getActiveCustomerAddressesQuery();
			if (customerAddresses?.addresses) {
				const defaultShippingAddress = customerAddresses.addresses.find(
					(address: Address) => !!address.defaultShippingAddress,
				);
				if (defaultShippingAddress) {
					const customerInfo: StoredAddressInfo = {
						countryCode: defaultShippingAddress.country.code,
						countryName: defaultShippingAddress.country.name,
						source: 'customer',
						isAuthenticated: true,
					};
					LocalCartService.setCountry(defaultShippingAddress.country.code);
					return customerInfo;
				}
			}
		}
	} catch (e) { void e; }
	const storedCountry = LocalCartService.getCountry();
	const isExplicit = LocalCartService.hasExplicitCountrySelection();
	if (storedCountry) {
		return {
			countryCode: storedCountry,
			source: 'session',
			isAuthenticated: isExplicit,
		};
	}
	return null;
}

/**
 * Get full customer address details for forms
 */
export async function loadCustomerAddress(): Promise<CustomerAddress | null> {
	try {
		const activeCustomer = await getActiveCustomerQuery();
		if (!activeCustomer) {
			return null;
		}

		const customerAddresses = await getActiveCustomerAddressesQuery();

		if (customerAddresses?.addresses) {
			const defaultShippingAddress = customerAddresses.addresses.find(
				(address: Address) => !!address.defaultShippingAddress,
			);

			if (defaultShippingAddress) {
				return {
					countryCode: defaultShippingAddress.country.code,
					countryName: defaultShippingAddress.country.name,
					fullName: defaultShippingAddress.fullName || '',
					streetLine1: defaultShippingAddress.streetLine1 || '',
					streetLine2: defaultShippingAddress.streetLine2 || '',
					city: defaultShippingAddress.city || '',
					province: defaultShippingAddress.province || '',
					postalCode: defaultShippingAddress.postalCode || '',
					phoneNumber: defaultShippingAddress.phoneNumber || '',
				};
			}
		}

		return null;
	} catch (_error) {
		return null;
	}
}

/**
 * Save user-selected country to LocalCartService
 * This ensures user preferences override geolocation
 */
export function saveUserSelectedCountry(countryCode: string): void {
	LocalCartService.setCountry(countryCode);
}

/**
 * Check if current stored country came from customer data
 */
export function isStoredCountryFromCustomer(): boolean {
  return LocalCartService.hasExplicitCountrySelection();
}

/**
 * Clear stored address data (useful for logout)
 */
export function clearStoredAddress(): void {
  LocalCartService.setCountryFromGeolocation('US');
}

/**
 * Load country from LocalCartService only - no automatic detection
 * Only restores previously saved user selections or customer data
 */
export const loadCountryFromStorage = $(async (appState: any) => {
  // Only run if country is not already set
  if (appState.shippingAddress.countryCode) {
    return; // Country already set
  }

  // Check local cart storage for cached country
  const storedCountry = LocalCartService.getCountry();
  if (storedCountry) {
    appState.shippingAddress.countryCode = storedCountry;
    return;
  }

  // No automatic fallbacks - country will be set when user reaches checkout
});

/**
 * Load country on demand when user shows purchase intent (add to cart)
 * This handles geolocation and saves to LocalCartService for future use
 */
export const loadCountryOnDemand = $(async (appState: any) => {
	const persistedCountry = LocalCartService.getCountry();
	const hasExplicitCountry = LocalCartService.hasExplicitCountrySelection();

	// Only run geolocation if country is default US and user never explicitly set
	if ((persistedCountry && persistedCountry !== 'US') || hasExplicitCountry) {
		appState.shippingAddress.countryCode = persistedCountry;
		return;
	}

	appState.shippingAddress.countryCode = persistedCountry || 'US';

	// Attempt geolocation only when still in default mode
	try {
		const response = await fetch('https://ipapi.co/json/');
		const data = await response.json();

		if (data.country_code) {
			const countryCode = data.country_code.toUpperCase();

			// Save geolocated country to local cart storage and app state
			LocalCartService.setCountryFromGeolocation(countryCode);
			appState.shippingAddress.countryCode = countryCode;
			return;
		}
	} catch (_error) {
		// Geolocation failed
	}

	// Fallback to US if geolocation fails
	appState.shippingAddress.countryCode = 'US';
	LocalCartService.setCountryFromGeolocation('US');
});

export const getOrResolveCountryCode = $(async (appState: any, countryOverride?: string) => {
	const override = countryOverride?.toUpperCase();
	if (override) {
		LocalCartService.setCountry(override);
		appState.shippingAddress.countryCode = override;
		return override;
	}
	const stored = LocalCartService.getCountry();
	if (stored) {
		appState.shippingAddress.countryCode = stored;
		return stored;
	}
	try {
		const timeoutPromise = new Promise((_, reject) =>
			setTimeout(() => reject(new Error('timeout')), 3000)
		);
		const geoPromise = fetch('https://ipapi.co/json/', {
			signal: AbortSignal.timeout(5000),
		}).then((r) => r.json());
		const data: any = await Promise.race([geoPromise, timeoutPromise]);
		if (data && data.country_code) {
			const cc = String(data.country_code).toUpperCase();
			LocalCartService.setCountryFromGeolocation(cc);
			appState.shippingAddress.countryCode = cc;
			return cc;
		}
	} catch (e) { void e; }
	const cc = 'US';
	LocalCartService.setCountryFromGeolocation(cc);
	appState.shippingAddress.countryCode = cc;
	return cc;
});
