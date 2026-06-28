import { getProductStockLevelsOnly } from '~/providers/shop/products/products';
import type { LocalCart, LocalCartItem, StockValidationResult, ValidationErrors } from './local-cart-types';

type CartMutators = {
  recalculateTotals: (cart: LocalCart) => void;
  saveCart: (cart: LocalCart) => void;
};

export function validateStockLevel(item: LocalCartItem, requestedQuantity: number): StockValidationResult {
  try {
    const rawStock = item.productVariant.stockLevel || '0';
    const availableStock = rawStock === 'IN_STOCK' ? 999 : parseInt(rawStock);

    if (requestedQuantity <= availableStock) {
      return { success: true, availableStock };
    }
    return {
      success: false,
      availableStock,
      adjustedQuantity: Math.max(0, availableStock),
      error: `Only ${availableStock} items available`
    };
  } catch (error) {
    console.error('Stock validation failed:', error);
    return {
      success: false,
      availableStock: 0,
      adjustedQuantity: 0,
      error: 'Stock validation failed'
    };
  }
}

export function isStockCheckNeeded(item: LocalCartItem, stockCacheDuration: number): boolean {
  if (!item.lastStockCheck) return true;
  return Date.now() - item.lastStockCheck > stockCacheDuration;
}

export async function refreshAllStockLevels(cart: LocalCart, mutators: CartMutators): Promise<LocalCart> {
  if (!cart.items.length) return cart;

  try {
    const productSlugs = [...new Set(cart.items.map(item => item.productVariant.product.slug))];
    console.log(`Refreshing stock for ${productSlugs.length} unique products using lightweight stock queries`);

    const stockResults = await Promise.all(
      productSlugs.map(async (slug) => {
        try {
          const stockData = await getProductStockLevelsOnly(slug);
          return { slug, data: stockData?.product, error: null };
        } catch (error) {
          console.error('Failed to fetch stock levels for:', slug, error);
          return { slug, data: null, error };
        }
      })
    );

    let updatedItemCount = 0;
    cart.items.forEach((item) => {
      const stockResult = stockResults.find(result => result.slug === item.productVariant.product.slug);
      if (stockResult?.data?.variants) {
        const variant = stockResult.data.variants.find((v: { id: string; stockLevel?: string }) => v.id === item.productVariantId);
        if (variant) {
          const freshStockLevel = parseInt(variant.stockLevel || '0');
          item.productVariant.stockLevel = freshStockLevel.toString();
          item.lastStockCheck = Date.now();
          updatedItemCount++;
        } else {
          item.productVariant.stockLevel = '0';
          item.lastStockCheck = Date.now();
        }
      } else if (stockResult?.error) {
        item.productVariant.stockLevel = '0';
        item.lastStockCheck = Date.now();
      }
    });

    console.log(`Stock refreshed for ${updatedItemCount}/${cart.items.length} cart items using lightweight queries`);
    mutators.recalculateTotals(cart);
    mutators.saveCart(cart);
    return cart;
  } catch (error) {
    console.error('LocalCartService: Failed to refresh stock levels:', error);
    throw error;
  }
}

export function refreshAllStockLevelsLocal(cart: LocalCart, stockCacheDuration: number, mutators: CartMutators): LocalCart {
  cart.items.forEach((item) => {
    if (isStockCheckNeeded(item, stockCacheDuration)) {
      const stockResult = validateStockLevel(item, item.quantity);
      item.productVariant.stockLevel = stockResult.availableStock.toString();
      item.lastStockCheck = Date.now();
    }
  });

  mutators.recalculateTotals(cart);
  mutators.saveCart(cart);
  return cart;
}

export function validateStock(cart: LocalCart): ValidationErrors {
  const errors: string[] = [];

  for (const item of cart.items) {
    const stockLevel = parseInt(item.productVariant.stockLevel || '0');
    if (stockLevel <= 0) {
      errors.push(`${item.productVariant.name}: Out of stock. Please remove from cart.`);
    } else if (item.quantity > stockLevel) {
      errors.push(`${item.productVariant.name}: Only ${stockLevel} available (you have ${item.quantity})`);
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}
