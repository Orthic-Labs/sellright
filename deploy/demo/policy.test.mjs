import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowedDemoRequest, allowedDemoBody } from './policy.mjs';

test('demo blocks payment, identity, export, secrets and admin mutations', () => {
  for (const path of ['/v1/admin/settings', '/v1/admin/staff', '/v1/admin/orders/export',
    '/v1/admin/webhooks', '/v1/shop/auth/register', '/v1/shop/checkout',
    '/v1/shop/orders/DEMO-1001/pay', '/v1/payment-webhooks/stripe']) {
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      assert.equal(allowedDemoRequest(method, path), false, method + ' ' + path);
    }
  }
  assert.equal(allowedDemoRequest('POST', '/v1/admin/products'), false);
});
test('demo serves real catalog, cart and read-only admin views', () => {
  assert.equal(allowedDemoRequest('GET', '/v1/admin/products'), true);
  assert.equal(allowedDemoRequest('GET', '/v1/shop/catalog/products'), true);
  assert.equal(allowedDemoRequest('POST', '/v1/shop/cart'), true);
  assert.equal(allowedDemoRequest('PATCH', '/v1/shop/cart/de000000-0000-4000-8000-000000000001/lines'), true);
});
test('demo cart rejects personal data and unbounded line payloads', () => {
  assert.equal(allowedDemoBody('/v1/shop/cart', { email: 'person@example.com' }), false);
  assert.equal(allowedDemoBody('/v1/shop/cart', { items: [{ sku: 'DEMO-CUP', quantity: 11 }] }), false);
  assert.equal(allowedDemoBody('/v1/shop/cart', { items: [{ sku: 'DEMO-CUP', quantity: 2 }] }), true);
});
