import type { Order } from '~/generated/graphql-shop';
import { convertLocalCartToVendureOrder } from './local-cart-conversion';
import {
  isStockCheckNeeded as isCartStockCheckNeeded,
  refreshAllStockLevels as refreshLocalCartStockLevels,
  refreshAllStockLevelsLocal as refreshLocalCartStockLevelsLocal,
  validateStock as validateLocalCartStock,
  validateStockLevel as validateLocalCartStockLevel,
} from './local-cart-stock';
import type { LocalCart, LocalCartItem, StockValidationResult, ValidationErrors } from './local-cart-types';

export type { LocalCart, LocalCartItem, StockValidationResult, ValidationErrors } from './local-cart-types';

// LocalCart Service
export class LocalCartService {
  private static readonly CART_KEY = 'vendure_local_cart';
  private static readonly STOCK_CACHE_DURATION = 0; // No stock caching - always fresh for e-commerce

  private static cartCache: LocalCart | null = null;
  private static cacheTimestamp: number = 0;
  private static readonly CACHE_DURATION = 1000; // 1 second cache

  private static cartUpdateCallbacks: Set<() => void> = new Set();
  private static isStorageListenerSetup = false;

  static setupCrossTabSync(): void {
    if (typeof window === 'undefined' || this.isStorageListenerSetup) return;

    window.addEventListener('storage', (event) => {
      if (event.key === this.CART_KEY) {
        this.clearCache();
        this.cartUpdateCallbacks.forEach(callback => {
          try {
            callback();
          } catch (error) {
            console.error('Error in cart update callback:', error);
          }
        });
      }
    });

    this.isStorageListenerSetup = true;
  }

  static onCartUpdate(callback: () => void): () => void {
    this.cartUpdateCallbacks.add(callback);
    return () => {
      this.cartUpdateCallbacks.delete(callback);
    };
  }

  private static triggerCartUpdate(): void {
    this.cartUpdateCallbacks.forEach(callback => {
      try {
        callback();
      } catch (error) {
        console.error('Error in cart update callback:', error);
      }
    });
  }

  static getCartQuantityFromStorage(): number {
    if (typeof window === 'undefined') return 0;

    try {
      const stored = localStorage.getItem(this.CART_KEY);
      if (stored) {
        const cart = JSON.parse(stored);
        return cart.totalQuantity || 0;
      }
    } catch (error) {
      console.error('Failed to read cart quantity from localStorage:', error);
    }

    return 0;
  }

  static getItemQuantityFromStorage(productVariantId: string): number {
    if (typeof window === 'undefined') return 0;

    try {
      const stored = localStorage.getItem(this.CART_KEY);
      if (stored) {
        const cart = JSON.parse(stored);
        const item = cart.items?.find((item: LocalCartItem) => item.productVariantId === productVariantId);
        return item?.quantity || 0;
      }
    } catch (error) {
      console.error('Failed to read item quantity from localStorage:', error);
    }

    return 0;
  }

  static getItemQuantitiesFromStorage(productVariantIds: string[]): Record<string, number> {
    if (typeof window === 'undefined') return {};

    try {
      const stored = localStorage.getItem(this.CART_KEY);
      if (stored) {
        const cart = JSON.parse(stored);
        const result: Record<string, number> = {};

        productVariantIds.forEach(variantId => {
          const item = cart.items?.find((item: LocalCartItem) => item.productVariantId === variantId);
          result[variantId] = item?.quantity || 0;
        });

        return result;
      }
    } catch (error) {
      console.error('Failed to read item quantities from localStorage:', error);
    }

    // Return empty quantities for all variants
    const result: Record<string, number> = {};
    productVariantIds.forEach(variantId => {
      result[variantId] = 0;
    });
    return result;
  }

  private static clearCache(): void {
    this.cartCache = null;
    this.cacheTimestamp = 0;
  }

  // Generate a hash of cart contents for deduplication


  // Get cart from localStorage with in-memory caching
  static getCart(): LocalCart {
    if (typeof window === 'undefined') {
      return {
        items: [],
        totalQuantity: 0,
        subTotal: 0,
        currencyCode: 'USD',
        countryCode: 'US',
        countryExplicitlySet: false,
      };
    }

    const now = Date.now();
    if (this.cartCache && (now - this.cacheTimestamp) < this.CACHE_DURATION) {
      return this.cartCache;
    }

    try {
      const stored = localStorage.getItem(this.CART_KEY);
      if (stored) {
        const cart = JSON.parse(stored);
        this.cartCache = cart;
        this.cacheTimestamp = now;
        return cart;
      }
    } catch (error) {
      console.error('Failed to parse cart from localStorage:', error);
    }

    const emptyCart = {
      items: [],
      totalQuantity: 0,
      subTotal: 0,
      currencyCode: 'USD',
      countryCode: 'US',
      countryExplicitlySet: false,
    };

    this.cartCache = emptyCart;
    this.cacheTimestamp = now;
    return emptyCart;
  }

  // Save cart to localStorage and update cache
  static saveCart(cart: LocalCart): void {
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem(this.CART_KEY, JSON.stringify(cart));
        this.cartCache = cart;
        this.cacheTimestamp = Date.now();
        this.triggerCartUpdate();
      } catch (error) {
        console.error('Failed to save cart to localStorage:', error);
        this.clearCache(); // Clear cache on error
      }
    }
  }

  static getCountry(): string {
    const cart = this.getCart();
    return cart.countryCode || 'US';
  }

  static setCountry(code: string): void {
    const normalizedCode = (code || 'US').toUpperCase();
    const cart = this.getCart();
    cart.countryCode = normalizedCode;
    cart.countryExplicitlySet = true;
    this.saveCart(cart);
  }

  static setCountryFromGeolocation(code: string): void {
    const normalizedCode = (code || 'US').toUpperCase();
    const cart = this.getCart();
    cart.countryCode = normalizedCode;
    if (typeof cart.countryExplicitlySet !== 'boolean') {
      cart.countryExplicitlySet = false;
    }
    this.saveCart(cart);
  }

  static hasExplicitCountrySelection(): boolean {
    const cart = this.getCart();
    return !!cart.countryExplicitlySet;
  }

  // Validate stock level for a product variant using stored data
  static validateStockLevel(item: LocalCartItem, requestedQuantity: number): StockValidationResult {
    return validateLocalCartStockLevel(item, requestedQuantity);
  }

  // Add item to cart with stock validation - FAIL FAST on stock errors
  // Stock level comes from PDP (routeLoader$ + 5-min refresh) — already fresh, no extra fetch needed
  static addItem(item: LocalCartItem): { cart: LocalCart; stockResult: StockValidationResult } {
    const cart = this.getCart();
    const existingIndex = cart.items.findIndex(i => i.productVariantId === item.productVariantId);

    const newQuantity = existingIndex >= 0
      ? cart.items[existingIndex].quantity + item.quantity
      : item.quantity;

    // Validate stock before adding
    const stockResult = this.validateStockLevel(item, newQuantity);
    
    // 🚫 FAIL FAST: Don't add/update if stock validation fails
    if (!stockResult.success) {
      return { cart, stockResult };
    }
    
    if (existingIndex >= 0) {
      // Update existing item with requested quantity (no silent adjustments)
      cart.items[existingIndex].quantity = newQuantity;
      cart.items[existingIndex].lastStockCheck = Date.now();
      // Update stock level info
      cart.items[existingIndex].productVariant.stockLevel = stockResult.availableStock.toString();
    } else {
      // Add new item with requested quantity (no silent adjustments)
      item.quantity = newQuantity;
      item.lastStockCheck = Date.now();
      item.productVariant.stockLevel = stockResult.availableStock.toString();
      cart.items.push(item);
    }
    
    this.recalculateTotals(cart);
    this.saveCart(cart);
    return { cart, stockResult };
  }

  // Update item quantity with stock validation - FAIL FAST on stock errors
  static async updateItemQuantity(productVariantId: string, quantity: number): Promise<{ cart: LocalCart; stockResult: StockValidationResult }> {
    const cart = this.getCart();
    const itemIndex = cart.items.findIndex(item => item.productVariantId === productVariantId);

    if (itemIndex === -1) {
      // Item not found, return current cart
      return {
        cart,
        stockResult: { success: true, availableStock: 0 }
      };
    }

    // Fetch fresh stock before validating
    try {
      const { getProductStockLevelsOnly } = await import('~/providers/shop/products/products');
      const freshStock = await getProductStockLevelsOnly(cart.items[itemIndex].productVariant.product.slug);
      if (freshStock?.product?.variants) {
        const freshVariant = freshStock.product.variants.find((v: any) => v.id === cart.items[itemIndex].productVariant.id);
        if (freshVariant) {
          cart.items[itemIndex].productVariant.stockLevel = freshVariant.stockLevel;
        }
      }
    } catch (e) {
      console.warn('[LocalCartService] Fresh stock query failed, using cached:', e);
    }

    // Validate stock before updating
    const stockResult = this.validateStockLevel(cart.items[itemIndex], quantity);
    
    // 🚫 FAIL FAST: Don't update if stock validation fails
    if (!stockResult.success) {
      return { cart, stockResult };
    }
    
    // Update with requested quantity (no silent adjustments)
    cart.items[itemIndex].quantity = quantity;
    cart.items[itemIndex].lastStockCheck = Date.now();
    cart.items[itemIndex].productVariant.stockLevel = stockResult.availableStock.toString();
    
    this.recalculateTotals(cart);
    this.saveCart(cart);
    return { cart, stockResult };
  }

  // Remove item from cart
  static removeItem(productVariantId: string): LocalCart {
    const cart = this.getCart();
    cart.items = cart.items.filter(item => item.productVariantId !== productVariantId);
    this.recalculateTotals(cart);
    this.saveCart(cart);
    return cart;
  }

  // Check if stock validation is needed (based on cache time)
  static isStockCheckNeeded(item: LocalCartItem): boolean {
    return isCartStockCheckNeeded(item, this.STOCK_CACHE_DURATION);
  }

  static async refreshAllStockLevels(): Promise<LocalCart> {
    return refreshLocalCartStockLevels(this.getCart(), {
      recalculateTotals: (cart) => this.recalculateTotals(cart),
      saveCart: (cart) => this.saveCart(cart),
    });
  }

  // Fallback: Refresh stock levels using cached data (old method)
  static refreshAllStockLevelsLocal(): LocalCart {
    return refreshLocalCartStockLevelsLocal(this.getCart(), this.STOCK_CACHE_DURATION, {
      recalculateTotals: (cart) => this.recalculateTotals(cart),
      saveCart: (cart) => this.saveCart(cart),
    });
  }

  // Validate all cart items for checkout
  static validateStock(): ValidationErrors {
    return validateLocalCartStock(this.getCart());
  }

  // Clear cart
  static clearCart(): LocalCart {
    const currentCart = this.getCart();
    const emptyCart: LocalCart = {
      items: [],
      totalQuantity: 0,
      subTotal: 0,
      currencyCode: 'USD',
      countryCode: currentCart.countryCode || 'US',
      countryExplicitlySet: !!currentCart.countryExplicitlySet,
    };
    this.saveCart(emptyCart);
    return emptyCart;
  }

  // Clear cart after successful payment (alias for clearCart)
  static clearCartAfterSuccessfulPayment(): LocalCart {
    return this.clearCart();
  }

  // Recalculate cart totals (respects sale / pre-order price; CF values stored as dollars, native price in cents)
  static recalculateTotals(cart: LocalCart): void {
    cart.totalQuantity = cart.items.reduce((total, item) => total + item.quantity, 0);
    cart.subTotal = cart.items.reduce((total, item) => {
      return total + (LocalCartService.lineUnitPrice(item) * item.quantity);
    }, 0);
  }

  // Effective unit price (cents) for a local cart item — applies sale/pre-order if set
  static lineUnitPrice(item: LocalCartItem): number {
    const regular = item.productVariant.price; // cents
    if (item.isPreOrder) {
      const pre = typeof item.preOrderPrice === 'number' && item.preOrderPrice > 0 ? item.preOrderPrice : null;
      return pre ?? regular;
    }
    const sale = typeof item.salePrice === 'number' && item.salePrice > 0 ? item.salePrice : null;
    return sale ?? regular;
  }

  // Convert local cart to Vendure order
  static async convertToVendureOrder(appliedCoupon?: { code: string } | null): Promise<Order | null> {
    return convertLocalCartToVendureOrder({
      appliedCoupon,
      getCart: () => this.getCart(),
      validateStock: () => this.validateStock(),
    });
  }
}
