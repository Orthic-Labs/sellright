import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertDemoData, cleanDemo, demoStoreId, demoTransaction } from './safety.mjs';

function fixture(changes = {}) {
  const statements = [];
  const calls = [];
  let released = false;
  const client = {
    async query(sql, values) {
      statements.push(sql);
      calls.push({ sql, values });
      if (sql.startsWith('SELECT id FROM cart')) return { rows: changes.expired ?? [] };
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
  return { pool: { connect: async () => client }, statements, calls, released: () => released };
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
test('cleanup locks expired carts and deletes their lines before the parent carts', async () => {
  const ids = ['de000000-0000-4000-8000-000000000002'];
  const f = fixture({ expired: ids.map(id => ({ id })) });
  await cleanDemo(f.pool);
  const operations = f.calls.filter(call => call.sql.includes('FROM cart'));
  assert.deepEqual(operations.slice(-3), [
    { sql: "SELECT id FROM cart WHERE created_at < now() - interval '1 day' FOR UPDATE", values: undefined },
    { sql: 'DELETE FROM cart_line WHERE cart_id = ANY($1::uuid[])', values: [ids] },
    { sql: 'DELETE FROM cart WHERE id = ANY($1::uuid[])', values: [ids] },
  ]);
  assert.equal(f.statements.at(-1), 'COMMIT');
});
test('cleanup does not delete carts or lines when no carts have expired', async () => {
  const f = fixture();
  await cleanDemo(f.pool);
  assert.equal(f.statements.some(sql => sql.startsWith('DELETE FROM cart')), false);
  assert.ok(f.statements.some(sql => sql.startsWith('DELETE FROM session')));
});
