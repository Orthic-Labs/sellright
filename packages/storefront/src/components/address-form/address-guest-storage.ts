import type { ShippingAddress, ActiveCustomer } from '~/types';

export type GuestShippingAddress = Partial<ShippingAddress> & {
 firstName?: string;
 lastName?: string;
 emailAddress?: string;
 phoneNumber?: string;
 lastUpdated?: number;
};

const COUNTRY_KEY = 'guestCountryCode';
// Earlier versions cached the full guest address (name, phone, street) in
// browser storage. Nothing personal is persisted any more; purge leftovers.
const LEGACY_KEYS = ['guestShippingAddress'];

const purgeLegacy = () => {
 for (const k of LEGACY_KEYS) {
  try { localStorage.removeItem(k); } catch { /* storage unavailable */ }
  try { sessionStorage.removeItem(k); } catch { /* storage unavailable */ }
 }
};

/**
 * Guest address details stay in memory for the checkout session only. The
 * browser remembers just the country code so the next visit preselects it.
 */
export const loadGuestShippingAddress = async (): Promise<GuestShippingAddress | null> => {
 if (typeof localStorage === 'undefined') return null;
 purgeLegacy();
 const countryCode = localStorage.getItem(COUNTRY_KEY);
 return countryCode ? { countryCode } : null;
};

export const saveGuestShippingAddress = async (_customer: ActiveCustomer, address: ShippingAddress): Promise<void> => {
 if (typeof localStorage === 'undefined' || !address.countryCode) return;
 try {
  localStorage.setItem(COUNTRY_KEY, address.countryCode);
 } catch (error) {
  console.warn('[AddressForm] Failed to save guest country:', error);
 }
};
