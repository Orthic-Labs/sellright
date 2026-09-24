import {test} from 'node:test';
import assert from 'node:assert/strict';
import {interactiveRequest, interactiveBody, sameOriginMutation, demoRouteTarget, allowedDemoHost} from './interactive-policy.mjs';
test('demo exposes bounded commerce, never credentials, uploads or real gateway paths', () => {
  for (const path of ['/v1/admin/settings', '/v1/admin/staff', '/v1/admin/assets', '/v1/admin/webhooks', '/v1/admin/marketing/sync', '/v1/shop/orders/SR1/pay', '/v1/shop/orders/SR1/payment-intent', '/v1/admin/orders/export']) {
    for (const method of ['GET','POST','PATCH','DELETE']) assert.equal(interactiveRequest(method,path),false,path);
  }
  for(const [method,path] of [['POST','/v1/shop/checkout'],['PATCH','/v1/admin/variants/abc/stock'],['POST','/v1/admin/orders/SR1/refund'],['GET','/v1/admin/orders/SR1']])assert.equal(interactiveRequest(method,path),true);
});
test('the generic storefront can browse and read receipts, but never accounts, auth or gateways', () => {
  for (const path of ['/v1/shop/catalog/search', '/v1/shop/catalog/products/studio-notebook/stock', '/v1/shop/collections/desk', '/v1/shop/orders/SR1', '/v1/shop/blog', '/v1/shop/blog/my-post', '/v1/shop/currencies'])
    assert.equal(interactiveRequest('GET', path), true, path);
  for (const path of ['/v1/shop/auth/me', '/v1/shop/auth/login', '/v1/shop/account/orders', '/v1/shop/account/addresses', '/v1/shop/stripe-key', '/v1/shop/newsletter-signup', '/v1/shop/contact', '/v1/shop/track', '/v1/shop/orders/SR1/gateway-payment'])
    assert.equal(interactiveRequest('GET', path), false, path);
});
test('checkout accepts only cart references and server-known delivery choices, never identity or prices',()=>{
  const body={cartToken:'de000000-0000-4000-8000-000000000001',expectedRevision:0,shippingMethodCode:'standard'};
  assert.equal(interactiveBody('/v1/shop/checkout',body),true);
  // The generic storefront's real checkout payload additionally carries these
  // — interactive-server.mjs overwrites items/email/shippingAddress from the
  // live cart + a synthetic identity before the request ever reaches the real
  // app, so accepting bounded values here is safe: nothing here is ever
  // trusted as the source of truth.
  assert.equal(interactiveBody('/v1/shop/checkout',{...body,email:'shopper@example.com',shipping:0,shippingAddress:{city:'Sample City'},billingAddress:null,giftCardCode:'GIFT10',items:[{sku:'__cart__',quantity:1}]}),true);
  for(const extra of [{amount:1},{shippingMethodCode:'other'},{password:'x'},{customerId:'abc'},{shippingAddress:'not-an-object'},{shippingAddress:{huge:'x'.repeat(2000)}},{items:[{sku:'x'.repeat(100),quantity:1}]},{items:Array.from({length:13},()=>({sku:'DEMO-X',quantity:1}))}])
    assert.equal(interactiveBody('/v1/shop/checkout',{...body,...extra}),false);
});
test('cart mutations accept an optional bounded coupon code alongside bounded lines',()=>{
  const token='de000000-0000-4000-8000-000000000001';
  assert.equal(interactiveBody(`/v1/shop/cart/${token}/lines`,{lines:[{sku:'DEMO-NOTEBOOK',quantity:1}],couponCode:'WELCOME10'}),true);
  assert.equal(interactiveBody(`/v1/shop/cart/${token}/lines`,{lines:[{sku:'DEMO-NOTEBOOK',quantity:1}],couponCode:'x'.repeat(64)}),false);
});
test('the Host allowlist admits loopback, the public hostname and whatever address this process is bound to, nothing else',()=>{
  for(const host of ['localhost','127.0.0.1','demo.sellright.cc','172.22.0.1'])assert.equal(allowedDemoHost(host,'172.22.0.1'),true,host);
  for(const host of ['evil.example','172.22.0.1.evil.example','demo.sellright.cc.evil.example','10.0.0.1'])assert.equal(allowedDemoHost(host,'172.22.0.1'),false,host);
  // A loopback deployment (DEMO_BIND_HOST unset/127.0.0.1) doesn't additionally
  // admit the bridge IP it isn't bound to.
  assert.equal(allowedDemoHost('172.22.0.1','127.0.0.1'),false);
});
test('non-API routing sends everything except /admin to the generic storefront',()=>{
  for (const path of ['/', '/shop', '/shop/', '/products/studio-notebook', '/collections/desk', '/cart', '/checkout', '/blog', '/search', '/build/entry.js', '/account/orders'])
    assert.equal(demoRouteTarget(path), 'storefront', path);
  assert.equal(demoRouteTarget('/demo-admin.js'), 'demo-asset');
  // The admin SPA's own top-level routes (packages/admin/src/main.tsx) move
  // to /admin — its basename covers every one of them, so only the /admin
  // prefix itself needs to route there.
  for (const path of ['/admin', '/admin/', '/admin/login', '/admin/orders', '/admin/orders/SR1', '/admin/products', '/admin/collections', '/admin/settings', '/admin/admin-static/index.js'])
    assert.equal(demoRouteTarget(path), 'admin', path);
});
test('stock and catalog mutations are bounded; external-service variant metadata is denied',()=>{
  assert.equal(interactiveBody('/v1/admin/variants/x/stock',{onHand:1001}),false);
  assert.equal(interactiveBody('/v1/admin/variants/x',{fulfillmentType:'digital_download',downloadUrl:'https://example.com'}),false);
  assert.equal(interactiveBody('/v1/admin/products/x',{name:'<script>'}),false);
  assert.equal(interactiveBody('/v1/admin/products/x',{name:'New notebook'}),true);
});
test('missing, malformed and foreign origins cannot mutate or create demo sessions',()=>{
  for(const origin of [undefined,'garbage','https://evil.example'])assert.equal(sameOriginMutation({origin},'demo.sellright.cc'),false);
  assert.equal(sameOriginMutation({origin:'https://demo.sellright.cc'},'demo.sellright.cc'),true);
});
