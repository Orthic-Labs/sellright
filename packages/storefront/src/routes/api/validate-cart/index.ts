import type { RequestHandler } from '@qwik.dev/router';
import { getProductBySlug } from '~/providers/shop/products/products';

interface CartValidationItem {
  productVariantId: string;
  quantity: number;
  unitPrice: number;
  productSlug: string;
}

interface CartValidationRequest {
  items: CartValidationItem[];
}

interface ValidationError {
  productVariantId: string;
  type: 'PRICE_MISMATCH' | 'STOCK_INSUFFICIENT' | 'PRODUCT_NOT_FOUND';
  message: string;
  serverPrice?: number;
  clientPrice?: number;
  availableStock?: number;
}

interface CartValidationResponse {
  valid: boolean;
  errors?: ValidationError[];
  totalMismatch?: {
    serverTotal: number;
    clientTotal: number;
  };
}

/**
 * Server-side cart validation endpoint
 * Prevents price manipulation attacks by validating all prices against server data
 */
export const onPost: RequestHandler = async ({ request, json }) => {
  try {
    const requestBody = await request.text();
    const requestData: CartValidationRequest = JSON.parse(requestBody);
    const { items } = requestData;

    if (!items || !Array.isArray(items)) {
      throw json(400, {
        valid: false,
        errors: [{ 
          productVariantId: '', 
          type: 'PRODUCT_NOT_FOUND', 
          message: 'Invalid request format' 
        }]
      });
    }

    const errors: ValidationError[] = [];
    let serverTotal = 0;
    let clientTotal = 0;

    // Validate each cart item
    for (const item of items) {
      try {
        // Get product data from server to verify prices
        const productData = await getProductBySlug(item.productSlug);
        
        if (!productData || !productData.variants) {
          errors.push({
            productVariantId: item.productVariantId,
            type: 'PRODUCT_NOT_FOUND',
            message: `Product not found: ${item.productSlug}`
          });
          continue;
        }

        // Find the specific variant
        const variant = productData.variants.find((v: any) => v.id === item.productVariantId);
        
        if (!variant) {
          errors.push({
            productVariantId: item.productVariantId,
            type: 'PRODUCT_NOT_FOUND',
            message: `Product variant not found: ${item.productVariantId}`
          });
          continue;
        }

        // Check price mismatch (critical security check)
        const serverPrice = variant.priceWithTax;
        if (serverPrice !== item.unitPrice) {
          errors.push({
            productVariantId: item.productVariantId,
            type: 'PRICE_MISMATCH',
            message: `Price has changed. Server: ${serverPrice}, Client: ${item.unitPrice}`,
            serverPrice,
            clientPrice: item.unitPrice
          });
        }

        // Check stock availability
        const stockLevel = parseInt(variant.stockLevel || '0');
        if (stockLevel < item.quantity) {
          errors.push({
            productVariantId: item.productVariantId,
            type: 'STOCK_INSUFFICIENT',
            message: `Insufficient stock. Available: ${stockLevel}, Requested: ${item.quantity}`,
            availableStock: stockLevel
          });
        }

        // Calculate totals for final validation
        serverTotal += serverPrice * item.quantity;
        clientTotal += item.unitPrice * item.quantity;

      } catch (error) {
        console.error(`Error validating item ${item.productVariantId}:`, error);
        errors.push({
          productVariantId: item.productVariantId,
          type: 'PRODUCT_NOT_FOUND',
          message: `Server error validating product`
        });
      }
    }

    // Return validation results
    const response: CartValidationResponse = {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
      totalMismatch: serverTotal !== clientTotal ? {
        serverTotal,
        clientTotal
      } : undefined
    };

    if (!response.valid) {
      // Use 422 for validation errors (not 400 which is malformed request)
      throw json(422, response);
    }

    throw json(200, response);

  } catch (error) {
    console.error('Cart validation error:', error);
    throw json(500, {
      valid: false,
      errors: [{ 
        productVariantId: '', 
        type: 'PRODUCT_NOT_FOUND', 
        message: 'Server error during validation' 
      }]
    });
  }
};

/**
 * GET endpoint for health check
 */
export const onGet: RequestHandler = async ({ json }) => {
  throw json(200, {
    endpoint: 'cart-validation',
    status: 'active',
    timestamp: new Date().toISOString()
  });
};
