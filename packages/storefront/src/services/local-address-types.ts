export interface LocalAddress {
  id: string;
  firstName: string;
  lastName: string;
  fullName: string;
  company?: string;
  line1: string;
  line2?: string;
  city: string;
  province: string;
  postalCode: string;
  country: string;
  phone?: string;
  isDefaultShipping: boolean;
  isDefaultBilling: boolean;
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
