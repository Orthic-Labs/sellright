import {
  formatExpiryDate,
  validateCVV,
  validateCardNumber,
  validateExpiryDate,
} from '~/utils/card-validation';
import type { CardFormData } from './NMI';

const FIELD_ORDER = ['cardNumber', 'expiryDate', 'cvv'];

export const focusNextPaymentField = (currentFieldId: string) => {
  if (typeof document === 'undefined') return;
  const nextField = document.getElementById(FIELD_ORDER[FIELD_ORDER.indexOf(currentFieldId) + 1]);
  nextField?.focus();
};

export const focusPreviousPaymentField = (currentFieldId: string) => {
  if (typeof document === 'undefined') return;
  const previousField = document.getElementById(FIELD_ORDER[FIELD_ORDER.indexOf(currentFieldId) - 1]);
  if (!previousField) return;
  previousField.focus();
  setTimeout(() => {
    if (previousField instanceof HTMLInputElement) {
      previousField.setSelectionRange(previousField.value.length, previousField.value.length);
    }
  }, 0);
};

export const isCardFieldCompleteAndValid = (
  field: keyof CardFormData,
  value: string,
  cardNumber: string,
): boolean => {
  switch (field) {
    case 'cardNumber':
      return validateCardNumber(value.replace(/\D/g, '')).isValid;
    case 'expiryDate':
      if (value.length !== 5 || !/^\d{2}\/\d{2}$/.test(value)) return false;
      return validateExpiryDate(value.replace(/\D/g, '')).isValid;
    case 'cvv': {
      const cardNumberValidation = validateCardNumber(cardNumber.replace(/\D/g, ''));
      const expectedLength = cardNumberValidation.cardBrand === 'american-express' ? 4 : 3;
      const cvvDigits = value.replace(/\D/g, '');
      return cvvDigits.length === expectedLength && validateCVV(cvvDigits).isValid;
    }
    default:
      return false;
  }
};

export const formatExpiryDateSmart = (input: string): string => {
  const digitsOnly = input.replace(/\D/g, '');
  if (digitsOnly.length === 0) return '';
  if (digitsOnly.length === 1) return parseInt(digitsOnly) > 1 ? `0${digitsOnly}/` : digitsOnly;
  if (digitsOnly.length === 2) {
    const month = parseInt(digitsOnly);
    return month > 12 ? `0${digitsOnly[0]}/${digitsOnly[1]}` : `${digitsOnly}/`;
  }
  if (digitsOnly.length === 3) {
    const month = parseInt(digitsOnly.slice(0, 2));
    return month > 12
      ? `0${digitsOnly[0]}/${digitsOnly.slice(1)}`
      : `${digitsOnly.slice(0, 2)}/${digitsOnly.slice(2)}`;
  }
  if (digitsOnly.length >= 4) return `${digitsOnly.slice(0, 2)}/${digitsOnly.slice(2, 4)}`;
  return formatExpiryDate(digitsOnly);
};
