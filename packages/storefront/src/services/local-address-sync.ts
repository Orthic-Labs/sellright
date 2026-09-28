import { createAddress, getAddressesCached, updateAddress } from '~/services/customer';
import type { Address, NewAddressInput, AddressPatch } from '~/sellright/types/account';
import type { AddressSyncResult, LocalAddress } from './local-address-types';

type LocalAddressOps = {
  getAddresses: () => LocalAddress[];
  saveAddresses: (addresses: LocalAddress[], customerId?: string) => void;
};

/** Prefix marking a `LocalAddress` as a mirror of a server-saved address (as
 *  opposed to one created locally this session) — `syncAddressToVendure`
 *  branches UPDATE vs CREATE on it below. */
const SERVER_ID_PREFIX = 'addr_';

export const transformServerAddress = (address: Address): LocalAddress => {
  const nameParts = address.fullName?.split(' ') || ['', ''];
  const firstName = nameParts[0] || '';
  const lastName = nameParts.slice(1).join(' ') || '';

  return {
    id: `${SERVER_ID_PREFIX}${address.id}`,
    firstName,
    lastName,
    fullName: address.fullName || '',
    streetLine1: address.line1 || '',
    streetLine2: address.line2 || undefined,
    city: address.city || '',
    province: address.province || '',
    postalCode: address.postalCode || '',
    countryCode: address.country || '',
    phoneNumber: address.phone || undefined,
    defaultShippingAddress: address.isDefaultShipping || false,
    defaultBillingAddress: address.isDefaultBilling || false,
    source: 'customer',
    lastUpdated: Date.now(),
  };
};

export async function syncAddressesFromVendure(customerId: string | undefined, ops: LocalAddressOps): Promise<void> {
  try {
    const addresses = await getAddressesCached();
    const synced = addresses.map(transformServerAddress);
    const existingAddresses = ops.getAddresses();
    const sessionAddresses = existingAddresses.filter(addr => addr.source !== 'customer');
    ops.saveAddresses([...synced, ...sessionAddresses], customerId);
  } catch (error) {
    console.error('Error syncing addresses from the server:', error);
  }
}

export async function syncAddressToVendure(address: LocalAddress, ops: LocalAddressOps): Promise<AddressSyncResult> {
  try {
    if (address.source === 'customer' && address.id.startsWith(SERVER_ID_PREFIX)) {
      const serverId = address.id.slice(SERVER_ID_PREFIX.length);
      const patch: AddressPatch = {
        fullName: address.fullName,
        line1: address.streetLine1,
        line2: address.streetLine2,
        city: address.city,
        province: address.province,
        postalCode: address.postalCode,
        country: address.countryCode,
        phone: address.phoneNumber,
        isDefaultShipping: address.defaultShippingAddress,
        isDefaultBilling: address.defaultBillingAddress,
      };

      const result = await updateAddress(serverId, patch);
      if (result?.ok) {
        const syncedAddress: LocalAddress = { ...address, lastUpdated: Date.now() };
        const updatedAddresses = ops.getAddresses().map(addr =>
          addr.id === address.id ? syncedAddress : addr
        );
        ops.saveAddresses(updatedAddresses);
        return { success: true, address: syncedAddress };
      }

      return { success: false, error: 'Failed to update the saved address' };
    }

    const input: NewAddressInput = {
      fullName: address.fullName,
      line1: address.streetLine1,
      line2: address.streetLine2,
      city: address.city,
      province: address.province,
      postalCode: address.postalCode,
      country: address.countryCode,
      phone: address.phoneNumber,
      isDefaultShipping: address.defaultShippingAddress,
      isDefaultBilling: address.defaultBillingAddress,
    };

    const { id } = await createAddress(input);
    const syncedAddress: LocalAddress = { ...address, id: `${SERVER_ID_PREFIX}${id}`, lastUpdated: Date.now() };
    const updatedAddresses = ops.getAddresses().map(addr =>
      addr.id === address.id ? syncedAddress : addr
    );
    ops.saveAddresses(updatedAddresses);
    return { success: true, address: syncedAddress };
  } catch (error) {
    console.error('Error syncing address to the server:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}
