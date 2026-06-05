import { component$, useSignal, $ } from '@qwik.dev/core';
import { useLocalCart, updateLocalCartQuantity, removeFromLocalCart } from '~/contexts/CartContext';
import StockError from '../alert/StockError';
import type { LocalCartItem } from '~/services/LocalCartService';

interface CartStockValidationProps {
  item: LocalCartItem;
}

/**
 * Example component showing how to integrate StockError with cart operations
 * This should be used in cart components to handle stock validation failures
 */
export default component$<CartStockValidationProps>(({ item }) => {
  const cartState = useLocalCart();
  const showStockError = useSignal(false);

  // Get stock validation result for this item
  const stockValidationResult = cartState.lastStockValidation[item.productVariantId];
  const hasStockError = stockValidationResult && !stockValidationResult.success;

  // Handle manual quantity adjustment by user
  const handleAdjustQuantity = $(() => {
    if (stockValidationResult?.availableStock !== undefined) {
      updateLocalCartQuantity(cartState, item.productVariantId, stockValidationResult.availableStock);
      showStockError.value = false;
    }
  });

  // Handle item removal by user
  const handleRemoveItem = $(() => {
    removeFromLocalCart(cartState, item.productVariantId);
    showStockError.value = false;
  });

  // Show stock error if validation failed
  if (hasStockError && stockValidationResult) {
    return (
      <div class="mb-4">
        <StockError
          productName={item.productVariant.name}
          requestedQuantity={item.quantity}
          availableStock={stockValidationResult.availableStock}
          onRemoveItem={handleRemoveItem}
          onAdjustQuantity={stockValidationResult.availableStock > 0 ? handleAdjustQuantity : undefined}
        />
      </div>
    );
  }

  // No stock errors for this item
  return null;
});

/**
 * Example usage in CartContents or other cart components:
 * 
 * ```tsx
 * import CartStockValidation from '../cart/CartStockValidation';
 * 
 * // In your cart rendering code:
 * {localCart.localCart.items.map((item) => (
 *   <li key={item.productVariantId} class="py-6">
 *     <!-- Show stock validation errors for this item -->
 *     <CartStockValidation item={item} />
 *     
 *     <!-- Rest of your cart item rendering -->
 *     <div class="flex items-center">
 *       <!-- Product image, name, price, quantity selector, etc. -->
 *     </div>
 *   </li>
 * ))}
 * ```
 * 
 * Key benefits:
 * 1. ✅ No more silent quantity adjustments
 * 2. ✅ Clear error messages with specific actions
 * 3. ✅ User has control over what happens to their cart
 * 4. ✅ Better user experience with transparency
 */