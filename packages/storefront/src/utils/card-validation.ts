/**
 * Credit card validation utilities
 * Provides client-side validation for credit card information using card-validator library
 */

import valid from 'card-validator';

export interface CardValidationResult {
  isValid: boolean;
  errorMessage?: string;
  cardBrand?: string;
}

/**
 * Validates credit card number using industry-standard validation
 */
export function validateCardNumber(cardNumber: string): CardValidationResult {
  // Remove spaces and non-digits for validation
  const cleanNumber = cardNumber.replace(/\s/g, '');
  
  if (!cleanNumber) {
    return { isValid: false, errorMessage: 'Card number is required' };
  }
  
  const validation = valid.number(cleanNumber);
  
  return {
    isValid: validation.isValid,
    errorMessage: validation.isValid ? undefined : 'Please enter a valid card number',
    cardBrand: validation.card?.type || undefined
  };
}

/**
 * Validates CVV/CVC code using industry-standard validation
 */
export function validateCVV(cvv: string): CardValidationResult {
  if (!cvv) {
    return { isValid: false, errorMessage: 'Security code is required' };
  }
  
  // Get the expected CVV length from card-validator if we have card number validation
  const validation = valid.cvv(cvv);
  
  return {
    isValid: validation.isValid,
    errorMessage: validation.isValid ? undefined : 'Please enter a valid security code'
  };
}

/**
 * Validates expiry date using industry-standard validation
 */
export function validateExpiryDate(expiry: string): CardValidationResult {
  if (!expiry) {
    return { isValid: false, errorMessage: 'Expiry date is required' };
  }
  
  const validation = valid.expirationDate(expiry);
  
  return {
    isValid: validation.isValid,
    errorMessage: validation.isValid ? undefined : 'Please enter a valid expiry date (MM/YY)'
  };
}

/**
 * Detects card type based on card number using industry-standard validation
 */
export function detectCardType(cardNumber: string): string {
  const cleanNumber = cardNumber.replace(/\s/g, '');
  
  if (!cleanNumber) return 'unknown';
  
  const validation = valid.number(cleanNumber);
  return validation.card?.type || 'unknown';
}

/**
 * Formats card number with spaces for display using industry-standard formatting
 */
export function formatCardNumber(cardNumber: string): string {
  const cleanNumber = cardNumber.replace(/\D/g, '');
  
  if (!cleanNumber) return '';
  
  const validation = valid.number(cleanNumber);
  
  if (validation.card?.gaps) {
    let formatted = cleanNumber;
    const gaps = [...validation.card.gaps].reverse(); // Reverse to apply from right to left
    
    gaps.forEach(gap => {
      if (formatted.length > gap) {
        formatted = formatted.slice(0, gap) + ' ' + formatted.slice(gap);
      }
    });
    
    return formatted;
  }
  
  // Fallback to generic 4-digit grouping
  return cleanNumber.replace(/(\d{4})(?=\d)/g, '$1 ');
}

/**
 * Formats expiry date as MM/YY using industry-standard validation
 */
export function formatExpiryDate(expiry: string): string {
  const cleanExpiry = expiry.replace(/\D/g, '');
  
  if (cleanExpiry.length === 0) return '';
  if (cleanExpiry.length === 1) return cleanExpiry;
  if (cleanExpiry.length === 2) return cleanExpiry;
  if (cleanExpiry.length === 3) return cleanExpiry.slice(0, 2) + '/' + cleanExpiry.slice(2, 3);
  
  return cleanExpiry.slice(0, 2) + '/' + cleanExpiry.slice(2, 4);
}
