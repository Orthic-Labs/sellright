const id = '[a-zA-Z0-9_-]+';
const reads = new RegExp(`^/v1/admin/(me|dashboard|products|variants|collections|inventory|orders|customers|reports|activity|locations|promotions|returns)(/${id})?(/(movements|options))?$`);
// The generic storefront's read-only browse/receipt surface. Deliberately
// excludes /v1/shop/auth/*, /account/*, /stripe-key, /*/payment-intent,
// /*/gateway-payment, /newsletter-signup, /contact, /track — none of those
// are needed for browse -> cart -> checkout -> receipt, and the demo never
// wires customer accounts, real payment providers, email or SMS.
const shopReads = new RegExp(`^/v1/shop/(config|shipping-methods|currencies|catalog/collections|catalog/products(/${id})?(/stock)?|catalog/search|collections/${id}|cart/[a-f0-9-]{36}|orders/${id}|blog(/${id})?)$`);
export function interactiveRequest(method, path) {
  if (['GET', 'HEAD'].includes(method)) {
    if (path.includes('/export')) return false;
    return reads.test(path) || shopReads.test(path);
  }
  if (method === 'POST') return ['/v1/shop/cart', '/v1/shop/cart/estimate', '/v1/shop/checkout', '/v1/admin/promotions', '/v1/admin/products'].includes(path) ||
    new RegExp(`^/v1/admin/products/${id}/variants$`).test(path) ||
    new RegExp(`^/v1/admin/orders/${id}/(refund|fulfill|cancel)$`).test(path);
  if (method === 'PATCH') return /^\/v1\/shop\/cart\/[a-f0-9-]{36}\/lines$/.test(path) ||
    new RegExp(`^/v1/admin/(products|variants|promotions)/${id}(/stock)?$`).test(path);
  return method === 'DELETE' && new RegExp(`^/v1/admin/(promotions|products|variants)/${id}$`).test(path);
}
const only = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(k => keys.includes(k));
const text = (value, max = 160) => value == null || (typeof value === 'string' && value.length <= max && !/[<>]/.test(value));
export function interactiveBody(path, body) {
  if(path==='/v1/shop/cart/estimate')return only(body,['cartToken','shippingMethodCode','couponCode'])&&/^[a-f0-9-]{36}$/.test(body.cartToken)&&['standard','express'].includes(body.shippingMethodCode)&&text(body.couponCode,32);
  if (path === '/v1/admin/products') return only(body,['name','slug','description','status']) && text(body.name) && text(body.slug,100) && text(body.description,2000);
  if (/^\/v1\/admin\/products\/[^/]+\/variants$/.test(path)) return only(body,['sku','name','price','onHand']) && /^DEMO-[A-Z-]+$/.test(body.sku) && text(body.name) && Number.isInteger(body.price) && body.price>=0 && body.price<=100000 && Number.isInteger(body.onHand) && body.onHand>=0 && body.onHand<=1000;
  if (only(body,[]) && /^\/v1\/admin\/(products|variants|promotions)\/[^/]+$/.test(path)) return true;
  if (path.startsWith('/v1/shop/cart')) {
    return only(body, ['items', 'lines', 'expectedRevision', 'couponCode']) && text(body.couponCode, 32) &&
      [body.items, body.lines].every(lines => lines == null || (Array.isArray(lines) && lines.length <= 12 &&
        lines.every(line => only(line, ['sku', 'quantity']) && /^DEMO-[A-Z-]+$/.test(line.sku) && Number.isInteger(line.quantity) && line.quantity >= 0 && line.quantity <= 10)));
  }
  // The generic storefront's real checkout payload (providers/shop/checkout/
  // checkout.ts) carries shipping/email/shippingAddress/billingAddress/
  // giftCardCode/items alongside cartToken — accepting them here is still
  // safe because interactive-server.mjs's checkout handler REPLACES items,
  // email and shippingAddress from the live cart + synthetic identity before
  // the request ever reaches the real app (see settle()/execute() there);
  // nothing accepted in this branch is ever trusted as the source of truth.
  // Every field stays individually bounded so this can't become a blank check.
  if (path === '/v1/shop/checkout') return only(body, ['cartToken', 'expectedRevision', 'shippingMethodCode', 'couponCode', 'shipping', 'email', 'shippingAddress', 'billingAddress', 'giftCardCode', 'items']) &&
    /^[a-f0-9-]{36}$/.test(body.cartToken) && Number.isInteger(body.expectedRevision) && body.expectedRevision>=0 && ['standard', 'express'].includes(body.shippingMethodCode) && text(body.couponCode, 32) &&
    (body.shipping == null || (Number.isInteger(body.shipping) && body.shipping >= 0 && body.shipping <= 100000)) &&
    text(body.email, 254) && text(body.giftCardCode, 32) &&
    (body.shippingAddress == null || (typeof body.shippingAddress === 'object' && !Array.isArray(body.shippingAddress) && JSON.stringify(body.shippingAddress).length <= 1000)) &&
    (body.billingAddress == null || (typeof body.billingAddress === 'object' && !Array.isArray(body.billingAddress) && JSON.stringify(body.billingAddress).length <= 1000)) &&
    (body.items == null || (Array.isArray(body.items) && body.items.length <= 12 &&
      body.items.every(line => only(line, ['sku', 'quantity']) && typeof line.sku === 'string' && line.sku.length <= 64 && Number.isInteger(line.quantity) && line.quantity >= 0 && line.quantity <= 10)));
  if (path.includes('/products/')) return only(body, ['name', 'description', 'status', 'vendor', 'productType', 'tags', 'seoTitle', 'seoDescription', 'metafields', 'featuredAssetId']) &&
    text(body.name) && text(body.description, 2000) && text(body.vendor) && text(body.productType) && text(body.seoTitle) && text(body.seoDescription, 500) &&
    (body.tags == null || (Array.isArray(body.tags) && body.tags.length <= 12 && body.tags.every(t => text(t, 32)))) &&
    (body.status == null || ['active', 'draft'].includes(body.status)) && body.featuredAssetId == null &&
    (body.metafields == null || JSON.stringify(body.metafields).length <= 1000);
  if (path.endsWith('/stock')) return only(body, ['onHand']) && Number.isInteger(body.onHand) && body.onHand >= 0 && body.onHand <= 1000;
  if (path.includes('/variants/')) return only(body, ['price', 'compareAtPrice', 'salePrice', 'preOrderPrice', 'isPreOrder', 'shipDate', 'archived', 'enabled', 'name', 'sku', 'fulfillmentType', 'weightG']) &&
    ['price', 'compareAtPrice', 'salePrice', 'preOrderPrice', 'weightG'].every(k => body[k] == null || (Number.isInteger(body[k]) && body[k] >= 0 && body[k] <= 100000)) &&
    text(body.name) && (body.sku == null || /^DEMO-[A-Z-]+$/.test(body.sku)) &&
    (body.fulfillmentType == null || body.fulfillmentType === 'physical');
  if (path.includes('/promotions')) return only(body, ['code', 'type', 'value', 'conditions', 'startsAt', 'endsAt', 'usageLimit', 'perCustomerUsageLimit', 'priority', 'exclusionGroup', 'enabled']) &&
    text(body.code, 32) && (body.value == null || (Number.isInteger(body.value) && body.value >= 0 && body.value <= 10000)) &&
    (body.conditions == null || JSON.stringify(body.conditions).length <= 1000);
  if (path.endsWith('/refund')) return only(body, ['amount', 'restock', 'idempotencyKey', 'reason']) &&
    (body.amount == null || (Number.isInteger(body.amount) && body.amount > 0)) && text(body.reason, 500) && text(body.idempotencyKey, 100);
  if (path.endsWith('/fulfill')) return only(body, ['state', 'trackingCode', 'carrier', 'lines']) &&
    ['Shipped', 'Delivered'].includes(body.state) && text(body.trackingCode) && text(body.carrier) &&
    (body.lines == null || (Array.isArray(body.lines) && body.lines.length <= 12));
  return path.endsWith('/cancel') && only(body, []);
}

// The public demo's ONLY credential. Accepted exclusively by the demo
// wrapper (interactive-server.mjs intercepts /v1/admin/login before it ever
// reaches the real app) — the real sellright-api /v1/admin/login requires a
// z.string().email() body and an argon2/bcrypt verifyPassword() match against
// admin_user.password_hash, so a literal "admin"/"admin" pair is rejected by
// schema validation alone, independent of this function ever running there.
export function demoAdminCredentials(body) {
  return !!(only(body, ['email', 'password']) &&
    typeof body.email === 'string' && typeof body.password === 'string' &&
    body.email.trim().toLowerCase() === 'admin' && body.password === 'admin');
}

export function sameOriginMutation(headers, host) {
  if (!headers.origin) return false;
  try { const origin=new URL(headers.origin);return ['http:','https:'].includes(origin.protocol)&&origin.host === host && !['cross-site', 'none'].includes(headers['sec-fetch-site']); }
  catch { return false; }
}

// Host header allowlist for the demo's own HTTP entry point. `bindHost` is
// whatever this process is actually bound to (127.0.0.1 in the simplest
// deployment, or the private nginx bridge IP when that's the listener) —
// legitimate self-calls, e.g. the storefront's own SSR fetches, arrive with
// a Host header matching THAT literal address, since Node's fetch derives
// Host from the URL it dialed. Real public traffic always arrives as
// demo.sellright.cc (nginx sets that Host explicitly regardless of which
// address it dialed), so admitting bindHost here never widens what the
// public internet can reach — the bridge address isn't internet-routable.
export function allowedDemoHost(hostname, bindHost) {
  return ['localhost', '127.0.0.1', 'demo.sellright.cc', bindHost].includes(hostname);
}

// Which upstream a non-/v1/, non-/demo/ request goes to. The generic Qwik
// storefront (packages/storefront) is root-mounted and owns everything that
// isn't explicitly claimed below — /, /shop, /collections/*, /products/*,
// /cart, /checkout*, /account*, /blog*, /search, its static build assets,
// all of it. The admin SPA moves to /admin instead: its own hardcoded
// top-level routes (/login, /orders, /products, /collections, /blog, ...)
// would otherwise collide with the storefront's identically-named public
// routes, and unlike the storefront's scattered hardcoded hrefs, React
// Router's `basename` (packages/admin/src/main.tsx) relocates the ENTIRE
// admin app cleanly with no per-link fixes needed.
export function demoRouteTarget(pathname) {
  if (pathname === '/admin' || pathname.startsWith('/admin/')) return 'admin';
  if (pathname === '/demo-admin.js') return 'demo-asset';
  return 'storefront';
}
