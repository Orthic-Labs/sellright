/**
 * Cached Validation Functions
 * 
 * Provides cached versions of all validation functions used in checkout.
 * Falls back to original validation if caching fails.
 */

import {
  validateEmail as originalValidateEmail,
  validateName as originalValidateName,
  validatePhone as originalValidatePhone,
  validatePostalCode as originalValidatePostalCode,
  validateAddress as originalValidateAddress,
  validateRequired as originalValidateRequired,
  validateStateProvince as originalValidateStateProvince,
  filterPhoneInput
} from './validation';
import { withCache, clearValidationCache } from './validation-cache';

/**
 * Cached email validation
 */
export const validateEmail = withCache(
  originalValidateEmail,
  (email: string) => `email:${email.trim().toLowerCase()}`
);

/**
 * Cached name validation
 */
export const validateName = withCache(
  originalValidateName,
  (name: string, fieldName: string = 'Name') => `name:${fieldName}:${name.trim().toLowerCase()}`
);

/**
 * Cached phone validation
 */
export const validatePhone = withCache(
  originalValidatePhone,
  (phone: string, countryCode: string, isOptional: boolean = false) => 
    `phone:${countryCode}:${isOptional}:${phone.replace(/\D/g, '')}`
);

/**
 * Cached postal code validation
 */
export const validatePostalCode = withCache(
  originalValidatePostalCode,
  (postalCode: string, countryCode: string) => 
    `postal:${countryCode}:${postalCode.trim().toUpperCase()}`
);

/**
 * Cached address validation
 */
export const validateAddress = withCache(
  originalValidateAddress,
  (address: string, fieldName: string = 'Address') => 
    `address:${fieldName}:${address.trim().toLowerCase()}`
);

/**
 * Cached required field validation
 */
export const validateRequired = withCache(
  originalValidateRequired,
  (value: string, fieldName: string) => 
    `required:${fieldName}:${value.trim()}`
);

/**
 * Cached state/province validation
 */
export const validateStateProvince = withCache(
  originalValidateStateProvince,
  (value: string, countryCode: string, fieldName: string = 'State/Province') =>
    `state:${countryCode}:${fieldName}:${value.trim().toLowerCase()}`
);

/**
 * Clear validation cache when field values change
 */
export function clearFieldValidationCache(fieldName: string, fieldType?: string): void {
  if (fieldType) {
    // Clear specific field type cache
    clearValidationCache(`${fieldType}:${fieldName}:*`);
  } else {
    // Clear all caches for this field name
    clearValidationCache(`*:${fieldName}:*`);
  }
}

/**
 * Clear all validation caches (use when form is reset)
 */
export function clearAllValidationCache(): void {
  clearValidationCache();
}

/**
 * Clear country-specific caches when country changes
 */
export function clearCountryValidationCache(oldCountry?: string, newCountry?: string): void {
  if (oldCountry) {
    clearValidationCache(`phone:${oldCountry}:*`);
    clearValidationCache(`postal:${oldCountry}:*`);
  }
  if (newCountry) {
    clearValidationCache(`phone:${newCountry}:*`);
    clearValidationCache(`postal:${newCountry}:*`);
  }
}

// Re-export utility functions that don't need caching
export { filterPhoneInput };
