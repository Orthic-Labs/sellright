const id = '[a-zA-Z0-9_-]+';
const uuid = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const reads = new RegExp(`^/v1/admin/(me|dashboard|products|variants|collections|inventory|orders|customers|reports|activity|locations|promotions|returns)(/${id})?(/(movements|options))?$`);
// The generic storefront's read-only browse/receipt surface. Deliberately
// excludes /v1/shop/auth/*, /account/*, /stripe-key, /*/payment-intent,
// /*/gateway-payment, /newsletter-signup, /contact, /track — none of those
// are needed for browse -> cart -> checkout -> receipt, and the demo never
// wires customer accounts, real payment providers, email or SMS. The public
// per-product reviews READ (GET .../reviews) is allowed so the PDP reviews
// block renders; submitting a review (POST) stays denied — the demo has no
// customer accounts to sign in with.
// Owner features the admin SPA renders on top of core commerce: points
// (summary/settings/per-customer balance), review moderation queue+settings,
// order-edit context + variant picker, waitlist demand report (+CSV), SEO
// config/sitemap PREVIEW, blog list/detail. All reads, all store-scoped.
const featureReads = new RegExp(`^/v1/admin/(loyalty/(settings|summary)|customers/${id}/loyalty|reviews|reviews-settings|orders/${id}/edit/(context|variants)|waitlist/report(\\.csv)?|seo/(config|sitemaps)|blog|blog/${id})$`);
// Order export dialog: column catalog + the CSV and XLSX downloads. Exact
// paths only — every other path containing /export stays denied.
const exportReads = /^\/v1\/admin\/export\/orders(\.xlsx|\/columns)?$/;
const shopReads = new RegExp(`^/v1/shop/(config|shipping-methods|currencies|catalog/collections|catalog/products(/${id})?(/stock|/reviews)?|catalog/search|collections/${id}|cart/[a-f0-9-]{36}|orders/${id}|blog(/${id})?)$`);
export function interactiveRequest(method, path) {
  // Explicit, defense-in-depth: installation-admin/system routes (recovery
  // kit — the master key — checklist, publish, off-site-backup confirmation)
  // must NEVER be reachable through the publicly-known admin/admin demo
  // credentials, no matter how `reads`/the POST/PATCH/DELETE lists below are
  // ever edited later. This isn't just "not in the allowlist" (true anyway —
  // 'system' was never one of `reads`'s alternatives) — it's a standalone
  // check that can't be silently widened by a future regex edit to `reads`.
  if (/^\/v1\/admin\/system(\/|$)/.test(path) || path === '/v1/admin/step-up') return false;
  if (['GET', 'HEAD'].includes(method)) {
    if (exportReads.test(path)) return true;
    if (path.includes('/export')) return false;
    return reads.test(path) || featureReads.test(path) || shopReads.test(path);
  }
  if (method === 'POST') return ['/v1/shop/cart', '/v1/shop/cart/estimate', '/v1/shop/checkout', '/v1/admin/promotions', '/v1/admin/products'].includes(path) ||
    new RegExp(`^/v1/admin/products/${id}/variants$`).test(path) ||
    new RegExp(`^/v1/admin/orders/${id}/(refund|fulfill|cancel)$`).test(path) ||
    // Owner features. NOT allowed here: /v1/admin/reviews/{id} DELETE, loyalty
    // adjust/reverse, SEO config PATCH / indexnow submit / sitemaps refresh.
    path === '/v1/admin/blog' ||
    new RegExp(`^/v1/admin/reviews/${uuid}/(approve|reject)$`).test(path) ||
    new RegExp(`^/v1/admin/orders/${id}/edit/(preview|commit)$`).test(path);
  if (method === 'PUT') return path === '/v1/admin/loyalty/settings' || path === '/v1/admin/reviews-settings' ||
    new RegExp(`^/v1/admin/reviews/${uuid}/reply$`).test(path) ||
    new RegExp(`^/v1/admin/orders/${id}/address$`).test(path);
  if (method === 'PATCH') return /^\/v1\/shop\/cart\/[a-f0-9-]{36}\/lines$/.test(path) ||
    new RegExp(`^/v1/admin/(products|variants|promotions)/${id}(/stock)?$`).test(path) ||
    new RegExp(`^/v1/admin/blog/${uuid}$`).test(path);
  return method === 'DELETE' && (new RegExp(`^/v1/admin/(promotions|products|variants)/${id}$`).test(path) || new RegExp(`^/v1/admin/blog/${uuid}$`).test(path));
}
const only = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(k => keys.includes(k));
const text = (value, max = 160) => value == null || (typeof value === 'string' && value.length <= max && !/[<>]/.test(value));

const isUuid = v => typeof v === 'string' && new RegExp(`^${uuid}$`).test(v);
const int = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const optInt = (v, min, max) => v == null || int(v, min, max);
const optBool = v => v == null || typeof v === 'boolean';
const nonEmpty = (v, max) => typeof v === 'string' && v.trim().length > 0 && text(v, max);
const iso = v => v == null || (typeof v === 'string' && v.length <= 40 && /^\d{4}-\d\d-\d\dT[\d:.]+(Z|[+-]\d\d:\d\d)$/.test(v) && !Number.isNaN(Date.parse(v)));
// Owner-feature bodies (points, reviews, order edit, blog). Each is bounded the
// same way as the commerce bodies above and rejects anything with an outbound
// side effect: settlement refund_now (gateway refund) and send_pay_link (pay
// link email) are not in the allowed set, so they fail validation here.
const settingsBody = b => only(b, ['enabled', 'earnRatePerDollar', 'pointsPerDollarOff', 'minRedeemPoints', 'maxRedeemPercentOfSubtotal', 'expiryDays', 'reviewBonusPoints', 'reviewBonusVerifiedOnly', 'signupBonusPoints', 'signupBonusSince', 'firstOrderBonusPoints', 'birthdayBonusPoints', 'productMultipliers']) &&
  typeof b.enabled === 'boolean' && optBool(b.reviewBonusVerifiedOnly) &&
  optInt(b.earnRatePerDollar, 0, 100) && optInt(b.pointsPerDollarOff, 1, 10000) && optInt(b.minRedeemPoints, 0, 1000000) &&
  optInt(b.maxRedeemPercentOfSubtotal, 1, 100) && optInt(b.expiryDays, 1, 3650) &&
  ['reviewBonusPoints', 'signupBonusPoints', 'firstOrderBonusPoints', 'birthdayBonusPoints'].every(k => optInt(b[k], 0, 10000)) &&
  iso(b.signupBonusSince) &&
  (b.productMultipliers == null || (Array.isArray(b.productMultipliers) && b.productMultipliers.length <= 20 &&
    b.productMultipliers.every(m => only(m, ['productId', 'multiplier']) && isUuid(m.productId) && typeof m.multiplier === 'number' && m.multiplier >= 1 && m.multiplier <= 100)));
const addressBody = a => only(a, ['fullName', 'line1', 'line2', 'city', 'province', 'postalCode', 'country', 'phone']) &&
  nonEmpty(a.line1, 200) && nonEmpty(a.city, 120) && typeof a.country === 'string' && /^[A-Za-z]{2}$/.test(a.country) &&
  text(a.fullName, 200) && text(a.line2, 200) && text(a.province, 120) && text(a.postalCode, 40) && text(a.phone, 60);
const sku = v => typeof v === 'string' && /^DEMO-[A-Z-]+$/.test(v);
const editOp = o => {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
  switch (o.op) {
    case 'set_quantity': return only(o, ['op', 'lineId', 'quantity']) && isUuid(o.lineId) && int(o.quantity, 0, 1000);
    case 'remove_line': return only(o, ['op', 'lineId']) && isUuid(o.lineId);
    case 'swap_variant': return only(o, ['op', 'lineId', 'sku', 'quantity']) && isUuid(o.lineId) && sku(o.sku) && optInt(o.quantity, 1, 1000);
    case 'add_item': return only(o, ['op', 'sku', 'quantity', 'unitPrice']) && sku(o.sku) && int(o.quantity, 1, 1000) && optInt(o.unitPrice, 0, 100000);
    case 'apply_coupon': return only(o, ['op', 'code']) && nonEmpty(o.code, 32);
    case 'remove_coupon': case 'remove_shipping': return only(o, ['op']);
    case 'set_shipping_method': return only(o, ['op', 'code']) && nonEmpty(o.code, 32);
    case 'set_shipping_amount': return only(o, ['op', 'amount']) && int(o.amount, 0, 100000);
    case 'add_adjustment': return only(o, ['op', 'label', 'amount']) && nonEmpty(o.label, 120) && int(o.amount, -100000, 100000) && o.amount !== 0;
    case 'remove_adjustment': return only(o, ['op', 'adjustmentId']) && isUuid(o.adjustmentId);
    case 'set_address': return only(o, ['op', 'kind', 'address', 'saveToAddressBook']) && ['shipping', 'billing'].includes(o.kind) && addressBody(o.address) && optBool(o.saveToAddressBook);
    default: return false;
  }
};
const opList = (ops, min) => Array.isArray(ops) && ops.length >= min && ops.length <= 30 && ops.every(editOp);
// Only settlements with no gateway call and no email: leave the balance due,
// leave it as store credit, or record an off-platform (manual) payment.
const settlement = s => s == null || (s && typeof s === 'object' && !Array.isArray(s) && (
  (['leave_due', 'leave_credit'].includes(s.type) && only(s, ['type'])) ||
  (s.type === 'record_payment' && only(s, ['type', 'method', 'reference', 'amount']) && ['cash', 'zelle', 'check', 'card_phone', 'other'].includes(s.method) && text(s.reference, 200) && optInt(s.amount, 1, 10000000))));
const blogBody = (b, patch) => only(b, ['title', 'slug', 'excerpt', 'body', 'authorName', 'tags', 'isPublished', 'publishDate', 'seoTitle', 'seoDescription', 'featuredAssetId', ...(patch ? ['id', 'expectedRevision'] : [])]) &&
  (patch ? (b.title == null || nonEmpty(b.title, 200)) : nonEmpty(b.title, 200)) &&
  (b.slug == null || (typeof b.slug === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(b.slug))) &&
  text(b.excerpt, 500) && text(b.authorName, 100) && text(b.seoTitle, 200) && text(b.seoDescription, 500) &&
  // The body is editor HTML, so < and > are legitimate; the API sanitises it
  // on save (sanitizeBlogHtml). Bounded well under the 12 KB request cap.
  (b.body == null || (typeof b.body === 'string' && b.body.length <= 8000)) &&
  (b.tags == null || (Array.isArray(b.tags) && b.tags.length <= 10 && b.tags.every(t => text(t, 32)))) &&
  optBool(b.isPublished) && iso(b.publishDate) && b.featuredAssetId == null &&
  (b.id == null || isUuid(b.id)) && (b.expectedRevision == null || (typeof b.expectedRevision === 'string' && /^[a-f0-9]{64}$/.test(b.expectedRevision)));
export function interactiveBody(path, body) {
  if (path === '/v1/admin/loyalty/settings') return settingsBody(body);
  if (path === '/v1/admin/reviews-settings') return only(body, ['enabled', 'allowGuests', 'autoApprove', 'requirePurchase']) && Object.values(body).every(v => typeof v === 'boolean');
  if (new RegExp(`^/v1/admin/reviews/${uuid}/(approve|reject)$`).test(path)) return only(body, []);
  if (new RegExp(`^/v1/admin/reviews/${uuid}/reply$`).test(path)) return only(body, ['reply']) && 'reply' in body && (body.reply === null || (typeof body.reply === 'string' && text(body.reply, 2000)));
  if (new RegExp(`^/v1/admin/orders/${id}/edit/preview$`).test(path)) return only(body, ['ops']) && opList(body.ops, 0);
  if (new RegExp(`^/v1/admin/orders/${id}/edit/commit$`).test(path)) return only(body, ['ops', 'expectedGrandTotal', 'expectedBalance', 'idempotencyKey', 'settlement', 'notifyCustomer', 'reason']) &&
    opList(body.ops, 1) && int(body.expectedGrandTotal, 0, 10000000) && optInt(body.expectedBalance, -10000000, 10000000) &&
    typeof body.idempotencyKey === 'string' && body.idempotencyKey.length >= 1 && body.idempotencyKey.length <= 100 && /^[A-Za-z0-9_.:-]+$/.test(body.idempotencyKey) &&
    settlement(body.settlement) && optBool(body.notifyCustomer) && text(body.reason, 1000);
  if (new RegExp(`^/v1/admin/orders/${id}/address$`).test(path)) return only(body, ['kind', 'address', 'saveToAddressBook', 'reason']) && ['shipping', 'billing'].includes(body.kind) && addressBody(body.address) && optBool(body.saveToAddressBook) && text(body.reason, 1000);
  if (path === '/v1/admin/blog') return blogBody(body, false);
  if (new RegExp(`^/v1/admin/blog/${uuid}$`).test(path)) return blogBody(body, true);
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
