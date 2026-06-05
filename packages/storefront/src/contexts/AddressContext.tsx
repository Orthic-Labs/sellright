import { createContextId, useContext, useContextProvider, component$, Slot, useStore, useTask$, $ } from '@qwik.dev/core';
import { LocalAddressService, LocalAddress } from '~/services/LocalAddressService';
import { CUSTOMER_NOT_DEFINED_ID } from '~/constants';
// import { APP_STATE } from '~/constants'; // Not used in current implementation

// Address Context State Interface - Only store data, not functions
export interface AddressContextState {
  addresses: LocalAddress[];
  isLoading: boolean;
  lastError: string | null;
  hasLoadedOnce: boolean;
  defaultShippingAddress: LocalAddress | null;
  defaultBillingAddress: LocalAddress | null;
}

// Create context for state only
export const AddressContextId = createContextId<AddressContextState>('address-context');

// Address Provider Component
export const AddressProvider = component$(() => {
  // const appState = useContext(APP_STATE); // Not used in current implementation
  
  // Initialize address state
  const addressState = useStore<AddressContextState>({
    addresses: [],
    isLoading: false,
    lastError: null,
    hasLoadedOnce: false,
    defaultShippingAddress: null,
    defaultBillingAddress: null,
  });
  
  // Provide the context
  useContextProvider(AddressContextId, addressState);

  // Update default addresses when addresses change
  useTask$(({ track }) => {
    track(() => addressState.addresses);
    
    addressState.defaultShippingAddress = LocalAddressService.getDefaultShippingAddress();
    addressState.defaultBillingAddress = LocalAddressService.getDefaultBillingAddress();
  });

  // Set up cross-tab synchronization
  useTask$(() => {
    if (typeof window === 'undefined') return;
    
    LocalAddressService.setupCrossTabSync();
    
    // Register callback for address updates from other tabs
    LocalAddressService.onAddressUpdate($(() => {
      addressState.addresses = LocalAddressService.getAddresses();
    }));
  });

  return <Slot />;
});

// Hook to use the address context
export const useAddressContext = () => {
  return useContext(AddressContextId);
};

// Action functions - exported as standalone functions
export const loadAddresses = $((addressState: AddressContextState, appState: any) => {
  if (addressState.isLoading) return;
  
  try {
    addressState.isLoading = true;
    addressState.lastError = null;
    
    // Load from cache/storage first
    const cachedAddresses = LocalAddressService.getAddresses();
    addressState.addresses = cachedAddresses;
    
    // If user is authenticated and we haven't loaded from Vendure yet, sync
    if (appState.customer?.id && appState.customer.id !== CUSTOMER_NOT_DEFINED_ID && !addressState.hasLoadedOnce) {
      // Note: syncFromVendure would need to be called separately as it's async
    }
    
    addressState.hasLoadedOnce = true;
  } catch (error) {
    addressState.lastError = error instanceof Error ? error.message : 'Failed to load addresses';
    console.error('Error loading addresses:', error);
  } finally {
    addressState.isLoading = false;
  }
});

export const saveAddress = $(async (addressState: AddressContextState, addressData: Omit<LocalAddress, 'id' | 'lastUpdated'>, appState: any): Promise<LocalAddress> => {
  try {
    addressState.lastError = null;
    
    const savedAddress = LocalAddressService.saveAddress(addressData);
    addressState.addresses = LocalAddressService.getAddresses();
    
    // Sync to Vendure if user is authenticated
    if (appState.customer?.id && appState.customer.id !== CUSTOMER_NOT_DEFINED_ID) {
      await LocalAddressService.syncToVendure(savedAddress);
    }
    
    return savedAddress;
  } catch (error) {
    addressState.lastError = error instanceof Error ? error.message : 'Failed to save address';
    console.error('Error saving address:', error);
    throw error;
  }
});

export const removeAddress = $(async (addressState: AddressContextState, addressId: string): Promise<boolean> => {
  try {
    addressState.lastError = null;
    
    const success = LocalAddressService.removeAddress(addressId);
    if (success) {
      addressState.addresses = LocalAddressService.getAddresses();
    }
    
    return success;
  } catch (error) {
    addressState.lastError = error instanceof Error ? error.message : 'Failed to remove address';
    console.error('Error removing address:', error);
    return false;
  }
});

export const syncFromVendure = $(async (addressState: AddressContextState, customerId: string) => {
  try {
    addressState.lastError = null;
    
    if (!customerId || customerId === CUSTOMER_NOT_DEFINED_ID) {
      return;
    }
    
    await LocalAddressService.syncFromVendure(customerId);
    addressState.addresses = LocalAddressService.getAddresses();
  } catch (error) {
    addressState.lastError = error instanceof Error ? error.message : 'Failed to sync addresses from server';
    console.error('Error syncing from Vendure:', error);
  }
});

export const clearAddresses = $((addressState: AddressContextState) => {
  LocalAddressService.clearAddresses();
  addressState.addresses = [];
  addressState.defaultShippingAddress = null;
  addressState.defaultBillingAddress = null;
  addressState.hasLoadedOnce = false;
});

// Convenience hooks for specific parts of the context
export const useAddresses = () => {
  const addressState = useAddressContext();
  return addressState.addresses;
};

export const useDefaultAddresses = () => {
  const addressState = useAddressContext();
  return {
    defaultShipping: addressState.defaultShippingAddress,
    defaultBilling: addressState.defaultBillingAddress,
  };
};

export const useAddressLoading = () => {
  const addressState = useAddressContext();
  return {
    isLoading: addressState.isLoading,
    lastError: addressState.lastError,
    hasLoadedOnce: addressState.hasLoadedOnce,
  };
};