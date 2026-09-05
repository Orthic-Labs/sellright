import {
  component$,
  createContextId,
  useComputed$,
  useContext,
  useContextProvider,
  useStore,
  useOnWindow,
  useOnDocument,
  $,
  Slot
} from '@qwik.dev/core';
import { LocalCartService, type LocalCart, type StockValidationResult } from '~/services/LocalCartService';
import { ServerCartService } from '~/services/ServerCartService';

/**
 * Strangler flag (cart-architecture plan, Phase B): when `VITE_SERVER_CART` is
 * truthy the cart is backed by the server-authoritative ServerCartService;
 * otherwise it stays on the localStorage-only LocalCartService. The exported
 * hook shape is identical either way, so Cart.tsx / CartContents.tsx /
 * header.tsx / the product page consume the same context unchanged.
 */
export const SERVER_CART_ENABLED =
  String(import.meta.env.VITE_SERVER_CART ?? '').toLowerCase() === '1' ||
  String(import.meta.env.VITE_SERVER_CART ?? '').toLowerCase() === 'true';

// Applied coupon information for local cart mode
export interface AppliedCoupon {
  code: string;
  discountAmount: number;
  discountPercentage?: number;
  freeShipping: boolean;
  promotionName?: string;
  promotionDescription?: string;
}

// Cart Context Interface - Only store data, not functions
export interface CartContextState {
  // Cart data
  localCart: LocalCart;

  // State flags
  isLoading: boolean;
  lastError: string | null;
  hasLoadedOnce: boolean; // Track if cart has been loaded from localStorage
  isRefreshingStock: boolean; // Track if stock refresh is in progress

  // Stock validation results
  lastStockValidation: Record<string, StockValidationResult>;

  // Applied coupon for local cart mode
  appliedCoupon: AppliedCoupon | null;
}

// Create context for state only
export const CartContextId = createContextId<CartContextState>('cart-context');

// Context Provider Component
export const CartProvider = component$(() => {
  // Initialize cart state
  const cartState = useStore<CartContextState>({
    localCart: {
      items: [],
      totalQuantity: 0,
      subTotal: 0,
      currencyCode: 'USD'
    },
    isLoading: false,
    lastError: null,
    hasLoadedOnce: false,
    isRefreshingStock: false,
    lastStockValidation: {},
    appliedCoupon: null
  });

  // Init cart on page boot. Under the server-cart flag we hydrate the optimistic
  // mirror first (instant paint from the persisted copy) then reconcile from the
  // server in the background (server wins). B0: ServerCartService seeds itself
  // from any legacy local cart on the first mutation, never deleting that key.
  useOnDocument('qinit', $(() => {
    if (!cartState.hasLoadedOnce) {
      try {
        if (SERVER_CART_ENABLED) {
          cartState.localCart = ServerCartService.getCart();
          cartState.hasLoadedOnce = true;
          ServerCartService.refresh()
            .then((cart) => { cartState.localCart = cart; })
            .catch((e) => console.error('CartContext: server cart refresh failed:', e));
        } else {
          cartState.localCart = LocalCartService.getCart();
          cartState.hasLoadedOnce = true;
        }
      } catch (error) {
        console.error('CartContext: Failed to load cart:', error);
        cartState.lastError = 'Failed to load cart';
      }
    }
  }));

  // T4: Cross-tab sync via storage event (no UVT)
  useOnWindow('storage', $((event: Event) => {
    const e = event as StorageEvent;
    if (e.key === 'vendure-cart' || e.key === 'vendure-country') {
      LocalCartService.setupCrossTabSync();
      if (cartState.hasLoadedOnce) {
        const updatedCart = LocalCartService.getCart();
        if (updatedCart && typeof updatedCart === 'object') {
          cartState.localCart = {
            items: updatedCart.items || [],
            totalQuantity: updatedCart.totalQuantity || 0,
            subTotal: updatedCart.subTotal || 0,
            currencyCode: updatedCart.currencyCode || 'USD',
            appliedCoupon: updatedCart.appliedCoupon || null
          };
          cartState.appliedCoupon = updatedCart.appliedCoupon || null;
        }
        cartState.lastError = null;
        window.dispatchEvent(new CustomEvent('cart-updated', {
          detail: { totalQuantity: cartState.localCart.totalQuantity }
        }));
      }
    }
  }));

  // 🚀 OPTIMIZED: Removed computed values - cart totals calculated in LocalCartService

  // Provide context
  useContextProvider(CartContextId, cartState);

  return <Slot />;
});

// Hook to use cart context
export const useLocalCart = () => {
  return useContext(CartContextId);
};

const isPreOrderCartItem = (item: unknown): boolean => {
  const it = item as any;
  return !!it?.isPreOrder || !!it?.productVariant?.customFields?.isPreOrder;
};

// Hook: detect if cart contains any pre-order item. Keep this as a real Qwik
// computed signal so checkout consumers react when cart contents change.
export const useHasPreOrder = () => {
  const cart = useContext(CartContextId);
  return useComputed$(() => (cart.localCart.items || []).some(isPreOrderCartItem));
};

// Hook: detect MIXED cart — at least one pre-order AND at least one regular item.
export const useHasMixedPreOrder = () => {
  const cart = useContext(CartContextId);
  return useComputed$(() => {
    const items = cart.localCart.items || [];
    return items.some(isPreOrderCartItem) && items.some((item) => !isPreOrderCartItem(item));
  });
};


// 🚀 OPTIMIZED: Load cart on-demand when needed
export const loadCartIfNeeded = $((cartState: CartContextState) => {
  if (!cartState.hasLoadedOnce) {
    try {
      cartState.localCart = SERVER_CART_ENABLED ? ServerCartService.getCart() : LocalCartService.getCart();
      // Restore applied coupon from persisted cart data
      cartState.appliedCoupon = (cartState.localCart as any).appliedCoupon || null;
      cartState.hasLoadedOnce = true;
    } catch (error) {
      console.error('❌ CartContext: Failed to load cart on-demand:', error);
      cartState.lastError = 'Failed to load cart';
    }
  }
});

// Refresh stock levels — always hits live backend, no debounce. Under the server
// cart flag this re-fetches the server-priced cart (server is the source of truth).
export const refreshCartStock = $(async (cartState: CartContextState) => {
  if (!cartState.localCart.items.length) return;
  if (cartState.isRefreshingStock) return;

  try {
    cartState.isRefreshingStock = true;
    const updatedCart = SERVER_CART_ENABLED
      ? await ServerCartService.refresh()
      : await LocalCartService.refreshAllStockLevels();
    cartState.localCart = updatedCart;
  } catch (error) {
    console.error('CartContext: Failed to refresh stock levels:', error);
    cartState.lastError = 'Failed to refresh stock levels';
  } finally {
    cartState.isRefreshingStock = false;
  }
});

// Helper functions that can be called from components
export const addToLocalCart = $(async (cartState: CartContextState, item: any) => {
  // 🚀 DEMAND-BASED: Load cart only when add to cart is clicked
  await loadCartIfNeeded(cartState);

  cartState.isLoading = true;
  cartState.lastError = null;

  try {
    const result = SERVER_CART_ENABLED
      ? await ServerCartService.addItem(item)
      : LocalCartService.addItem(item);
    cartState.localCart = result.cart;
    cartState.lastStockValidation[item.productVariantId] = result.stockResult;

    if (!result.stockResult.success) {
      cartState.lastError = result.stockResult.error || 'Stock validation failed';
    }

    // 🚀 OPTIMIZED: Trigger header badge update via custom event
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('cart-updated', {
        detail: { totalQuantity: result.cart.totalQuantity }
      }));
    }
  } catch (error) {
    cartState.lastError = error instanceof Error ? error.message : 'Failed to add item to cart';
  } finally {
    cartState.isLoading = false;
  }
});

export const updateLocalCartQuantity = $(async (cartState: CartContextState, productVariantId: string, quantity: number) => {
  // Load cart if not already loaded
  await loadCartIfNeeded(cartState);

  cartState.isLoading = true;
  cartState.lastError = null;

  try {
    const result = SERVER_CART_ENABLED
      ? await ServerCartService.updateItemQuantity(productVariantId, quantity)
      : await LocalCartService.updateItemQuantity(productVariantId, quantity);
    cartState.localCart = result.cart;
    cartState.lastStockValidation[productVariantId] = result.stockResult;

    if (!result.stockResult.success) {
      cartState.lastError = result.stockResult.error || 'Stock validation failed';
    }

    // 🚀 OPTIMIZED: Trigger header badge update
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('cart-updated', {
        detail: { totalQuantity: result.cart.totalQuantity }
      }));
    }
  } catch (error) {
    cartState.lastError = error instanceof Error ? error.message : 'Failed to update quantity';
  } finally {
    cartState.isLoading = false;
  }
});


export const removeFromLocalCart = $(async (cartState: CartContextState, productVariantId: string) => {
  // Load cart if not already loaded
  await loadCartIfNeeded(cartState);

  try {
    cartState.localCart = SERVER_CART_ENABLED
      ? await ServerCartService.removeItem(productVariantId)
      : LocalCartService.removeItem(productVariantId);
    // Clear validation for removed item
    delete cartState.lastStockValidation[productVariantId];
    cartState.lastError = null;

    // 🚀 OPTIMIZED: Trigger header badge update
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('cart-updated', {
        detail: { totalQuantity: cartState.localCart.totalQuantity }
      }));
    }
  } catch (error) {
    cartState.lastError = error instanceof Error ? error.message : 'Failed to remove item';
  }
});

export const clearLocalCart = $(async (cartState: CartContextState) => {
  try {
    cartState.localCart = SERVER_CART_ENABLED
      ? await ServerCartService.clearCart()
      : LocalCartService.clearCart();
    cartState.lastStockValidation = {};
    cartState.appliedCoupon = null;
    cartState.lastError = null;

    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('cart-updated', {
        detail: { totalQuantity: 0 }
      }));
    }
  } catch (error) {
    cartState.lastError = error instanceof Error ? error.message : 'Failed to clear cart';
  }
});

export const convertLocalCartToVendureOrder = $(async (cartState: CartContextState) => {
  cartState.isLoading = true;
  cartState.lastError = null;

  try {
    // Validate stock before conversion
    const stockValidation = LocalCartService.validateStock();

    if (!stockValidation.valid) {
      cartState.lastError = `Stock validation failed: ${stockValidation.errors.join(', ')}`;
      return null;
    }

    // Extract coupon from cart state
    const appliedCoupon = cartState.appliedCoupon ? { code: cartState.appliedCoupon.code } : null;

    // Pass coupon to conversion method
    const order = await LocalCartService.convertToVendureOrder(appliedCoupon);

    if (order) {
      // Do NOT clear the local cart here; keep it until payment completes.
      // This ensures Sezzle cancellations do not wipe the cart.
      // Cart stays in localStorage — always the single source of truth.
      cartState.lastStockValidation = {};
      // Clear applied coupon after successful conversion
      cartState.appliedCoupon = null;
    } else {
      cartState.lastError = 'Failed to create Vendure order';
    }

    return order;
  } catch (error) {
    cartState.lastError = error instanceof Error ? error.message : 'Checkout failed';
    return null;
  } finally {
    cartState.isLoading = false;
  }
});
