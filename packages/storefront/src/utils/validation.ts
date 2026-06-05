import validator from 'validator';
import { parsePhoneNumberFromString, CountryCode as LibCountryCode } from 'libphonenumber-js';
import * as usStateConverter from 'us-state-converter';

// Enhanced validation utilities for the storefront

// Common bogus data patterns to block
export const bogusPatterns = {
  // Test/placeholder emails
  testEmails: [
    'test@test.com', 'test@example.com', 'user@example.com', 
    'email@test.com', 'test@domain.com', 'fake@fake.com',
    'temp@temp.com', 'noreply@example.com', 'admin@test.com'
  ],
  
  // Common fake phone numbers
  fakePhones: [
    '0000000000', '1111111111', '1234567890', '0123456789',
    '5555555555', '9999999999', '1112223333', '5551234567'
  ],
  
  // Common test ZIP codes
  fakeZips: ['00000', '11111', '12345', '99999', '55555']
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
  if (!validator.isEmail(email)) {
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

export const validatePhone = (phone: string, countryCode: string, isOptional: boolean = false): ValidationResult => {
  const trimmedPhone = phone.trim();
  if (!trimmedPhone) {
    if (isOptional) {
      return { isValid: true }; // Empty phone is valid if optional
    }
    return { isValid: false, message: 'Phone number is required' };
  }

  // Check for invalid characters first
  if (hasInvalidPhoneCharacters(trimmedPhone)) {
    return { isValid: false, message: 'Phone numbers can only contain digits and formatting characters (+, -, (, ), spaces)' };
  }

  const digitsOnly = trimmedPhone.replace(/\D/g, '');
  
  // Check if phone has at least some digits
  if (digitsOnly.length === 0) {
    return { isValid: false, message: 'Phone number must contain at least some digits' };
  }

  // Check for common fake phone numbers
  if (bogusPatterns.fakePhones.includes(digitsOnly)) {
    return { isValid: false, message: 'Please enter a real phone number' };
  }

  // Basic length validation
  if (digitsOnly.length < 7) {
    return { isValid: false, message: 'Phone number is too short' };
  }
  
  if (digitsOnly.length > 15) {
    return { isValid: false, message: 'Phone number is too long' };
  }

  try {
    // Ensure countryCode is a valid LibCountryCode (uppercase ISO 3166-1 alpha-2)
    const upperCaseCountryCode = countryCode.toUpperCase() as LibCountryCode;
    const phoneNumber = parsePhoneNumberFromString(trimmedPhone, upperCaseCountryCode);
    if (phoneNumber && phoneNumber.isValid()) {
      return { isValid: true };
    } else {
      // More specific country-based error messages
      const countryName = getCountryName(upperCaseCountryCode);
      console.log(`Phone number ${trimmedPhone} for country ${upperCaseCountryCode} considered invalid by libphonenumber-js.`);
      return { isValid: false, message: `Invalid phone number format for ${countryName}. Please check the number format.` };
    }
  } catch (e) {
    console.error(`Error validating phone number '${trimmedPhone}' for ${countryCode.toUpperCase()}:`, e);
    const countryName = getCountryName(countryCode.toUpperCase());
    return { isValid: false, message: `Phone number format is not supported for ${countryName}. Please check the number and country.` };
  }
};

/**
 * Get country name for better error messages
 */
const getCountryName = (countryCode: string): string => {
  const countryNames: Record<string, string> = {
    'US': 'United States',
    'CA': 'Canada', 
    'GB': 'United Kingdom',
    'AU': 'Australia',
    'DE': 'Germany',
    'FR': 'France',
    'IT': 'Italy',
    'ES': 'Spain',
    'NL': 'Netherlands',
    'BE': 'Belgium',
    'CH': 'Switzerland',
    'AT': 'Austria',
    'SE': 'Sweden',
    'NO': 'Norway',
    'DK': 'Denmark',
    'FI': 'Finland',
    'IE': 'Ireland',
    'PT': 'Portugal',
    'PL': 'Poland',
    'CZ': 'Czech Republic',
    'HU': 'Hungary',
    'SK': 'Slovakia',
    'SI': 'Slovenia',
    'HR': 'Croatia',
    'BG': 'Bulgaria',
    'RO': 'Romania',
    'GR': 'Greece',
    'CY': 'Cyprus',
    'MT': 'Malta',
    'LU': 'Luxembourg',
    'EE': 'Estonia',
    'LV': 'Latvia',
    'LT': 'Lithuania',
    'UA': 'Ukraine'
  };
  return countryNames[countryCode] || countryCode;
};

export const validatePostalCode = (postalCode: string, countryCode: string): ValidationResult => {
  if (!postalCode.trim()) {
    return { isValid: false, message: 'Postal code is required' };
  }

  const cleanCode = postalCode.trim();
  const digitsOnly = postalCode.replace(/\D/g, '');

  // Check for common fake ZIP codes
  if (bogusPatterns.fakeZips.includes(digitsOnly)) {
    return { isValid: false, message: `Please enter a real ${getPostalCodeName(countryCode)}` };
  }

  const upperCaseCountryCode = countryCode.toUpperCase();
  // console.log(`[validatePostalCode] Validating postalCode: '${cleanCode}', country: '${upperCaseCountryCode}'`);

  // Specific handling for India (IN) using direct regex test
  if (upperCaseCountryCode === 'IN') {
    const indianPincodeRegex = /^[1-9][0-9]{5}$/;
    // console.log(`[validatePostalCode] Applying IN-specific regex: ${indianPincodeRegex}.test('${cleanCode}')`);
    if (indianPincodeRegex.test(cleanCode)) {
      // console.log(`[validatePostalCode] IN postal code '${cleanCode}' PASSED custom regex.`);
      return { isValid: true };
    } else {
      // console.log(`[validatePostalCode] IN postal code '${cleanCode}' FAILED custom regex.`);
      return { isValid: false, message: `Please enter a valid 6-digit Indian PIN code.` };
    }
  }

  // Specific handling for Portugal (PT) using direct regex test
  if (upperCaseCountryCode === 'PT') {
    // Portugal postal codes: NNNN-NNN format (e.g., 2970-712)
    const portugalPostalRegex = /^\d{4}-\d{3}$/;
    // console.log(`[validatePostalCode] Applying PT-specific regex: ${portugalPostalRegex}.test('${cleanCode}')`);
    if (portugalPostalRegex.test(cleanCode)) {
      // console.log(`[validatePostalCode] PT postal code '${cleanCode}' PASSED custom regex.`);
      return { isValid: true };
    } else {
      // console.log(`[validatePostalCode] PT postal code '${cleanCode}' FAILED custom regex.`);
      return { isValid: false, message: `Please enter a valid Portuguese postal code (format: 1234-567).` };
    }
  }

  // Use validator.isPostalCode for other countries with better error handling
  try {
    // console.log(`[validatePostalCode] Attempting validator.isPostalCode('${cleanCode}', '${upperCaseCountryCode}')`);
    const isValid = validator.isPostalCode(cleanCode, upperCaseCountryCode as any);
    // console.log(`[validatePostalCode] validator.isPostalCode result: ${isValid}`);

    if (isValid) {
      return { isValid: true };
    } else {
      // console.log(`[validatePostalCode] Postal code '${cleanCode}' for country '${upperCaseCountryCode}' failed validator.isPostalCode check.`);

      // For common countries, provide specific error messages
      if (['US', 'CA', 'GB', 'AU'].includes(upperCaseCountryCode)) {
        return { isValid: false, message: `Please enter a valid ${getPostalCodeName(countryCode)} for ${countryCode}.` };
      }

      // For other countries, be more lenient - accept if it looks like a postal code
      if (cleanCode.length >= 3 && cleanCode.length <= 10 && /^[A-Z0-9\s-]+$/i.test(cleanCode)) {
        // console.log(`[validatePostalCode] Accepting '${cleanCode}' as valid postal code for ${upperCaseCountryCode} (lenient fallback)`);
        return { isValid: true };
      }

      return { isValid: false, message: `Please enter a valid ${getPostalCodeName(countryCode)}.` };
    }
  } catch (e: any) {
    console.error(`[validatePostalCode] Error validating postal code '${cleanCode}' for country ${upperCaseCountryCode}:`, e.message);
    // Check if the error is due to an unsupported locale by validator.js
    if (e && e.message && e.message.toLowerCase().includes('invalid locale')) {
      // For unsupported locales, apply generic validation
      if (cleanCode.length >= 3 && cleanCode.length <= 10 && /^[A-Z0-9\s-]+$/i.test(cleanCode)) {
        // console.warn(`[validatePostalCode] Locale '${upperCaseCountryCode}' not supported by validator.isPostalCode. Accepting '${cleanCode}' via generic validation.`);
        return { isValid: true };
      } else {
        return { isValid: false, message: `Please enter a valid ${getPostalCodeName(countryCode)}.` };
      }
    }
    return { isValid: false, message: `Could not validate ${getPostalCodeName(countryCode)} for ${countryCode}. Please check the format.` };
  }
};

export const validateName = (name: string, fieldName: string = 'Name'): ValidationResult => {
  if (!name.trim()) {
    return { isValid: false, message: `${fieldName} is required` };
  }
  const trimmedName = name.trim();
  if (trimmedName.length < 2) {
    return { isValid: false, message: `${fieldName} must be at least 2 characters` };
  }
  if (!validator.isAlpha(trimmedName.replace(/[\s\-'.]/g, ''), 'en-US', { ignore: "-'. " })) {
    return { isValid: false, message: `${fieldName} contains invalid characters` };
  }
  return { isValid: true };
};

export const validateRequired = (value: string, fieldName: string): ValidationResult => {
  if (!value || !value.trim()) {
    return { isValid: false, message: `${fieldName} is required` };
  }
  return { isValid: true };
};

export const validateAddress = (address: string, fieldName: string = 'Address'): ValidationResult => {
  if (!address.trim()) {
    return { isValid: false, message: `${fieldName} is required` };
  }
  const trimmedAddress = address.trim();
  if (trimmedAddress.length < 5) {
    return { isValid: false, message: `${fieldName} must be at least 5 characters` };
  }
  if (!validator.isAlphanumeric(trimmedAddress.replace(/[\s\-.,]/g, ''), 'en-US', { ignore: "-., " })) {
    return { isValid: false, message: `Please enter a valid ${fieldName.toLowerCase()}` };
  }
  return { isValid: true };
};

export const getPostalCodeName = (countryCode: string): string => {
  switch (countryCode) {
    case 'US':
      return 'ZIP code';
    case 'CA':
      return 'postal code';
    case 'GB':
      return 'postcode';
    default:
      return 'postal code';
  }
};

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

// US State/Province validation with country-specific logic
export const validateStateProvince = (value: string, countryCode: string, fieldName: string = 'State/Province'): ValidationResult => {
  if (!value || !value.trim()) {
    return { isValid: false, message: `${fieldName} is required` };
  }

  const trimmedValue = value.trim();
  const upperCaseCountryCode = countryCode.toUpperCase();

  // For US, validate against actual state codes and names
  if (upperCaseCountryCode === 'US') {
    try {
      // Check if it's a valid state abbreviation (e.g., "CA", "NY")
      const stateNameResult = usStateConverter.fullName(trimmedValue.toUpperCase());
      if (stateNameResult && !stateNameResult.startsWith('No state found')) {
        return { isValid: true };
      }

      // Check if it's a valid state name (e.g., "California", "New York")  
      const abbrResult = usStateConverter.abbr(trimmedValue);
      if (abbrResult && !abbrResult.startsWith('No abbreviation found')) {
        return { isValid: true };
      }

      // If neither worked, it's invalid
      return { 
        isValid: false, 
        message: 'Please enter a valid US state (e.g., "CA" or "California")' 
      };
    } catch (error) {
      // Library error, fall back to basic validation
      console.warn('US state validation library error:', error);
      return validateRequired(trimmedValue, fieldName);
    }
  }

  // For Canada, basic validation (could be enhanced with Canadian provinces)
  if (upperCaseCountryCode === 'CA') {
    // Basic validation for Canadian provinces - could be enhanced
    const canadianProvinces = [
      'AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT',
      'ALBERTA', 'BRITISH COLUMBIA', 'MANITOBA', 'NEW BRUNSWICK', 'NEWFOUNDLAND AND LABRADOR',
      'NOVA SCOTIA', 'NORTHWEST TERRITORIES', 'NUNAVUT', 'ONTARIO', 'PRINCE EDWARD ISLAND',
      'QUEBEC', 'SASKATCHEWAN', 'YUKON'
    ];
    
    const upperValue = trimmedValue.toUpperCase();
    if (canadianProvinces.includes(upperValue)) {
      return { isValid: true };
    }
    
    return { 
      isValid: false, 
      message: 'Please enter a valid Canadian province (e.g., "ON" or "Ontario")' 
    };
  }

  // For other countries, use basic required validation
  return validateRequired(trimmedValue, fieldName);
};
