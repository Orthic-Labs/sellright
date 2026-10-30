import isEmail from 'validator/es/lib/isEmail';
import {
  postcodeNoun,
  validateAddressLine,
  validateCity as cityRule,
  validatePersonName,
  validatePhoneLoose,
  validatePostcode,
  validateRegion,
} from './address-rules';

// Enhanced validation utilities for the storefront

// Common bogus data patterns to block
export const bogusPatterns = {
  // Test/placeholder emails
  testEmails: [
    'test@test.com', 'test@example.com', 'user@example.com', 
    'email@test.com', 'test@domain.com', 'fake@fake.com',
    'temp@temp.com', 'noreply@example.com', 'admin@test.com'
  ],
};

export interface ValidationResult {
  isValid: boolean;
  message?: string;
}

export const validateEmail = (email: string): ValidationResult => {
  if (!email.trim()) {
    return { isValid: false, message: 'Email is required' };
  }

  const trimmedEmail = email.trim().toLowerCase();

  // Check for common test/fake emails
  if (bogusPatterns.testEmails.includes(trimmedEmail)) {
    return { isValid: false, message: 'Please enter a real email address' };
  }

  // Use validator for email
  if (!isEmail(email)) {
    return { isValid: false, message: 'Please enter a valid email address' };
  }

  if (email.length > 254) {
    return { isValid: false, message: 'Email address is too long' };
  }

  return { isValid: true };
};

/**
 * Sanitizes phone number value to prevent "null" strings from appearing
 * Converts null, "null", undefined, and empty strings to empty string
 */
export const sanitizePhoneNumber = (phone: any): string => {
  if (phone === null || phone === undefined || phone === 'null' || phone === '') {
    return '';
  }
  return String(phone);
};

/**
 * Filters phone input in real-time to only allow valid characters
 * Allows: digits (0-9), +, -, (, ), spaces
 */
export const filterPhoneInput = (input: string): string => {
  return input.replace(/[^0-9+\-() ]/g, '');
};

/**
 * Detects if phone number contains invalid characters
 */
export const hasInvalidPhoneCharacters = (phone: string): boolean => {
  return /[^0-9+\-()\s]/.test(phone);
};

// #407: the address rules live in ./address-rules (shared with the API). These wrappers keep the old call sites.

/** Phone is optional unless `isOptional` is false; when given it gets the loose check only. */
export const validatePhone = (phone: string, _countryCode: string, isOptional: boolean = true): ValidationResult =>
  validatePhoneLoose(phone, !isOptional);

export const validatePostalCode = (postalCode: string, countryCode: string): ValidationResult =>
  validatePostcode(postalCode, countryCode || 'US');

export const validateName = (name: string, fieldName: string = 'Name'): ValidationResult =>
  validatePersonName(name, fieldName);

export const validateCity = (city: string): ValidationResult => cityRule(city);

export const validateRequired = (value: string, fieldName: string): ValidationResult => {
  if (!value || !value.trim()) {
    return { isValid: false, message: `${fieldName} is required` };
  }
  return { isValid: true };
};

export const validateAddress = (address: string, fieldName: string = 'Address'): ValidationResult =>
  validateAddressLine(address, fieldName);

export const getPostalCodeName = (countryCode: string): string => postcodeNoun(countryCode);

export const formatPhoneNumber = (phone: string, countryCode: string): string => {
  const cleaned = phone.replace(/\D/g, '');
  
  switch (countryCode) {
    case 'US':
    case 'CA':
      if (cleaned.length === 10) {
        return `(${cleaned.slice(0, 3)}) ${cleaned.slice(3, 6)}-${cleaned.slice(6)}`;
      }
      if (cleaned.length === 11 && cleaned[0] === '1') {
        return `+1 (${cleaned.slice(1, 4)}) ${cleaned.slice(4, 7)}-${cleaned.slice(7)}`;
      }
      break;
    case 'GB':
      if (cleaned.length === 11 && cleaned.startsWith('44')) {
        return `+44 ${cleaned.slice(2, 6)} ${cleaned.slice(6)}`;
      }
      break;
  }
  
  return phone; // Return original if no formatting applies
};

// State/province: required only where carriers need it; checked against a list for US, CA and AU.
export const validateStateProvince = (value: string, countryCode: string, fieldName: string = 'State/Province'): ValidationResult =>
  validateRegion(value, countryCode || 'US', fieldName);
