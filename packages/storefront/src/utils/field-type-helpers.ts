/**
 * Field Type Utilities for Validation Cache
 * 
 * Helper functions to determine field types for cache key generation.
 * These are defined outside components to avoid Qwik serialization issues.
 */

/**
 * Get field type for address form fields
 */
export function getFieldType(fieldName: string): string {
  switch (fieldName) {
    case 'streetLine1':
    case 'streetLine2':
      return 'address';
    case 'city':
      return 'name';
    case 'province':
      return 'state';
    case 'postalCode':
      return 'postal';
    default:
      return 'generic';
  }
}

/**
 * Get field type for billing address form fields
 */
export function getBillingFieldType(fieldName: string): string {
  switch (fieldName) {
    case 'firstName':
    case 'lastName':
    case 'city':
      return 'name';
    case 'streetLine1':
    case 'streetLine2':
      return 'address';
    case 'province':
      return 'state';
    case 'postalCode':
      return 'postal';
    default:
      return 'generic';
  }
}
