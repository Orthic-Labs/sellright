import { createContextId, useContext, useContextProvider, useStore, Slot, component$ } from '@qwik.dev/core';

import type { Live } from '~/sellright/types/live';

// Define the checkout address state structure
export interface CheckoutAddressState extends Live {
  addressSubmissionComplete: boolean;
  addressSubmissionInProgress: boolean;
}

export const CheckoutAddressContextId = createContextId<CheckoutAddressState>('checkout-address-state');

export const useCheckoutAddressState = () => useContext(CheckoutAddressContextId);

const createInitialState = (): CheckoutAddressState => ({
  addressSubmissionComplete: false,
  addressSubmissionInProgress: false,
});

export const CheckoutAddressProvider = component$(() => {
  const state = useStore<CheckoutAddressState>(createInitialState());
  useContextProvider(CheckoutAddressContextId, state);

  return <Slot />;
});