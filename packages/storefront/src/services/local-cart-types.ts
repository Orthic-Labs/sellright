export interface LocalCartItem {
  productVariantId: string;
  quantity: number;
  isPreOrder?: boolean;
  shipDate?: string;
  salePrice?: number;
  preOrderPrice?: number;
  lastStockCheck?: number;
  productVariant: {
    id: string;
    name: string;
    price: number;
    stockLevel?: string;
    product: {
      id: string;
      name: string;
      slug: string;
    };
    options: {
      id: string;
      name: string;
      group: {
        name: string;
      };
    }[];
    featuredAsset?: {
      id: string;
      preview: string;
    } | null;
  };
}

export interface LocalCart {
  items: LocalCartItem[];
  totalQuantity: number;
  subTotal: number;
  currencyCode: string;
  countryCode?: string;
  countryExplicitlySet?: boolean;
  appliedCoupon?: {
    code: string;
    discountAmount: number;
    discountPercentage?: number;
    freeShipping: boolean;
    promotionName?: string;
    promotionDescription?: string;
  } | null;
}

export interface StockValidationResult {
  success: boolean;
  availableStock: number;
  adjustedQuantity?: number;
  error?: string;
}

export interface ValidationErrors {
  valid: boolean;
  errors: string[];
}
