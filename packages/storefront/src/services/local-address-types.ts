export interface LocalAddress {
  id: string;
  firstName: string;
  lastName: string;
  fullName: string;
  company?: string;
  streetLine1: string;
  streetLine2?: string;
  city: string;
  province: string;
  postalCode: string;
  countryCode: string;
  phoneNumber?: string;
  defaultShippingAddress: boolean;
  defaultBillingAddress: boolean;
  source: 'customer' | 'session' | 'checkout';
  lastUpdated: number;
}

export interface LocalAddressCache {
  addresses: LocalAddress[];
  customerId?: string;
  lastSync: number;
  version: number;
}

export interface AddressSyncResult {
  success: boolean;
  address?: LocalAddress;
  error?: string;
}
