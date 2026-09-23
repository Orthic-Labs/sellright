import {
 validateAddress,
 validateName,
 validatePostalCode,
 validateStateProvince,
} from '~/utils/validation';
import type { ValidationResult } from '~/utils/validation';

export type ValidationErrors = {
 [key: string]: string;
};

type BillingFieldName = 'firstName' | 'lastName' | 'streetLine1' | 'city' | 'province' | 'postalCode';

const fieldFallbacks: Record<BillingFieldName, string> = {
 firstName: 'Invalid first name',
 lastName: 'Invalid last name',
 streetLine1: 'Invalid address',
 city: 'Invalid city',
 province: 'State/Province is required',
 postalCode: 'Invalid postal code',
};

export function validateBillingField(
 fieldName: string,
 value: string,
 countryCode: string,
 currentErrors: ValidationErrors,
): ValidationErrors {
 const safeValue = value ?? '';
 const errors = { ...currentErrors };
 let result: ValidationResult | null = null;

 switch (fieldName) {
  case 'firstName':
   result = validateName(safeValue, 'First name');
   break;
  case 'lastName':
   result = validateName(safeValue, 'Last name');
   break;
  case 'streetLine1':
   result = validateAddress(safeValue, 'Street address');
   break;
  case 'city':
   result = validateName(safeValue, 'City');
   break;
  case 'province':
   result = validateStateProvince(safeValue, countryCode, 'State/Province');
   break;
  case 'postalCode':
   result = validatePostalCode(safeValue, countryCode);
   break;
 }

 if (!result) return errors;

 const key = fieldName as BillingFieldName;
 errors[key] = result.isValid ? '' : (result.message ?? fieldFallbacks[key]);
 return errors;
}

export function validateBillingFormValues(
 values: {
  firstName?: string;
  lastName?: string;
  streetLine1?: string;
  city?: string;
  province?: string;
  postalCode?: string;
  countryCode?: string;
 },
 currentErrors: ValidationErrors,
): ValidationErrors {
 let errors = { ...currentErrors };
 const countryCode = values.countryCode ?? 'US';

 errors = validateBillingField('firstName', values.firstName ?? '', countryCode, errors);
 errors = validateBillingField('lastName', values.lastName ?? '', countryCode, errors);
 errors = validateBillingField('streetLine1', values.streetLine1 ?? '', countryCode, errors);
 errors = validateBillingField('city', values.city ?? '', countryCode, errors);
 errors = validateBillingField('province', values.province ?? '', countryCode, errors);
 errors = validateBillingField('postalCode', values.postalCode ?? '', countryCode, errors);

 return errors;
}
