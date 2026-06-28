import type { Order } from '~/generated/graphql-shop';
import {
  addItemsToOrderMutation,
  addItemToOrderMutation,
  applyCouponCodeMutation,
  getActiveOrderQuery,
  removeAllOrderLinesMutation,
} from '~/providers/shop/orders/order';
import type { LocalCart, ValidationErrors } from './local-cart-types';

type ConvertLocalCartOptions = {
  appliedCoupon?: { code: string } | null;
  getCart: () => LocalCart;
  validateStock: () => ValidationErrors;
};

function generateCartHash(cart: LocalCart): string {
  const cartString = cart.items
    .map(item => `${item.productVariantId}:${item.quantity}`)
    .sort()
    .join('|');

  let hash = 0;
  for (let i = 0; i < cartString.length; i++) {
    const char = cartString.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

export async function convertLocalCartToVendureOrder(options: ConvertLocalCartOptions): Promise<Order | null> {
  const conversionId = `conversion_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const inProgressKey = 'cart_conversion_in_progress';
  const existingConversion = localStorage.getItem(inProgressKey);

  if (existingConversion) {
    const lockData = JSON.parse(existingConversion);
    const lockAge = Date.now() - lockData.timestamp;
    const LOCK_TIMEOUT = 5 * 60 * 1000;

    if (lockAge < LOCK_TIMEOUT) {
      throw new Error('Order creation already in progress. Please wait.');
    }
    localStorage.removeItem(inProgressKey);
  }

  localStorage.setItem(inProgressKey, JSON.stringify({
    conversionId,
    timestamp: Date.now(),
    cartHash: generateCartHash(options.getCart())
  }));

  try {
    const cart = options.getCart();
    if (cart.items.length === 0) return null;

    const validation = options.validateStock();
    if (!validation.valid) {
      throw new Error(`Some items in your cart are out of stock: ${validation.errors.join(', ')}`);
    }

    let order: Order | null = null;

    try {
      const existingOrder = await getActiveOrderQuery();
      if (existingOrder && existingOrder.lines && existingOrder.lines.length > 0) {
        console.log(`[${conversionId}] Found existing order with ${existingOrder.lines.length} items. Clearing to prevent accumulation.`);

        try {
          await removeAllOrderLinesMutation();
          console.log(`[${conversionId}] Removed all existing order lines in one batch`);
        } catch (removeError) {
          console.warn('Failed to remove all order lines:', conversionId, removeError);
        }

        order = await getActiveOrderQuery();
        console.log(`[${conversionId}] Order cleared. Remaining lines: ${order?.lines?.length || 0}`);
      }
    } catch (clearError) {
      console.warn('Failed to clear existing order items:', conversionId, clearError);
    }

    const batchInput = cart.items.map(item => ({
      productVariantId: item.productVariantId,
      quantity: item.quantity
    }));

    try {
      const batchResult = await addItemsToOrderMutation(batchInput);
      if (batchResult) {
        throw new Error('Unexpected batchResult from addItemsToOrderMutation');
      }
      throw new Error('Invalid batch operation response');
    } catch (batchError) {
      console.warn('Batch operation failed, falling back to sequential processing:', conversionId, batchError);

      let successfulItems = 0;
      for (const item of cart.items) {
        try {
          const result = await addItemToOrderMutation(item.productVariantId, item.quantity);

          if (result && '__typename' in result && result.__typename === 'Order') {
            order = result as Order;
            successfulItems++;
          } else {
            console.error('Failed to add item, received:', item.productVariantId, conversionId, result);
            const itemAddError = new Error(`Failed to add ${item.productVariant.name} to order`) as Error & { cause?: unknown };
            itemAddError.cause = batchError;
            throw itemAddError;
          }
        } catch (itemError) {
          console.error('Error adding item:', item.productVariantId, conversionId, itemError);
          throw itemError;
        }
      }

      if (successfulItems !== cart.items.length) {
        const partialAddError = new Error(`Only ${successfulItems} of ${cart.items.length} items were added to the order`) as Error & { cause?: unknown };
        partialAddError.cause = batchError;
        throw partialAddError;
      }
    }

    if (order && options.appliedCoupon?.code) {
      try {
        const couponResult = await applyCouponCodeMutation(options.appliedCoupon.code);
        if (couponResult && '__typename' in couponResult && couponResult.__typename === 'Order') {
          order = couponResult as Order;
        }
      } catch (couponError) {
        console.error('Error applying coupon:', options.appliedCoupon.code, conversionId, couponError);
      }
    }

    if (!order) throw new Error('Failed to create order with items');
    return order;
  } catch (error) {
    console.error('Failed to convert cart to Vendure order:', conversionId, error);
    throw error;
  } finally {
    localStorage.removeItem(inProgressKey);
  }
}
