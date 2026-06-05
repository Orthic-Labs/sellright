import { $, useStore } from '@qwik.dev/core';
import { useLocalCart } from '~/contexts/CartContext';
import { LocalCartService } from '~/services/LocalCartService';
import { convertLocalCartToVendureOrder as _convertLocalCartToVendureOrder } from '~/contexts/CartContext';

/**
 * @description
 * A hook to manage the checkout process, including converting the local cart
 * to a Vendure order and managing the application's state.
 */
export const useCheckout = () => {
  const cartState = useLocalCart();
  
  const checkoutState = useStore({
    isLoading: false,
    error: null as string | null,
  });

  /**
   * Converts the local cart to a Vendure order and updates the app's mode.
   * Does NOT clear the cart items.
   */
  const convertLocalCartToVendureOrder = $(async () => {
    checkoutState.isLoading = true;
    checkoutState.error = null;
    
    try {
      const stockValidation = LocalCartService.validateStock();
      if (!stockValidation.valid) {
        throw new Error(`Stock validation failed: ${stockValidation.errors.join(', ')}`);
      }
      
      const order = await _convertLocalCartToVendureOrder(cartState);
      
      if (order) {
        return order;
      } else {
        throw new Error('Failed to create Vendure order from the cart.');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'An unknown checkout error occurred.';
      checkoutState.error = errorMessage;
      console.error('❌ useCheckout: Failed to convert cart:', error);
      return null;
    } finally {
      checkoutState.isLoading = false;
    }
  });

  return {
    checkoutState,
    convertLocalCartToVendureOrder,
  };
};