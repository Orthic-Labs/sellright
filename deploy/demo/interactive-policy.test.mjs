import {test} from 'node:test';
import assert from 'node:assert/strict';
import {interactiveRequest, interactiveBody, sameOriginMutation} from './interactive-policy.mjs';
test('demo exposes bounded commerce, never credentials, uploads or real gateway paths', () => {
  for (const path of ['/v1/admin/settings', '/v1/admin/staff', '/v1/admin/assets', '/v1/admin/webhooks', '/v1/admin/marketing/sync', '/v1/shop/orders/SR1/pay', '/v1/shop/orders/SR1/payment-intent', '/v1/admin/orders/export']) {
    for (const method of ['GET','POST','PATCH','DELETE']) assert.equal(interactiveRequest(method,path),false,path);
  }
  for(const [method,path] of [['POST','/v1/shop/checkout'],['PATCH','/v1/admin/variants/abc/stock'],['POST','/v1/admin/orders/SR1/refund'],['GET','/v1/admin/orders/SR1']])assert.equal(interactiveRequest(method,path),true);
});
test('checkout accepts only cart references and server-known delivery choices, never identity or prices',()=>{
  const body={cartToken:'de000000-0000-4000-8000-000000000001',expectedRevision:0,shippingMethodCode:'standard'};
  assert.equal(interactiveBody('/v1/shop/checkout',body),true);
  for(const extra of [{email:'person@example.com'},{amount:1},{shippingMethodCode:'other'},{items:[]}])assert.equal(interactiveBody('/v1/shop/checkout',{...body,...extra}),false);
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
