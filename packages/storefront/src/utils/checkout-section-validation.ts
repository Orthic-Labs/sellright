import { validateAddress, validateEmail, validateName, validatePhone, validatePostalCode, validateStateProvince } from './validation';

export type CustomerSectionErrors = {
  email?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
};

export type AddressSectionErrors = {
  streetLine1?: string;
  city?: string;
  province?: string;
  postalCode?: string;
  countryCode?: string;
};

export type BillingSectionErrors = {
  firstName?: string;
  lastName?: string;
} & AddressSectionErrors;

type CustomerInput = {
  firstName?: string;
  lastName?: string;
  emailAddress?: string;
  phoneNumber?: string;
};

type AddressInput = {
  firstName?: string;
  lastName?: string;
  streetLine1?: string;
  city?: string;
  province?: string;
  postalCode?: string;
  countryCode?: string;
};

export function validateCustomerSection(customer: CustomerInput, countryCode = 'US') {
  const normalizedCountry = countryCode.toUpperCase();
  const isPhoneOptional = normalizedCountry === 'US' || normalizedCountry === 'PR';
  const firstName = validateName(customer.firstName || '', 'First name');
  const lastName = validateName(customer.lastName || '', 'Last name');
  const email = validateEmail(customer.emailAddress || '');
  const phone = validatePhone(customer.phoneNumber || '', normalizedCountry, isPhoneOptional);
  const errors: CustomerSectionErrors = {
    firstName: firstName.isValid ? undefined : (firstName.message || 'Invalid first name'),
    lastName: lastName.isValid ? undefined : (lastName.message || 'Invalid last name'),
    email: email.isValid ? undefined : (email.message || 'Invalid email'),
    phone: phone.isValid ? undefined : (phone.message || 'Invalid phone number'),
  };
  return {
    isValid: firstName.isValid && lastName.isValid && email.isValid && phone.isValid,
    errors,
  };
}

export function validateShippingSection(address: AddressInput) {
  const countryCode = (address.countryCode || 'US').toUpperCase();
  const street = validateAddress(address.streetLine1 || '', 'Street address');
  const city = validateName(address.city || '', 'City');
  const province = validateStateProvince(address.province || '', countryCode, 'State/Province');
  const postal = validatePostalCode(address.postalCode || '', countryCode);
  const errors: AddressSectionErrors = {
    streetLine1: street.isValid ? undefined : (street.message || 'Street address is required'),
    city: city.isValid ? undefined : (city.message || 'City is required'),
    province: province.isValid ? undefined : (province.message || 'State/Province is required'),
    postalCode: postal.isValid ? undefined : (postal.message || 'Postal code is required'),
    countryCode: address.countryCode ? undefined : 'Country is required',
  };
  return {
    isValid: street.isValid && city.isValid && province.isValid && postal.isValid && !!address.countryCode,
    errors,
  };
}

export function validateBillingSection(address: AddressInput) {
  const countryCode = (address.countryCode || 'US').toUpperCase();
  const firstName = validateName(address.firstName || '', 'First name');
  const lastName = validateName(address.lastName || '', 'Last name');
  const street = validateAddress(address.streetLine1 || '', 'Street address');
  const city = validateName(address.city || '', 'City');
  const province = validateStateProvince(address.province || '', countryCode, 'State/Province');
  const postal = validatePostalCode(address.postalCode || '', countryCode);
  const errors: BillingSectionErrors = {
    firstName: firstName.isValid ? undefined : (firstName.message || 'First name is required'),
    lastName: lastName.isValid ? undefined : (lastName.message || 'Last name is required'),
    streetLine1: street.isValid ? undefined : (street.message || 'Street address is required'),
    city: city.isValid ? undefined : (city.message || 'City is required'),
    province: province.isValid ? undefined : (province.message || 'State/Province is required'),
    postalCode: postal.isValid ? undefined : (postal.message || 'Postal code is required'),
    countryCode: address.countryCode ? undefined : 'Country is required',
  };
  return {
    isValid:
      firstName.isValid &&
      lastName.isValid &&
      street.isValid &&
      city.isValid &&
      province.isValid &&
      postal.isValid &&
      !!address.countryCode,
    errors,
  };
}
