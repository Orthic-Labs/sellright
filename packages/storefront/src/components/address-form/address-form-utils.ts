import { ShippingAddress } from '~/types';
import {
 validateAddress,
 validateCity,
 validatePostalCode,
 validateStateProvince,
} from '~/utils/validation';

export interface ValidationErrors {
 streetLine1?: string;
 city?: string;
 province?: string;
 postalCode?: string;
}

const IN_STATE_MAP: Record<string, string> = {
 maharashtra: 'Maharashtra',
 delhi: 'Delhi',
 karnataka: 'Karnataka',
 'tamil nadu': 'Tamil Nadu',
 'west bengal': 'West Bengal',
 'uttar pradesh': 'Uttar Pradesh',
 gujarat: 'Gujarat',
 rajasthan: 'Rajasthan',
 'madhya pradesh': 'Madhya Pradesh',
 'andhra pradesh': 'Andhra Pradesh',
};

const IN_CITY_MAP: Record<string, string> = {
 mumbai: 'Mumbai',
 delhi: 'Delhi',
 bengaluru: 'Bengaluru',
 bangalore: 'Bengaluru',
 chennai: 'Chennai',
 kolkata: 'Kolkata',
 hyderabad: 'Hyderabad',
};

const capitalizeFirst = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

export const normalizeShippingAddress = (address: ShippingAddress): ShippingAddress => {
 if (address.countryCode !== 'IN') return address;
 const normalized = { ...address };
 const cityKey = (normalized.city || '').trim().toLowerCase();
 const provinceKey = (normalized.province || '').trim().toLowerCase();

 if (IN_CITY_MAP[cityKey]) normalized.city = IN_CITY_MAP[cityKey];
 else if (normalized.city) normalized.city = capitalizeFirst(normalized.city);

 if (IN_STATE_MAP[provinceKey]) normalized.province = IN_STATE_MAP[provinceKey];
 else if (normalized.province) normalized.province = capitalizeFirst(normalized.province);

 return normalized;
};

export const validateAddressField = (
 fieldName: string,
 value: string,
 countryCode = 'US',
 currentErrors: ValidationErrors,
): ValidationErrors => {
 const errors = { ...currentErrors };

 switch (fieldName) {
  case 'streetLine1': {
   const result = validateAddress(value, 'Street address');
   errors.streetLine1 = result.isValid ? '' : result.message;
   break;
  }
  case 'city': {
   const result = validateCity(value);
   errors.city = result.isValid ? '' : result.message;
   break;
  }
  case 'province': {
   const result = validateStateProvince(value, countryCode, 'State/Province');
   errors.province = result.isValid ? '' : result.message;
   break;
  }
  case 'postalCode': {
   const result = validatePostalCode(value, countryCode);
   errors.postalCode = result.isValid ? '' : result.message;
   break;
  }
 }

 return errors;
};

export const isShippingAddressFieldsValid = (address: ShippingAddress): boolean => {
 const countryCode = address.countryCode || 'US';
 return validateAddress(address.streetLine1 || '', 'Street address').isValid
  && validateCity(address.city || '').isValid
  && validateStateProvince(address.province || '', countryCode, 'State/Province').isValid
  && validatePostalCode(address.postalCode || '', countryCode).isValid;
};

export type PostalLookupField = 'city' | 'province';

/**
 * Which fields a postal-code lookup result may write.
 *
 * A lookup lands asynchronously, so it must not touch a field the shopper is in right now (`focusedField`) or one
 * they have typed into themselves (`userEdited` and non-empty). Empty fields, and fields still holding an earlier
 * lookup or a value loaded from a saved address, are fair game. An empty result value, or one equal to what the
 * field already holds, is never written.
 */
export const postalLookupPatch = (input: {
 current: Record<PostalLookupField, string>;
 userEdited: Record<PostalLookupField, boolean>;
 focusedField: string | null;
 result: Partial<Record<PostalLookupField, string>>;
}): Partial<Record<PostalLookupField, string>> => {
 const patch: Partial<Record<PostalLookupField, string>> = {};
 for (const field of ['city', 'province'] as const) {
  const next = input.result[field];
  if (!next || next === input.current[field]) continue;
  if (input.focusedField === field) continue;
  if (input.current[field] !== '' && input.userEdited[field]) continue;
  patch[field] = next;
 }
 return patch;
};
