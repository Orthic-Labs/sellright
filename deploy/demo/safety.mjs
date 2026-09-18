export const demoStoreId = 'de000000-0000-4000-8000-000000000001';

export async function demoTransaction(pool, run, readOnly = false) {
  const client = await pool.connect();
  try {
    await client.query(readOnly ? 'BEGIN READ ONLY' : 'BEGIN');
    await client.query("SET LOCAL statement_timeout = '3000ms'");
    await client.query("SELECT set_config('app.current_store', $1, true)", [demoStoreId]);
    const result = await run(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

export async function assertDemoData(pool) {
  return demoTransaction(pool, async (client) => {
    const { rows: stores } = await client.query('SELECT id, slug, config FROM store');
    if (stores.length !== 1 || stores[0].id !== demoStoreId ||
        stores[0].slug !== 'demo' || stores[0].config?.demo !== true ||
        Object.values(stores[0].config?.payments ?? {}).some(Boolean)) {
      throw new Error('Demo store invariant failed');
    }
    const { rows: admins } = await client.query(
      'SELECT a.email, m.role FROM admin_user_store m JOIN admin_user a ON a.id = m.admin_user_id');
    if (admins.length !== 1 || admins[0].email !== 'visitor@demo.example' || admins[0].role !== 'read_only') {
      throw new Error('Demo admin invariant failed');
    }
    const { rows: [data] } = await client.query(`
      SELECT
        (SELECT count(*) FROM customer) AS customers,
        (SELECT count(*) FROM address) AS addresses,
        (SELECT count(*) FROM payment) AS payments,
        (SELECT count(*) FROM "order") AS orders,
        (SELECT count(*) FROM "order" WHERE metadata->>'syntheticDemo' IS DISTINCT FROM 'true'
          OR customer_id IS NOT NULL OR shipping_address IS NOT NULL OR billing_address IS NOT NULL) AS unsafe_orders,
        (SELECT count(*) FROM product) AS products,
        (SELECT count(*) FROM product WHERE NOT ('demo' = ANY(tags)) OR tags IS NULL) AS unsafe_products,
        (SELECT count(*) FROM cart WHERE email IS NOT NULL OR customer_id IS NOT NULL) AS identified_carts
    `);
    if (['customers', 'addresses', 'payments', 'unsafe_orders', 'unsafe_products', 'identified_carts']
      .some(key => Number(data[key]) !== 0) || Number(data.orders) !== 4 || Number(data.products) !== 4) {
      throw new Error('Demo synthetic-data invariant failed');
    }
    return true;
  }, true);
}

export async function cleanDemo(pool) {
  await assertDemoData(pool);
  await demoTransaction(pool, async (client) => {
    await client.query("DELETE FROM cart WHERE created_at < now() - interval '1 day'");
    await client.query("DELETE FROM session WHERE expires_at < now() OR created_at < now() - interval '1 hour'");
  });
}

export async function demoCounts(pool) {
  return demoTransaction(pool, async (client) => {
    const { rows: [row] } = await client.query(`
      SELECT (SELECT count(*) FROM cart) AS carts,
        (SELECT count(*) FROM session WHERE expires_at > now()) AS sessions
    `);
    return { carts: Number(row.carts), sessions: Number(row.sessions) };
  }, true);
}
