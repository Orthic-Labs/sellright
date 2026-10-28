import { ActiveCustomer, ShippingAddress } from '~/types';
import {
  validatePostalCode,
  validateCity,
  validateEmail,
  validateAddress,
  validateStateProvince,
} from '~/utils/validation';

export const isShippingAddressValid = (orderAddress: ShippingAddress): boolean => {
  if (!orderAddress) return false;

  const streetResult = validateAddress(orderAddress.streetLine1 || '', 'Street address');
  const cityResult = validateCity(orderAddress.city || '');
  const provinceResult = validateStateProvince(
    orderAddress.province || '',
    orderAddress.countryCode || 'US',
    'State/Province'
  );
  const postalResult = validatePostalCode(orderAddress.postalCode || '', orderAddress.countryCode || 'US');

  return (
    streetResult.isValid &&
    cityResult.isValid &&
    provinceResult.isValid &&
    postalResult.isValid &&
    !!orderAddress.countryCode
  );
};

export const isBillingAddressValid = (billingAddress: ShippingAddress): boolean => {
  if (!billingAddress) return false;

  const streetResult = validateAddress(billingAddress.streetLine1 || '', 'Street address');
  const cityResult = validateCity(billingAddress.city || '');
  const provinceResult = validateStateProvince(
    billingAddress.province || '',
    billingAddress.countryCode || 'US',
    'State/Province'
  );
  const postalResult = validatePostalCode(
    billingAddress.postalCode || '',
    billingAddress.countryCode || 'US'
  );

  return (
    streetResult.isValid &&
    cityResult.isValid &&
    provinceResult.isValid &&
    postalResult.isValid &&
    !!billingAddress.countryCode
  );
};

export const isActiveCustomerValid = (
  activeCustomer: ActiveCustomer | null | undefined
): boolean => {
  if (!activeCustomer) {
    return false;
  }

  if (!activeCustomer.firstName || !activeCustomer.lastName || !activeCustomer.emailAddress) {
    return false;
  }

  const emailResult = validateEmail(activeCustomer.emailAddress);
  return emailResult.isValid;
};
