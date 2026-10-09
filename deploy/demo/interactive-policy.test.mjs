import {test} from 'node:test';
import assert from 'node:assert/strict';
import {interactiveRequest, interactiveBody, sameOriginMutation, demoRouteTarget, allowedDemoHost} from './interactive-policy.mjs';
test('demo exposes bounded commerce, never credentials, uploads or real gateway paths', () => {
  for (const path of ['/v1/admin/settings', '/v1/admin/staff', '/v1/admin/assets', '/v1/admin/webhooks', '/v1/admin/marketing/sync', '/v1/shop/orders/SR1/pay', '/v1/shop/orders/SR1/payment-intent', '/v1/admin/orders/export']) {
    for (const method of ['GET','POST','PATCH','DELETE']) assert.equal(interactiveRequest(method,path),false,path);
  }
  for(const [method,path] of [['POST','/v1/shop/checkout'],['PATCH','/v1/admin/variants/abc/stock'],['POST','/v1/admin/orders/SR1/refund'],['GET','/v1/admin/orders/SR1']])assert.equal(interactiveRequest(method,path),true);
});
test('installation-admin/system routes are unreachable through the public admin/admin demo credentials, for every method', () => {
  // The demo's only credential (demoAdminCredentials) is publicly known
  // (admin/admin) and every visitor's admin_user is seeded with
  // is_installation_admin=false (visitors.mjs) — but this must ALSO hold at
  // the request-routing layer, independent of that seeding, in case a demo
  // visitor's row was ever somehow flagged true. GET /v1/admin/system/
  // recovery-kit returns the install's master key; none of this surface may
  // ever be reachable here.
  for (const path of [
    '/v1/admin/system/recovery-kit',
    '/v1/admin/system/checklist',
    '/v1/admin/system/checklist/offsite-backup-confirmed',
    '/v1/admin/system',
    '/v1/admin/system/',
    '/v1/admin/step-up',
  ]) {
    for (const method of ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE']) assert.equal(interactiveRequest(method, path), false, `${method} ${path}`);
  }
});
test('the generic storefront can browse and read receipts, but never accounts, auth or gateways', () => {
  for (const path of ['/v1/shop/catalog/search', '/v1/shop/catalog/products/studio-notebook/stock', '/v1/shop/collections/desk', '/v1/shop/orders/SR1', '/v1/shop/blog', '/v1/shop/blog/my-post', '/v1/shop/currencies'])
    assert.equal(interactiveRequest('GET', path), true, path);
  for (const path of ['/v1/shop/auth/me', '/v1/shop/auth/login', '/v1/shop/account/orders', '/v1/shop/account/addresses', '/v1/shop/stripe-key', '/v1/shop/newsletter-signup', '/v1/shop/contact', '/v1/shop/track', '/v1/shop/orders/SR1/gateway-payment'])
    assert.equal(interactiveRequest('GET', path), false, path);
});
test('the public product reviews read is allowed; submitting a review is not',()=>{
  assert.equal(interactiveRequest('GET','/v1/shop/catalog/products/desk-tray/reviews'),true);
  for(const method of ['POST','PATCH','DELETE'])assert.equal(interactiveRequest(method,'/v1/shop/catalog/products/desk-tray/reviews'),false,method);
  assert.equal(interactiveRequest('GET','/v1/shop/catalog/products/desk-tray/reviews/extra'),false);
  // The ADMIN moderation queue is a separate, now-allowed read (owner features).
  assert.equal(interactiveRequest('GET','/v1/admin/reviews'),true);
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
const U = '11111111-2222-4333-8444-555555555555';
test('owner-feature reads render: points, reviews, order edit, waitlist, SEO preview, blog, export dialog',()=>{
  for(const path of ['/v1/admin/loyalty/settings','/v1/admin/loyalty/summary',`/v1/admin/customers/${U}/loyalty`,'/v1/admin/reviews','/v1/admin/reviews-settings','/v1/admin/orders/SR1/edit/context','/v1/admin/orders/SR1/edit/variants','/v1/admin/waitlist/report','/v1/admin/waitlist/report.csv','/v1/admin/seo/config','/v1/admin/seo/sitemaps','/v1/admin/blog',`/v1/admin/blog/${U}`,'/v1/admin/export/orders/columns','/v1/admin/export/orders','/v1/admin/export/orders.xlsx'])
    assert.equal(interactiveRequest('GET',path),true,path);
  for(const path of ['/v1/admin/export','/v1/admin/export/customers','/v1/admin/export/orders/extra','/v1/admin/orders/export','/v1/admin/orders/SR1/edit','/v1/admin/seo','/v1/admin/seo/indexnow/submit','/v1/admin/blog/requests/k','/v1/admin/loyalty','/v1/admin/affiliates'])
    assert.equal(interactiveRequest('GET',path),false,path);
});
test('owner-feature writes are allowed only on the exact routes',()=>{
  for(const [method,path] of [['PUT','/v1/admin/loyalty/settings'],['PUT','/v1/admin/reviews-settings'],['POST',`/v1/admin/reviews/${U}/approve`],['POST',`/v1/admin/reviews/${U}/reject`],['PUT',`/v1/admin/reviews/${U}/reply`],['POST','/v1/admin/orders/SR1/edit/preview'],['POST','/v1/admin/orders/SR1/edit/commit'],['PUT','/v1/admin/orders/SR1/address'],['POST','/v1/admin/blog'],['PATCH',`/v1/admin/blog/${U}`],['DELETE',`/v1/admin/blog/${U}`]])
    assert.equal(interactiveRequest(method,path),true,method+' '+path);
  for(const [method,path] of [['POST','/v1/admin/seo/sitemaps/refresh'],['POST','/v1/admin/seo/indexnow/submit'],['PATCH','/v1/admin/seo/config'],['PUT','/v1/admin/seo/config'],['DELETE',`/v1/admin/reviews/${U}`],['POST',`/v1/admin/customers/${U}/loyalty/adjust`],['POST',`/v1/admin/loyalty/ledger/${U}/reverse`],['POST','/v1/admin/orders/import-tracking'],['POST','/v1/admin/affiliates'],['POST','/v1/admin/affiliates/x/settle'],['PUT','/v1/admin/settings'],['PUT','/v1/admin/orders/SR1/lines'],['PUT','/v1/admin/blog'],['PUT',`/v1/admin/blog/${U}`],['POST','/v1/admin/reviews/not-a-uuid/approve']])
    assert.equal(interactiveRequest(method,path),false,method+' '+path);
});
test('loyalty settings accept bounded numbers and booleans only',()=>{
  const ok={enabled:true,earnRatePerDollar:2,pointsPerDollarOff:10,minRedeemPoints:50,maxRedeemPercentOfSubtotal:50,expiryDays:365,reviewBonusPoints:25,reviewBonusVerifiedOnly:true,signupBonusPoints:10,signupBonusSince:null,firstOrderBonusPoints:20,birthdayBonusPoints:0,productMultipliers:[{productId:U,multiplier:2}]};
  const p='/v1/admin/loyalty/settings';
  assert.equal(interactiveBody(p,ok),true);
  assert.equal(interactiveBody(p,{...ok,maxRedeemPercentOfSubtotal:null,expiryDays:null,signupBonusSince:'2026-10-01T00:00:00.000Z'}),true);
  for(const bad of [{enabled:'yes'},{earnRatePerDollar:101},{earnRatePerDollar:1.5},{pointsPerDollarOff:0},{pointsPerDollarOff:10001},{minRedeemPoints:-1},{maxRedeemPercentOfSubtotal:101},{expiryDays:0},{reviewBonusPoints:10001},{reviewBonusVerifiedOnly:'x'},{signupBonusSince:'tomorrow'},{extra:1},{productMultipliers:[{productId:'x',multiplier:2}]},{productMultipliers:[{productId:U,multiplier:101}]},{productMultipliers:Array.from({length:21},()=>({productId:U,multiplier:2}))}])
    assert.equal(interactiveBody(p,{...ok,...bad}),false,JSON.stringify(bad));
});
test('review moderation: empty approve/reject, bounded reply, boolean settings',()=>{
  assert.equal(interactiveBody(`/v1/admin/reviews/${U}/approve`,{}),true);
  assert.equal(interactiveBody(`/v1/admin/reviews/${U}/reject`,{}),true);
  assert.equal(interactiveBody(`/v1/admin/reviews/${U}/approve`,{status:'x'}),false);
  const r=`/v1/admin/reviews/${U}/reply`;
  assert.equal(interactiveBody(r,{reply:'Thanks for the feedback.'}),true);
  assert.equal(interactiveBody(r,{reply:null}),true);
  for(const bad of [{reply:'x'.repeat(2001)},{reply:'<script>'},{reply:5},{},{reply:'ok',extra:1}])assert.equal(interactiveBody(r,bad),false,JSON.stringify(bad));
  assert.equal(interactiveBody('/v1/admin/reviews-settings',{enabled:true,allowGuests:false,autoApprove:false,requirePurchase:true}),true);
  for(const bad of [{enabled:'true'},{enabled:true,other:true}])assert.equal(interactiveBody('/v1/admin/reviews-settings',bad),false);
});
test('order edit preview is bounded and commit settles only without gateway or email side effects',()=>{
  const ops=[{op:'set_quantity',lineId:U,quantity:2},{op:'add_item',sku:'DEMO-NOTEBOOK',quantity:1},{op:'add_adjustment',label:'Goodwill',amount:-200},{op:'set_shipping_method',code:'express'},{op:'apply_coupon',code:'WELCOME10'},{op:'remove_coupon'},{op:'set_address',kind:'shipping',address:{line1:'2 Demo Road',city:'Sample City',country:'us'}}];
  const prev='/v1/admin/orders/SR1/edit/preview';
  assert.equal(interactiveBody(prev,{ops}),true);
  assert.equal(interactiveBody(prev,{ops:[]}),true);
  for(const bad of [{ops:Array.from({length:31},()=>({op:'remove_coupon'}))},{ops:[{op:'drop_table'}]},{ops:[{op:'set_quantity',lineId:'x',quantity:1}]},{ops:[{op:'set_quantity',lineId:U,quantity:1001}]},{ops:[{op:'add_item',sku:'REAL-SKU',quantity:1}]},{ops:[{op:'add_item',sku:'DEMO-X',quantity:1,unitPrice:100001}]},{ops:[{op:'add_adjustment',label:'x',amount:0}]},{ops:[{op:'add_adjustment',label:'<b>',amount:5}]},{ops:[{op:'set_shipping_amount',amount:-1}]},{ops:[],extra:1}])
    assert.equal(interactiveBody(prev,bad),false,JSON.stringify(bad));
  assert.equal(interactiveBody(prev,{ops:[{op:'remove_coupon'}],extra:1}),false);
  const commit='/v1/admin/orders/SR1/edit/commit';
  const base={ops:[{op:'set_quantity',lineId:U,quantity:2}],expectedGrandTotal:4200,expectedBalance:1200,idempotencyKey:'7f1c2b8e-1111-4222-8333-444455556666',notifyCustomer:true,reason:'Customer request'};
  assert.equal(interactiveBody(commit,base),true);
  for(const s of [undefined,{type:'leave_due'},{type:'leave_credit'},{type:'record_payment',method:'cash',reference:'Cash at counter'},{type:'record_payment',method:'zelle',amount:1200},{type:'record_payment',method:'check'}])
    assert.equal(interactiveBody(commit,{...base,settlement:s}),true,JSON.stringify(s));
  for(const s of [{type:'refund_now'},{type:'refund_now',paymentId:U},{type:'send_pay_link'},{type:'record_payment',method:'stripe'},{type:'record_payment',method:'cash',reference:'x'.repeat(201)},{type:'record_payment',method:'cash',amount:0},{type:'leave_due',paymentId:U},{type:'other'},'refund_now'])
    assert.equal(interactiveBody(commit,{...base,settlement:s}),false,JSON.stringify(s));
  for(const bad of [{ops:[]},{expectedGrandTotal:-1},{expectedGrandTotal:1.5},{idempotencyKey:''},{idempotencyKey:'x'.repeat(101)},{reason:'x'.repeat(1001)},{notifyCustomer:'yes'},{amount:1}])
    assert.equal(interactiveBody(commit,{...base,...bad}),false,JSON.stringify(bad));
});
test('order address edit is bounded; names that look like other routes cannot bypass the new rules',()=>{
  const p='/v1/admin/orders/SR1/address';
  const ok={kind:'shipping',address:{fullName:'Alex Morgan',line1:'1 Demo Avenue',line2:null,city:'Sample City',province:'CA',postalCode:'90001',country:'US',phone:'555'},saveToAddressBook:false,reason:'Typo'};
  assert.equal(interactiveBody(p,ok),true);
  for(const bad of [{kind:'home'},{address:{...ok.address,line1:''}},{address:{...ok.address,country:'USA'}},{address:{...ok.address,city:'<x>'}},{address:{...ok.address,line1:'x'.repeat(201)}},{address:{...ok.address,extra:'y'}},{address:'str'},{reason:'x'.repeat(1001)},{saveToAddressBook:'y'}])
    assert.equal(interactiveBody(p,{...ok,...bad}),false,JSON.stringify(bad));
  // An order code of "products"/"variants" must not fall through to the looser catalog rules.
  assert.equal(interactiveBody('/v1/admin/orders/products/address',{name:'x'}),false);
  assert.equal(interactiveBody('/v1/admin/orders/products/edit/preview',{name:'x'}),false);
});
test('blog create/update are bounded; HTML body allowed (API sanitises) but no uploads',()=>{
  const ok={title:'Hello',excerpt:'Short',body:'<p>Hi <strong>there</strong></p>',isPublished:false};
  assert.equal(interactiveBody('/v1/admin/blog',ok),true);
  assert.equal(interactiveBody(`/v1/admin/blog/${U}`,{id:U,...ok}),true);
  assert.equal(interactiveBody(`/v1/admin/blog/${U}`,{}),true);
  for(const bad of [{title:''},{title:'<b>'},{title:'x'.repeat(201)},{body:'x'.repeat(8001)},{excerpt:'x'.repeat(501)},{tags:Array.from({length:11},()=>'t')},{featuredAssetId:U},{slug:'a b'},{publishDate:'soon'},{isPublished:'yes'},{extra:1},{id:U}])
    assert.equal(interactiveBody('/v1/admin/blog',{...ok,...bad}),false,JSON.stringify(bad));
  assert.equal(interactiveBody(`/v1/admin/blog/${U}`,{...ok,featuredAssetId:U}),false);
  assert.equal(interactiveBody(`/v1/admin/blog/${U}`,{...ok,id:'nope'}),false);
});
test('outbound-effect and sensitive owner routes stay denied for every method',()=>{
  for(const path of ['/v1/admin/seo/sitemaps/refresh','/v1/admin/seo/indexnow/submit','/v1/admin/seo/config','/v1/admin/settings/payments','/v1/admin/staff/invite','/v1/admin/webhooks','/v1/admin/assets','/v1/admin/orders/import-tracking','/v1/admin/orders/SR1/edit/refund','/v1/admin/sheerid','/v1/admin/system/recovery-kit','/v1/admin/step-up'])
    for(const method of ['POST','PUT','PATCH','DELETE']) assert.equal(interactiveRequest(method,path),false,method+' '+path);
  assert.equal(interactiveRequest('GET','/v1/admin/seo/sitemaps/refresh'),false);
});
