const id = '[a-zA-Z0-9_-]+';
const reads = new RegExp(`^/v1/admin/(me|dashboard|products|variants|collections|inventory|orders|customers|reports|activity|locations|promotions|returns)(/${id})?(/(movements|options))?$`);
export function interactiveRequest(method, path) {
  if (['GET', 'HEAD'].includes(method)) {
    if (path.includes('/export')) return false;
    return reads.test(path) || /^\/v1\/shop\/(config|shipping-methods|catalog\/(products|collections)(\/[a-zA-Z0-9_-]+)?|cart\/[a-f0-9-]{36})$/.test(path);
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
    return only(body, ['items', 'lines', 'expectedRevision']) &&
      [body.items, body.lines].every(lines => lines == null || (Array.isArray(lines) && lines.length <= 12 &&
        lines.every(line => only(line, ['sku', 'quantity']) && /^DEMO-[A-Z-]+$/.test(line.sku) && Number.isInteger(line.quantity) && line.quantity >= 0 && line.quantity <= 10)));
  }
  if (path === '/v1/shop/checkout') return only(body, ['cartToken', 'expectedRevision', 'shippingMethodCode', 'couponCode']) &&
    /^[a-f0-9-]{36}$/.test(body.cartToken) && Number.isInteger(body.expectedRevision) && body.expectedRevision>=0 && ['standard', 'express'].includes(body.shippingMethodCode) && text(body.couponCode, 32);
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
