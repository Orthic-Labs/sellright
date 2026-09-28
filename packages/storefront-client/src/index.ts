export { createStorefrontClient, request, withTimeout } from './client.js';
export type { StorefrontClient, StorefrontClientOptions, StorefrontApiPaths } from './client.js';

export { ApiError, NetworkError, unknownApiError } from './errors.js';
export type { ApiErrorBody, ApiErrorFields } from './errors.js';

// sellright() / SellRightError / idempotency() — framework-agnostic
// equivalent of the sf-native branch's storefront-embedded prototype (see
// compat.ts's doc comment). A storefront adopts these via one adapter file
// calling configureSellRightClient(); every other call site is unchanged.
export { SellRightError, configureSellRightClient, idempotency, sellright } from './compat.js';
export type { SellRightClientConfig } from './compat.js';

export type {
  Address,
  ApiErrorCode,
  AuthResult,
  BlogPost,
  BlogPostList,
  Cart,
  CartEstimate,
  CartLine,
  CheckoutResult,
  Collection,
  CollectionList,
  Customer,
  GatewayAttempt,
  GatewayVerifyResult,
  LoyaltyBalance,
  Order,
  OrderSummary,
  Product,
  ProductSearchResult,
  ProductStock,
  ShopConfig,
  StoreIdentity,
  SuccessBody,
  Variant,
} from './types.js';

export type {
  NativeCatalogManifestV2,
  NativeImage,
  NativeMoney,
  NativeProductDetailV2,
  NativeProductManifestEntryV2,
  NativeVariantV2,
} from './manifest.js';

export type { paths, components } from './generated/schema.js';
