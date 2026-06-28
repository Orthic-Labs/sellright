import {
  createCustomerAddressMutation,
  getActiveCustomerAddressesCached,
  updateCustomerAddressMutation,
} from '~/providers/shop/customer/customer';
import type { Address, CreateAddressInput, UpdateAddressInput } from '~/generated/graphql-shop';
import type { AddressSyncResult, LocalAddress } from './local-address-types';

type LocalAddressOps = {
  getAddresses: () => LocalAddress[];
  saveAddresses: (addresses: LocalAddress[], customerId?: string) => void;
};

export const transformVendureAddress = (vendureAddress: Address): LocalAddress => {
  const nameParts = vendureAddress.fullName?.split(' ') || ['', ''];
  const firstName = nameParts[0] || '';
  const lastName = nameParts.slice(1).join(' ') || '';

  return {
    id: `vendure_${vendureAddress.id}`,
    firstName,
    lastName,
    fullName: vendureAddress.fullName || '',
    company: vendureAddress.company || undefined,
    streetLine1: vendureAddress.streetLine1 || '',
    streetLine2: vendureAddress.streetLine2 || undefined,
    city: vendureAddress.city || '',
    province: vendureAddress.province || '',
    postalCode: vendureAddress.postalCode || '',
    countryCode: vendureAddress.country?.code || '',
    phoneNumber: vendureAddress.phoneNumber || undefined,
    defaultShippingAddress: vendureAddress.defaultShippingAddress || false,
    defaultBillingAddress: vendureAddress.defaultBillingAddress || false,
    source: 'customer',
    lastUpdated: Date.now(),
  };
};

export async function syncAddressesFromVendure(customerId: string | undefined, ops: LocalAddressOps): Promise<void> {
  try {
    const customerData = await getActiveCustomerAddressesCached();

    if (customerData?.addresses) {
      const vendureAddresses = customerData.addresses.map((addr: any) =>
        transformVendureAddress(addr as Address)
      );
      const existingAddresses = ops.getAddresses();
      const sessionAddresses = existingAddresses.filter(addr => addr.source !== 'customer');
      ops.saveAddresses([...vendureAddresses, ...sessionAddresses], customerId);
    }
  } catch (error) {
    console.error('Error syncing addresses from Vendure:', error);
  }
}

export async function syncAddressToVendure(address: LocalAddress, ops: LocalAddressOps): Promise<AddressSyncResult> {
  try {
    if (address.source === 'customer' && address.id.startsWith('vendure_')) {
      const vendureId = address.id.replace('vendure_', '');
      const updateInput: UpdateAddressInput = {
        id: vendureId,
        fullName: address.fullName,
        company: address.company,
        streetLine1: address.streetLine1,
        streetLine2: address.streetLine2,
        city: address.city,
        province: address.province,
        postalCode: address.postalCode,
        countryCode: address.countryCode,
        phoneNumber: address.phoneNumber,
        defaultShippingAddress: address.defaultShippingAddress,
        defaultBillingAddress: address.defaultBillingAddress,
      };

      const result = await updateCustomerAddressMutation(updateInput, undefined);
      if (result?.updateCustomerAddress) {
        const syncedAddress = transformVendureAddress(result.updateCustomerAddress as Address);
        const updatedAddresses = ops.getAddresses().map(addr =>
          addr.id === address.id ? syncedAddress : addr
        );
        ops.saveAddresses(updatedAddresses);
        return { success: true, address: syncedAddress };
      }

      return { success: false, error: 'Failed to update address in Vendure' };
    }

    const createInput: CreateAddressInput = {
      fullName: address.fullName,
      company: address.company,
      streetLine1: address.streetLine1,
      streetLine2: address.streetLine2,
      city: address.city,
      province: address.province,
      postalCode: address.postalCode,
      countryCode: address.countryCode,
      phoneNumber: address.phoneNumber,
      defaultShippingAddress: address.defaultShippingAddress,
      defaultBillingAddress: address.defaultBillingAddress,
    };

    const result = await createCustomerAddressMutation(createInput, undefined);
    if (result?.createCustomerAddress) {
      const syncedAddress = transformVendureAddress(result.createCustomerAddress as Address);
      const updatedAddresses = ops.getAddresses().map(addr =>
        addr.id === address.id ? syncedAddress : addr
      );
      ops.saveAddresses(updatedAddresses);
      return { success: true, address: syncedAddress };
    }

    return { success: false, error: 'Failed to create address in Vendure' };
  } catch (error) {
    console.error('Error syncing address to Vendure:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}
