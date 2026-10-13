// Brand views PR2 §9: the one storefront builder of product URLs. routes.json `productPath` picks `/products/:slug/` (default) or
// `/shop/:slug/`; every product link the storefront renders comes from here (a grep test keeps it that way).
import { BRAND_ROUTES } from '~/platform/brand-data';
import { siteUrl } from '~/theme/theme.config';

export type ProductPathSetting = '/products/:slug/' | '/shop/:slug/';

export const PRODUCT_PATH_SETTING: ProductPathSetting = BRAND_ROUTES?.productPath === '/shop/:slug/' ? '/shop/:slug/' : '/products/:slug/';

/** The first path segment product pages live under: `products` or `shop`. */
export const PRODUCT_PREFIX: 'products' | 'shop' = PRODUCT_PATH_SETTING === '/shop/:slug/' ? 'shop' : 'products';

/** Path of one product page, with a trailing slash. */
export const productPathFor = (setting: ProductPathSetting, slug: string): string => `/${setting === '/shop/:slug/' ? 'shop' : 'products'}/${encodeURIComponent(slug)}/`;

export const productPath = (slug: string): string => productPathFor(PRODUCT_PATH_SETTING, slug);

/** Absolute URL of one product page on the storefront's own origin. */
export const productUrl = (slug: string): string => `${siteUrl}${productPath(slug)}`;
