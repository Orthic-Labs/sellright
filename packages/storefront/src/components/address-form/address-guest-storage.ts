import type { ShippingAddress, ActiveCustomer } from '~/types';

export type GuestShippingAddress = Partial<ShippingAddress> & {
 firstName?: string;
 lastName?: string;
 emailAddress?: string;
 phoneNumber?: string;
 lastUpdated?: number;
};

export const loadGuestShippingAddress = (): GuestShippingAddress | null => {
 if (typeof localStorage === 'undefined') return null;
 let storedGuestAddress = localStorage.getItem('guestShippingAddress');
 if (!storedGuestAddress && typeof sessionStorage !== 'undefined') {
  storedGuestAddress = sessionStorage.getItem('guestShippingAddress');
 }
 if (!storedGuestAddress) return null;
 try {
  return JSON.parse(storedGuestAddress);
 } catch (error) {
  console.warn('[AddressForm] Failed to parse guest address from storage:', error);
  return null;
 }
};

export const saveGuestShippingAddress = (customer: ActiveCustomer, address: ShippingAddress): void => {
 if (typeof localStorage === 'undefined') return;
 try {
  localStorage.setItem('guestShippingAddress', JSON.stringify({
   firstName: customer.firstName || '',
   lastName: customer.lastName || '',
   emailAddress: customer.emailAddress || '',
   streetLine1: address.streetLine1,
   streetLine2: address.streetLine2,
   city: address.city,
   province: address.province,
   postalCode: address.postalCode,
   countryCode: address.countryCode,
   phoneNumber: address.phoneNumber,
   lastUpdated: Date.now(),
  }));
 } catch (error) {
  console.warn('[AddressForm] Failed to save guest address to localStorage:', error);
 }
};
