import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Writable} from 'node:stream';
import {interactiveRequest, interactiveBody, sameOriginMutation, demoRouteTarget, allowedDemoHost, probeRequest, storefrontServerFunctionHashes, storefrontServerFunctionAllowed, demoCheckoutBody, syntheticDemoAddress, forwardInteractiveResponse} from './interactive-policy.mjs';
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
  // — interactive-server.mjs overwrites items/email/shippingAddress/billingAddress from the
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
test('current cart add, update and coupon payloads accept bounded quote context',()=>{
  const p='/v1/shop/cart/de000000-0000-4000-8000-000000000001/lines';
  assert.equal(interactiveBody(p,{lines:[{sku:'DEMO-NOTEBOOK',quantity:1}],shipCountry:'US'}),true);
  const context={shipCountry:'US',shippingMethodCode:'express',pricingIntent:'checkout',redeemPoints:1000000};
  assert.equal(interactiveBody(p,{lines:[{sku:'DEMO-NOTEBOOK',quantity:2}],expectedRevision:1,...context}),true);
  assert.equal(interactiveBody(p,{lines:[],couponCodes:['WELCOME10'],expectedRevision:2,...context}),true);
  assert.equal(interactiveBody(p,{lines:[],couponCodes:[],expectedRevision:3,...context,pricingIntent:'preview',redeemPoints:0}),true);
  assert.equal(interactiveBody(p,{lines:[],couponCodes:Array.from({length:12},()=> 'X'.repeat(32))}),true);
  for(const bad of [{shipCountry:'us'},{shipCountry:'USA'},{shipCountry:1},{shipCountry:null},{shippingMethodCode:'overnight'},{shippingMethodCode:null},{pricingIntent:'other'},{pricingIntent:null},{redeemPoints:-1},{redeemPoints:1000001},{redeemPoints:1.5},{redeemPoints:Number.MAX_SAFE_INTEGER+1},{redeemPoints:'1'},{redeemPoints:null},{couponCodes:'WELCOME10'},{couponCodes:null},{couponCodes:Array.from({length:13},()=> 'X')},{couponCodes:['']},{couponCodes:[' ']},{couponCodes:['X'.repeat(33)]},{couponCodes:[1]},{couponCodes:['<X>']},{quoteContext:{}},{amount:1},{lines:[{sku:'OTHER',quantity:1}]},{lines:[{sku:'DEMO-NOTEBOOK',quantity:11}]},{lines:[{sku:'DEMO-NOTEBOOK',quantity:1,unitPrice:1}]}])
    assert.equal(interactiveBody(p,{lines:[],...bad}),false,JSON.stringify(bad));
});
test('current native checkout payload accepts bounded coupons, points and its exact quote hash',()=>{
  const p='/v1/shop/checkout';
  const body={cartToken:'de000000-0000-4000-8000-000000000001',expectedRevision:4,shippingMethodCode:'standard',email:'shopper@example.com',shippingAddress:{line1:'1 Sample Street',city:'Sample City',country:'US'},billingAddress:null,giftCardCode:'GIFT10',items:[{sku:'__cart__',quantity:1}],couponCode:'WELCOME10',couponCodes:['WELCOME10'],acceptedQuoteHash:'0123456789abcdef'.repeat(4),redeemPoints:100};
  assert.equal(interactiveBody(p,body),true);
  for(const redeemPoints of [0,1000000])assert.equal(interactiveBody(p,{...body,redeemPoints}),true);
  assert.equal(interactiveBody(p,{...body,couponCodes:Array.from({length:12},()=> 'X'.repeat(32))}),true);
  for(const bad of [{couponCodes:'WELCOME10'},{couponCodes:null},{couponCodes:Array.from({length:13},()=> 'X')},{couponCodes:['']},{couponCodes:[' ']},{couponCodes:['X'.repeat(33)]},{couponCodes:[1]},{couponCodes:['<X>']},{redeemPoints:-1},{redeemPoints:1000001},{redeemPoints:1.5},{redeemPoints:Number.MAX_SAFE_INTEGER+1},{redeemPoints:'1'},{redeemPoints:null},{acceptedQuoteHash:'a'.repeat(63)},{acceptedQuoteHash:'a'.repeat(65)},{acceptedQuoteHash:'A'.repeat(64)},{acceptedQuoteHash:'g'.repeat(64)},{acceptedQuoteHash:null},{acceptedQuoteHash:{}},{quoteContext:{}},{amount:1}])
    assert.equal(interactiveBody(p,{...body,...bad}),false,JSON.stringify(bad));
});
test('legacy estimate adapter keeps its cart-reference-only payload',()=>{
  const p='/v1/shop/cart/estimate';
  const body={cartToken:'de000000-0000-4000-8000-000000000001',shippingMethodCode:'standard',couponCode:'WELCOME10'};
  assert.equal(interactiveBody(p,body),true);
  for(const extra of [{items:[{sku:'DEMO-NOTEBOOK',quantity:1}]},{shipCountry:'US'},{couponCodes:['WELCOME10']},{redeemPoints:1},{acceptedQuoteHash:'a'.repeat(64)}])
    assert.equal(interactiveBody(p,{...body,...extra}),false,JSON.stringify(extra));
});
test('shipping quote: POST /v1/shop/shipping-methods takes only a bounded country + demo-cart lines',()=>{
  const p='/v1/shop/shipping-methods';
  assert.equal(interactiveRequest('POST',p),true);
  for(const method of ['PUT','PATCH','DELETE'])assert.equal(interactiveRequest(method,p),false,method);
  assert.equal(interactiveRequest('POST','/v1/admin/shipping-methods'),false);
  const body={country:'GB',items:[{sku:'DEMO-DESK-TRAY',quantity:2}]};
  assert.equal(interactiveBody(p,body),true);
  for(const ok of [{couponCodes:['WELCOME10']},{couponCode:'WELCOME10'},{redeemPoints:0},{country:'IN'},{items:Array.from({length:12},()=>({sku:'DEMO-NOTEBOOK',quantity:10}))}])
    assert.equal(interactiveBody(p,{...body,...ok}),true,JSON.stringify(ok));
  for(const bad of [{country:'gb'},{country:'GBR'},{country:undefined},{country:1},{items:[]},{items:undefined},{items:'x'},
    {items:Array.from({length:13},()=>({sku:'DEMO-NOTEBOOK',quantity:1}))},{items:[{sku:'REAL-SKU',quantity:1}]},{items:[{sku:'DEMO-NOTEBOOK',quantity:0}]},
    {items:[{sku:'DEMO-NOTEBOOK',quantity:11}]},{items:[{sku:'DEMO-NOTEBOOK',quantity:1,price:0}]},{couponCode:'<x>'},{couponCodes:['X'.repeat(33)]},{redeemPoints:-1},
    {shipping:0},{email:'a@b.c'},{shippingAddress:{}}])
    assert.equal(interactiveBody(p,{...body,...bad}),false,JSON.stringify(bad));
});
test('storefront server functions: only the postcode lookup, by its exact build hash',()=>{
  // Shape of a real dist-demo/q-manifest.json entry: keyed s_<hash>, and the browser sends the bare `hash` as ?qfunc=.
  const manifest={symbols:{s_s_zip:{displayName:'postal-lookup-server.tsx_lookupPostalServer_server',hash:'s_zip'},s_s_track:{displayName:'track-order.service.ts_trackOrderServer_server',hash:'s_track'},
    s_s_contact:{displayName:'content.tsx_submitFormServer_server',hash:'s_contact'},s_s_aff:{displayName:'index.tsx_fetchAffiliateStatsServer_server',hash:'s_aff'},
    s_nohash:{displayName:'postal-lookup-server.tsx_lookupPostalServer_server'}}};
  const allowed=storefrontServerFunctionHashes(manifest);
  assert.deepEqual([...allowed],['s_zip']);
  assert.deepEqual([...storefrontServerFunctionHashes({})],[]);
  assert.deepEqual([...storefrontServerFunctionHashes(undefined)],[]);
  const headers={'x-qrl':'s_zip','content-type':'application/qwik-json'};
  const url=q=>new URL('https://demo.sellright.cc/checkout/'+q);
  assert.equal(storefrontServerFunctionAllowed('POST',url('?qfunc=s_zip'),headers,allowed),true);
  for(const hash of ['s_track','s_contact','s_aff','s_other'])
    assert.equal(storefrontServerFunctionAllowed('POST',url('?qfunc='+hash),{...headers,'x-qrl':hash},allowed),false,hash);
  assert.equal(storefrontServerFunctionAllowed('GET',url('?qfunc=s_zip'),headers,allowed),false);
  assert.equal(storefrontServerFunctionAllowed('POST',url(''),headers,allowed),false);
  assert.equal(storefrontServerFunctionAllowed('POST',url('?qfunc=s_zip'),{...headers,'x-qrl':'s_track'},allowed),false);
  assert.equal(storefrontServerFunctionAllowed('POST',url('?qfunc=s_zip'),{'x-qrl':'s_zip','content-type':'application/json'},allowed),false);
  // Route actions and GET-encoded server data ride on extra query keys; none are admitted.
  for(const extra of ['&qaction=x','&qdata=x','&qfunc=s_track'])
    assert.equal(storefrontServerFunctionAllowed('POST',url('?qfunc=s_zip'+extra),headers,allowed),false,extra);
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

test('cookie-less probes never count as visitors: HEAD, empty and non-browser user agents', () => {
  const chrome = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36';
  const safari = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
  assert.equal(probeRequest('GET', { 'user-agent': chrome }), false);
  assert.equal(probeRequest('GET', { 'user-agent': safari }), false);
  assert.equal(probeRequest('HEAD', { 'user-agent': chrome }), true);
  assert.equal(probeRequest('GET', {}), true);
  assert.equal(probeRequest('GET', { 'user-agent': '  ' }), true);
  for (const ua of ['curl/8.5.0', 'Wget/1.21', 'Googlebot/2.1 (+http://www.google.com/bot.html)', 'Mozilla/5.0 (compatible; bingbot/2.0)',
    'UptimeRobot/2.0', 'Pingdom.com_bot_version_1.4', 'python-requests/2.32', 'Go-http-client/1.1', 'node-fetch/1.0', 'axios/1.7',
    'Mozilla/5.0 HeadlessChrome/141.0', 'facebookexternalhit/1.1', 'Blackbox Exporter/0.25', 'kube-probe/1.30', 'ELB-HealthChecker/2.0', 'GoogleHC/1.0']) {
    assert.equal(probeRequest('GET', { 'user-agent': ua }), true, ua);
  }
});


test('checkout boundary replaces submitted identities and items with synthetic cart-derived data',()=>{
  const input={cartToken:'de000000-0000-4000-8000-000000000001',expectedRevision:2,shippingMethodCode:'standard',couponCode:'WELCOME10',email:'real@example.com',shippingAddress:{fullName:'Real Ship',line1:'Private Road'},billingAddress:{fullName:'Real Bill',line1:'Private Lane',phone:'555-1234'},items:[{sku:'UNTRUSTED',quantity:9}]};
  const output=demoCheckoutBody(input,[{sku:'DEMO-NOTEBOOK',quantity:2,price:500}]);
  assert.equal(output.email,'sample0@demo.invalid');
  assert.deepEqual(output.shippingAddress,syntheticDemoAddress);
  assert.deepEqual(output.billingAddress,syntheticDemoAddress);
  assert.deepEqual(output.items,[{sku:'DEMO-NOTEBOOK',quantity:2}]);
  assert.equal(output.cartToken,input.cartToken);
  assert.equal(output.expectedRevision,2);
  assert.equal(output.couponCode,'WELCOME10');
  assert.equal(input.billingAddress.fullName,'Real Bill');
  assert.notEqual(output.billingAddress,output.shippingAddress);
  for(const billingAddress of [undefined,null,{email:'private@example.com'}])assert.deepEqual(demoCheckoutBody({...input,billingAddress},[]).billingAddress,syntheticDemoAddress);
});

function responseSink(){
  const chunks=[];
  const res=new Writable({write(chunk,_encoding,done){chunks.push(Buffer.from(chunk));done();}});
  res.headers={'cache-control':'no-store','content-security-policy':"default-src 'self'"};
  res.writeHead=(status,headers)=>{res.status=status;Object.assign(res.headers,headers);};
  return {res,bytes:()=>Buffer.concat(chunks)};
}

test('demo forwards CSV and XLSX bytes, status and export metadata without parsing JSON',async()=>{
  for(const [type,payload]of [['text/csv; charset=utf-8',Buffer.from('code,total\nDEMO-1,500\n')],['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',Buffer.from([0x50,0x4b,0x03,0x04,0,0xff,0x80,0x0a])]]){
    const response=new Response(new ReadableStream({start(controller){controller.enqueue(payload.subarray(0,3));controller.enqueue(payload.subarray(3));controller.close();}}),{status:206,headers:{'content-type':type,'content-disposition':'attachment; filename="demo-export"','content-length':String(payload.length),'x-export-rows':'1','x-export-capped':'0','set-cookie':'upstream=forbidden','cache-control':'public','content-security-policy':"default-src *",connection:'close'}});
    response.json=()=>{throw Error('file response must never be parsed as JSON');};
    const sink=responseSink();
    await forwardInteractiveResponse(response,sink.res);
    assert.deepEqual(sink.bytes(),payload);
    assert.equal(sink.res.status,206);
    assert.equal(sink.res.headers['content-type'],type);
    assert.equal(sink.res.headers['content-length'],String(payload.length));
    assert.equal(sink.res.headers['content-disposition'],'attachment; filename="demo-export"');
    assert.equal(sink.res.headers['x-export-rows'],'1');
    assert.equal(sink.res.headers['x-export-capped'],'0');
    assert.equal(sink.res.headers['cache-control'],'no-store');
    assert.equal(sink.res.headers['content-security-policy'],"default-src 'self'");
    assert.equal(sink.res.headers['set-cookie'],undefined);
    assert.equal(sink.res.headers.connection,undefined);
  }
});

test('successful checkout JSON still receives simulated settlement and corrected length',async()=>{
  const sink=responseSink();let calls=0;
  await forwardInteractiveResponse(new Response(JSON.stringify({code:'DEMO-1',state:'PendingPayment'}),{status:201,headers:{'content-type':'application/json','content-length':'1'}}),sink.res,async data=>{calls++;return {...data,state:'Paid',simulated:true};});
  assert.equal(calls,1);
  assert.equal(sink.res.status,201);
  assert.deepEqual(JSON.parse(sink.bytes().toString()),{code:'DEMO-1',state:'Paid',simulated:true});
  assert.equal(sink.res.headers['content-length'],undefined);
  assert.equal(sink.res.headers['content-type'],'application/json');
  const errorSink=responseSink();
  await forwardInteractiveResponse(new Response('{"error":"checkout rejected"}',{status:409,headers:{'content-type':'application/json'}}),errorSink.res,()=>{throw Error('failed checkout must not settle');});
  assert.equal(errorSink.res.status,409);
  assert.deepEqual(JSON.parse(errorSink.bytes().toString()),{error:'checkout rejected'});
});
