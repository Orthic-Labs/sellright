// The storefront's commerce flow, a build constant (VITE_SR_COMMERCE_FLOW, brand.json publicConfig): `cart` (default, the
// physical-goods storefront) or `license` (the license buy-flow: pricing, one-SKU checkout with legal acceptance, account
// licenses). Pure: vite.config.ts imports it (Node) and builds the license flow from src/platform/license/routes instead of src/routes.
export type CommerceFlow = 'cart' | 'license';

export const commerceFlowFrom = (value: string | undefined): CommerceFlow => (value === 'license' ? 'license' : 'cart');

/** The routes directory of a flow, relative to the package root. */
export const routesDirFor = (flow: CommerceFlow): string => (flow === 'license' ? 'src/platform/license/routes' : 'src/routes');
