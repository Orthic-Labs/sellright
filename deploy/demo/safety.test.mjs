import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertDemoData, demoStoreId, demoTransaction } from './safety.mjs';

function fixture(changes = {}) {
  const statements = [];
  let released = false;
  const client = {
    async query(sql) {
      statements.push(sql);
      if (sql.startsWith('SELECT id, slug')) return { rows: changes.stores ?? [{
        id: demoStoreId, slug: 'demo', config: { demo: true, payments: { stripe: false } },
      }] };
      if (sql.includes('JOIN admin_user')) return { rows: changes.admins ?? [{ email: 'visitor@demo.example', role: 'read_only' }] };
      if (sql.includes('AS identified_carts')) return { rows: [{
        customers: '0', addresses: '0', payments: '0', orders: '4', unsafe_orders: '0',
        products: '4', unsafe_products: '0', identified_carts: '0', ...changes.data,
      }] };
      return { rows: [] };
    },
    release() { released = true; },
  };
  return { pool: { connect: async () => client }, statements, released: () => released };
}
test('accepts only the marked synthetic store and read-only visitor', async () => {
  const f = fixture();
  assert.equal(await assertDemoData(f.pool), true);
  assert.equal(f.statements[0], 'BEGIN READ ONLY');
  assert.ok(f.statements.includes("SET LOCAL statement_timeout = '3000ms'"));
  assert.equal(f.statements.at(-1), 'COMMIT');
  assert.equal(f.released(), true);
});
test('blocks real customer, address, payment, cart identity or unmarked catalog/order data', async () => {
  for (const key of ['customers', 'addresses', 'payments', 'unsafe_orders', 'unsafe_products', 'identified_carts']) {
    const f = fixture({ data: { [key]: '1' } });
    await assert.rejects(assertDemoData(f.pool), /synthetic-data/);
    assert.equal(f.statements.at(-1), 'ROLLBACK');
    assert.equal(f.released(), true);
  }
});
test('blocks owner accounts, unexpected stores and enabled payment methods', async () => {
  for (const changes of [
    { admins: [{ email: 'visitor@demo.example', role: 'owner' }] },
    { stores: [] },
    { stores: [{ id: demoStoreId, slug: 'demo', config: { demo: true, payments: { stripe: true } } }] },
  ]) await assert.rejects(assertDemoData(fixture(changes).pool), /invariant/);
});
test('transaction failures roll back and release the same client', async () => {
  const f = fixture();
  await assert.rejects(demoTransaction(f.pool, async () => { throw new Error('fixture'); }), /fixture/);
  assert.equal(f.statements.at(-1), 'ROLLBACK');
  assert.equal(f.released(), true);
});
