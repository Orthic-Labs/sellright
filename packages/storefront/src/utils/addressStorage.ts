/**
 * Centralized address storage management that respects authentication state.
 * Priority: Customer saved address → CountryPreferenceService storage.
 *
 * Native SellRight client only — `getMe`/`getAddresses` (services/customer.ts)
 * and the native `Address` type (sellright/types/account.ts), zero legacy
 * shapes. Country persistence is CountryPreferenceService (localStorage),
 * carried over from the retired LocalCartService with identical semantics.
 */

import { getMe, getAddresses } from '~/services/customer';
import type { Address } from '~/sellright/types/account';
import { $ } from '@qwik.dev/core';
import { CountryPreferenceService } from '~/services/CountryPreferenceService';
import { lookupCountryCode } from '~/utils/visitor-country';

export interface StoredAddressInfo {
  countryCode: string;
  source: 'customer' | 'session' | 'geolocation';
  isAuthenticated: boolean;
}

export interface CustomerAddress {
  countryCode: string;
  fullName: string;
  streetLine1: string;
  streetLine2?: string;
  city: string;
  province: string;
  postalCode: string;
  phoneNumber?: string;
}

const toCustomerAddress = (a: Address): CustomerAddress => ({
  countryCode: a.country,
  fullName: a.fullName || '',
  streetLine1: a.line1 || '',
  streetLine2: a.line2 || '',
  city: a.city || '',
  province: a.province || '',
  postalCode: a.postalCode || '',
  phoneNumber: a.phone || '',
});

/**
 * Load address information from customer data or CountryPreferenceService.
 * 1. If customer is authenticated, load their default shipping address.
 * 2. If not authenticated or no customer address, use the stored preference.
 * 3. Return null if no data available - no automatic fallbacks.
 */
export async function loadPriorityAddress(): Promise<StoredAddressInfo | null> {
	try {
		const me = await getMe();
		if (me) {
			const addresses = await getAddresses();
			const defaultShipping = addresses.find((a) => a.isDefaultShipping);
			if (defaultShipping) {
				CountryPreferenceService.setCountry(defaultShipping.country);
				return { countryCode: defaultShipping.country, source: 'customer', isAuthenticated: true };
			}
		}
	} catch (e) { void e; }
	const storedCountry = CountryPreferenceService.getCountry();
	const isExplicit = CountryPreferenceService.hasExplicitCountrySelection();
	if (storedCountry) {
		return { countryCode: storedCountry, source: 'session', isAuthenticated: isExplicit };
	}
	return null;
}

/** Get full customer address details for forms. */
export async function loadCustomerAddress(): Promise<CustomerAddress | null> {
	try {
		const me = await getMe();
		if (!me) return null;
		const addresses = await getAddresses();
		const defaultShipping = addresses.find((a) => a.isDefaultShipping);
		return defaultShipping ? toCustomerAddress(defaultShipping) : null;
	} catch (_error) {
		return null;
	}
}

/** Save user-selected country. This ensures user preferences override geolocation. */
export function saveUserSelectedCountry(countryCode: string): void {
	CountryPreferenceService.setCountry(countryCode);
}

/** Check if current stored country came from an explicit user choice (vs a geolocation guess). */
export function isStoredCountryFromCustomer(): boolean {
  return CountryPreferenceService.hasExplicitCountrySelection();
}

/** Clear stored address data (useful for logout). */
export function clearStoredAddress(): void {
  CountryPreferenceService.setCountryFromGeolocation('US');
}

/**
 * Load country from storage only - no automatic detection.
 * Only restores previously saved user selections or customer data.
 */
export const loadCountryFromStorage = $(async (appState: any) => {
  if (appState.shippingAddress.countryCode) {
    return; // Country already set
  }
  const storedCountry = CountryPreferenceService.getCountry();
  if (storedCountry) {
    appState.shippingAddress.countryCode = storedCountry;
    return;
  }
  // No automatic fallbacks - country will be set when user reaches checkout
});

/**
 * Load country on demand when user shows purchase intent (add to cart).
 * This handles geolocation and saves the preference for future use.
 */
export const loadCountryOnDemand = $(async (appState: any) => {
	// Write the country only when it actually changes. The lookup can answer while the shopper is typing in an address
	// form that tracks this value; re-assigning the same country re-ran the form's tasks mid-edit and corrupted the
	// field being typed (seen as a doubled state value).
	const setCountry = (code: string) => {
		if (appState.shippingAddress.countryCode !== code) appState.shippingAddress.countryCode = code;
	};
	const persistedCountry = CountryPreferenceService.getCountry();
	const hasExplicitCountry = CountryPreferenceService.hasExplicitCountrySelection();

	// Only run geolocation if country is default US and user never explicitly set
	if ((persistedCountry && persistedCountry !== 'US') || hasExplicitCountry) {
		setCountry(persistedCountry);
		return;
	}

	setCountry(persistedCountry || 'US');

	// Attempt geolocation only when still in default mode
	const countryCode = await lookupCountryCode();
	if (countryCode) {
		CountryPreferenceService.setCountryFromGeolocation(countryCode);
		setCountry(countryCode);
		return;
	}

	// Fallback to US if geolocation fails
	setCountry('US');
	CountryPreferenceService.setCountryFromGeolocation('US');
});

export const getOrResolveCountryCode = $(async (appState: any, countryOverride?: string) => {
	const override = countryOverride?.toUpperCase();
	if (override) {
		CountryPreferenceService.setCountry(override);
		appState.shippingAddress.countryCode = override;
		return override;
	}
	const stored = CountryPreferenceService.getCountry();
	if (stored) {
		appState.shippingAddress.countryCode = stored;
		return stored;
	}
	const geolocated = await lookupCountryCode();
	if (geolocated) {
		CountryPreferenceService.setCountryFromGeolocation(geolocated);
		appState.shippingAddress.countryCode = geolocated;
		return geolocated;
	}
	const cc = 'US';
	CountryPreferenceService.setCountryFromGeolocation(cc);
	appState.shippingAddress.countryCode = cc;
	return cc;
});
