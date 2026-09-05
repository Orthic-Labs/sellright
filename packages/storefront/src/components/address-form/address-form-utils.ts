import { ShippingAddress } from '~/types';
import {
 validateAddress,
 validateName,
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

export const normalizeShippingAddress = <T extends ShippingAddress>(address: T): T => {
 if (address.countryCode !== 'IN') return address;
 const normalized = { ...address } as T;
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
   const result = validateName(value, 'City');
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
  && validateName(address.city || '', 'City').isValid
  && validateStateProvince(address.province || '', countryCode, 'State/Province').isValid
  && validatePostalCode(address.postalCode || '', countryCode).isValid;
};
