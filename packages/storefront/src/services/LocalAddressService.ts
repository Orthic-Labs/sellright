import type { AddressSyncResult, LocalAddress, LocalAddressCache } from './local-address-types';
import { syncAddressToVendure, syncAddressesFromVendure } from './local-address-sync';
export type { AddressSyncResult, LocalAddress, LocalAddressCache } from './local-address-types';

// LocalAddress Service
export class LocalAddressService {
  private static readonly ADDRESS_KEY = 'vendure_local_addresses';
  private static readonly CACHE_DURATION = 5 * 60 * 1000; // 5 minutes
  
  // 🚀 OPTIMIZED: In-memory cache to reduce sessionStorage reads
  private static addressCache: LocalAddressCache | null = null;
  private static cacheTimestamp: number = 0;
  private static readonly MEMORY_CACHE_DURATION = 1000; // 1 second cache
  
  // 🔄 CROSS-TAB SYNC: Storage event listeners and address update callbacks
  private static addressUpdateCallbacks: Set<() => void> = new Set();
  private static isStorageListenerSetup = false;

  // Setup cross-tab synchronization
  static setupCrossTabSync(): void {
    if (typeof window === 'undefined' || this.isStorageListenerSetup) return;

    window.addEventListener('storage', (event) => {
      if (event.key === this.ADDRESS_KEY) {
        // Clear cache when addresses change in another tab
        this.clearCache();
        // Notify all registered callbacks
        this.addressUpdateCallbacks.forEach(callback => {
          try {
            callback();
          } catch (error) {
            console.error('Error in address update callback:', error);
          }
        });
      }
    });

    this.isStorageListenerSetup = true;
  }

  // Register callback for address updates (cross-tab sync)
  static onAddressUpdate(callback: () => void): () => void {
    this.addressUpdateCallbacks.add(callback);
    // Return unsubscribe function
    return () => {
      this.addressUpdateCallbacks.delete(callback);
    };
  }

  // Trigger address update callbacks (for same-tab updates)
  private static triggerAddressUpdate(): void {
    this.addressUpdateCallbacks.forEach(callback => {
      try {
        callback();
      } catch (error) {
        console.error('Error in address update callback:', error);
      }
    });
  }

  // Clear in-memory cache
  private static clearCache(): void {
    this.addressCache = null;
    this.cacheTimestamp = 0;
  }

  // Generate unique ID for new addresses
  private static generateAddressId(): string {
    return `local_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  // Get addresses from cache or storage
  static getAddresses(): LocalAddress[] {
    // Check in-memory cache first (1-second cache)
    const now = Date.now();
    if (this.addressCache && (now - this.cacheTimestamp) < this.MEMORY_CACHE_DURATION) {
      return this.addressCache.addresses;
    }

    // Fall back to sessionStorage
    if (typeof window === 'undefined') return [];
    
    try {
      const stored = sessionStorage.getItem(this.ADDRESS_KEY);
      if (stored) {
        const cache: LocalAddressCache = JSON.parse(stored);
        
        // Check if cache is still valid
        if ((now - cache.lastSync) < this.CACHE_DURATION) {
          // Update in-memory cache
          this.addressCache = cache;
          this.cacheTimestamp = now;
          return cache.addresses;
        }
      }
    } catch (error) {
      console.error('Error reading addresses from sessionStorage:', error);
    }

    // Return empty array if no valid data
    return [];
  }

  // Save addresses to storage and update cache
  static saveAddresses(addresses: LocalAddress[], customerId?: string): void {
    if (typeof window === 'undefined') return;

    const now = Date.now();
    const cache: LocalAddressCache = {
      addresses,
      customerId,
      lastSync: now,
      version: 1
    };

    try {
      // Update sessionStorage
      sessionStorage.setItem(this.ADDRESS_KEY, JSON.stringify(cache));
      
      // Update in-memory cache
      this.addressCache = cache;
      this.cacheTimestamp = now;
      
      // Trigger cross-tab sync callbacks
      this.triggerAddressUpdate();
    } catch (error) {
      console.error('Error saving addresses to sessionStorage:', error);
    }
  }

  // Clear all cached addresses
  static clearAddresses(): void {
    if (typeof window === 'undefined') return;

    try {
      // Clear sessionStorage
      sessionStorage.removeItem(this.ADDRESS_KEY);
      
      // Clear in-memory cache
      this.clearCache();
      
      // Trigger callbacks
      this.triggerAddressUpdate();
    } catch (error) {
      console.error('Error clearing addresses:', error);
    }
  }

  // Add or update address
  static saveAddress(address: Omit<LocalAddress, 'id' | 'lastUpdated'>): LocalAddress {
    const addresses = this.getAddresses();
    const now = Date.now();
    
    // Check if this is an update (find by matching address fields)
    const existingIndex = addresses.findIndex(addr => 
      addr.streetLine1 === address.streetLine1 &&
      addr.city === address.city &&
      addr.postalCode === address.postalCode &&
      addr.countryCode === address.countryCode
    );

    let savedAddress: LocalAddress;
    let isUpdate = false;
    
    if (existingIndex >= 0) {
      // Update existing address
      const existingAddress = addresses[existingIndex];
      savedAddress = {
        ...address,
        id: existingAddress.id,
        lastUpdated: now
      };
      addresses[existingIndex] = savedAddress;
      isUpdate = true;
    } else {
      // Create new address
      savedAddress = {
        ...address,
        id: this.generateAddressId(),
        lastUpdated: now
      };
      addresses.push(savedAddress);
    }

    // Save updated addresses
    this.saveAddresses(addresses);
    
    // If this was an update to a customer address, sync it back to Vendure
    if (isUpdate && savedAddress.source === 'customer') {
      // Async sync - don't block the UI
      this.syncToVendure(savedAddress).catch(error => {
        console.warn('Failed to sync address update to Vendure:', error);
      });
    }
    
    return savedAddress;
  }

  // Update existing address by ID
  static updateAddress(addressId: string, updates: Partial<Omit<LocalAddress, 'id' | 'lastUpdated'>>): LocalAddress | null {
    const addresses = this.getAddresses();
    const addressIndex = addresses.findIndex(addr => addr.id === addressId);
    
    if (addressIndex === -1) {
      return null;
    }
    
    const existingAddress = addresses[addressIndex];
    const updatedAddress: LocalAddress = {
      ...existingAddress,
      ...updates,
      id: addressId, // Ensure ID doesn't change
      lastUpdated: Date.now()
    };
    
    addresses[addressIndex] = updatedAddress;
    this.saveAddresses(addresses);
    
    // If this is a customer address, sync it back to Vendure
    if (updatedAddress.source === 'customer') {
      // Async sync - don't block the UI
      this.syncToVendure(updatedAddress).catch(error => {
        console.warn('Failed to sync address update to Vendure:', error);
      });
    }
    
    return updatedAddress;
  }

  // Remove address by ID
  static removeAddress(addressId: string): boolean {
    const addresses = this.getAddresses();
    const initialLength = addresses.length;
    
    const filteredAddresses = addresses.filter(addr => addr.id !== addressId);
    
    if (filteredAddresses.length < initialLength) {
      this.saveAddresses(filteredAddresses);
      return true;
    }
    
    return false;
  }

  // Get default shipping address
  static getDefaultShippingAddress(): LocalAddress | null {
    const addresses = this.getAddresses();
    
    // Find address with defaultShippingAddress: true
    const defaultShipping = addresses.find(addr => addr.defaultShippingAddress);
    if (defaultShipping) return defaultShipping;
    
    // Return first address if no default set
    return addresses.length > 0 ? addresses[0] : null;
  }

  // Get default billing address
  static getDefaultBillingAddress(): LocalAddress | null {
    const addresses = this.getAddresses();
    
    // Find address with defaultBillingAddress: true
    const defaultBilling = addresses.find(addr => addr.defaultBillingAddress);
    if (defaultBilling) return defaultBilling;
    
    // Fall back to default shipping if no billing default
    return this.getDefaultShippingAddress();
  }

  // Save or update default shipping address (updates existing if found, creates new if not)
  static saveOrUpdateDefaultShippingAddress(address: Omit<LocalAddress, 'id' | 'lastUpdated'>): LocalAddress {
    const existingDefault = this.getDefaultShippingAddress();
    
    if (existingDefault && existingDefault.source === 'customer') {
      // Update existing default shipping address
      const updated = this.updateAddress(existingDefault.id, {
        ...address,
        defaultShippingAddress: true
      });
      return updated!;
    } else {
      // Create new default shipping address
      return this.saveAddress({
        ...address,
        defaultShippingAddress: true,
        defaultBillingAddress: false
      });
    }
  }

  // Save or update default billing address (updates existing if found, creates new if not)
  static saveOrUpdateDefaultBillingAddress(address: Omit<LocalAddress, 'id' | 'lastUpdated'>): LocalAddress {
    const existingDefault = this.getDefaultBillingAddress();
    
    if (existingDefault && existingDefault.source === 'customer') {
      // Update existing default billing address
      const updated = this.updateAddress(existingDefault.id, {
        ...address,
        defaultBillingAddress: true
      });
      return updated!;
    } else {
      // Create new default billing address
      return this.saveAddress({
        ...address,
        defaultShippingAddress: false,
        defaultBillingAddress: true
      });
    }
  }

  // Set default shipping address
  static setDefaultShippingAddress(addressId: string): boolean {
    const addresses = this.getAddresses();
    let found = false;
    
    // Clear all default shipping flags and set the new one
    const updatedAddresses = addresses.map(addr => {
      if (addr.id === addressId) {
        found = true;
        return { ...addr, defaultShippingAddress: true };
      }
      return { ...addr, defaultShippingAddress: false };
    });
    
    if (found) {
      this.saveAddresses(updatedAddresses);
      return true;
    }
    
    return false;
  }

  // Set default billing address
  static setDefaultBillingAddress(addressId: string): boolean {
    const addresses = this.getAddresses();
    let found = false;
    
    // Clear all default billing flags and set the new one
    const updatedAddresses = addresses.map(addr => {
      if (addr.id === addressId) {
        found = true;
        return { ...addr, defaultBillingAddress: true };
      }
      return { ...addr, defaultBillingAddress: false };
    });
    
    if (found) {
      this.saveAddresses(updatedAddresses);
      return true;
    }
    
    return false;
  }

  // Sync addresses from Vendure API (using cached customer data)
  static async syncFromVendure(customerId?: string): Promise<void> {
    await syncAddressesFromVendure(customerId, {
      getAddresses: () => this.getAddresses(),
      saveAddresses: (addresses, id) => this.saveAddresses(addresses, id),
    });
  }

  // Push address changes to Vendure
  static async syncToVendure(address: LocalAddress): Promise<AddressSyncResult> {
    return syncAddressToVendure(address, {
      getAddresses: () => this.getAddresses(),
      saveAddresses: (addresses, id) => this.saveAddresses(addresses, id),
    });
  }

  // Check if sync is needed
  static shouldSync(customerId?: string): boolean {
    if (typeof window === 'undefined') return false;
    
    try {
      const stored = sessionStorage.getItem(this.ADDRESS_KEY);
      if (!stored) return true; // No cache, sync needed
      
      const cache: LocalAddressCache = JSON.parse(stored);
      
      // Check if customer ID changed
      if (cache.customerId !== customerId) return true;
      
      // Check if cache is stale
      const now = Date.now();
      return (now - cache.lastSync) >= this.CACHE_DURATION;
    } catch (error) {
      console.error('Error checking sync status:', error);
      return true; // Error reading cache, sync needed
    }
  }

}
