/**
 * `sellright functional-check` (WS-E, decision 1.11 step 6). Runs inside the
 * `api` container after an update's migrate+start step, before maintenance
 * mode is lifted. Exits non-zero on ANY failure — the host `sellright update`
 * script treats a non-zero exit as "roll back to the previous images", so
 * every check here must be conservative: no real payment call, no email
 * send, and the cart it creates is deleted before the script returns rather
 * than left as a stray order.
 *
 * Checks, in order:
 *   1. database  - SELECT 1 (same probe as GET /v1/readyz)
 *   2. catalog   - a real product-list query against BOOTSTRAP_STORE_SLUG (or
 *                  FUNCTIONAL_CHECK_STORE_SLUG), in-process via createApp(),
 *                  not over the network — this must work even before Caddy
 *                  is fronting the new containers.
 *   3. cart      - create a cart with that store's first product, fetch it
 *                  back and confirm totals computed, then delete it. Stops
 *                  BEFORE POST /v1/shop/checkout — no order, no payment
 *                  gateway call, no confirmation email is ever reachable
 *                  from this path.
 *   4. queue     - if JOBS_ENABLED, confirm the advisory-lock primitive the
 *                  scheduler depends on (pg_try_advisory_lock /
 *                  pg_advisory_unlock) round-trips on this connection. If
 *                  jobs are disabled, this check is skipped and reported as
 *                  such (not a failure — a deployment that disables jobs is
 *                  not thereby "unhealthy").
 */
import { createApp } from '../app.js';
import { pool } from '../db/client.js';
import { env } from '../env.js';

type CheckResult = { name: string; ok: boolean; detail?: string };

async function checkDatabase(): Promise<CheckResult> {
  try {
    const res = await pool.query('SELECT 1');
    return { name: 'database', ok: (res.rowCount ?? 0) >= 1 };
  } catch (e) {
    return { name: 'database', ok: false, detail: (e as Error).message };
  }
}

async function checkQueue(): Promise<CheckResult> {
  if (env.JOBS_ENABLED !== '1') {
    return { name: 'queue', ok: true, detail: 'skipped (JOBS_ENABLED != 1)' };
  }
  const client = await pool.connect();
  try {
    // Namespace 0x53525350 mirrors leader-lock.ts's "SRSP" scheduler
    // namespace; key 0 is reserved here for this health check so it can never
    // collide with a real per-job key (see leader-lock.ts's key map).
    const key = { ns: 0x53525350, id: 0 };
    const got = await client.query('SELECT pg_try_advisory_lock($1, $2) AS ok', [key.ns, key.id]);
    const ok = got.rows[0]?.ok === true;
    if (ok) await client.query('SELECT pg_advisory_unlock($1, $2)', [key.ns, key.id]);
    return { name: 'queue', ok, detail: ok ? undefined : 'advisory lock unavailable' };
  } catch (e) {
    return { name: 'queue', ok: false, detail: (e as Error).message };
  } finally {
    client.release();
  }
}

async function checkCatalogAndCart(): Promise<CheckResult[]> {
  const slug = env.FUNCTIONAL_CHECK_STORE_SLUG ?? env.BOOTSTRAP_STORE_SLUG;
  if (!slug) {
    return [{ name: 'catalog', ok: true, detail: 'skipped (no BOOTSTRAP_STORE_SLUG/FUNCTIONAL_CHECK_STORE_SLUG configured)' },
      { name: 'cart', ok: true, detail: 'skipped (no store configured)' }];
  }
  const app = createApp();
  const headers = { 'x-store-slug': slug, 'content-type': 'application/json' };

  const productsRes = await app.request('/v1/shop/catalog/products?limit=1', { headers });
  if (!productsRes.ok) {
    return [{ name: 'catalog', ok: false, detail: `GET catalog/products -> ${productsRes.status}` },
      { name: 'cart', ok: false, detail: 'skipped (catalog check failed)' }];
  }
  const products = await productsRes.json() as { items?: Array<{ sku?: string; variants?: Array<{ sku: string }> }> };
  const items = products.items ?? [];
  const catalogResult: CheckResult = { name: 'catalog', ok: true, detail: `${items.length} product(s) visible` };
  if (items.length === 0) {
    // No product in the test store is a configuration fact, not an update
    // failure — the cart step can't be exercised, but that's not this
    // release's fault. Reported clearly rather than silently skipped.
    return [catalogResult, { name: 'cart', ok: true, detail: 'skipped (test store has no products)' }];
  }
  const first = items[0];
  const sku = first?.variants?.[0]?.sku ?? first?.sku;
  if (!sku) return [catalogResult, { name: 'cart', ok: false, detail: 'first product has no sku/variant' }];

  const createRes = await app.request('/v1/shop/cart', {
    method: 'POST',
    headers,
    body: JSON.stringify({ items: [{ sku, quantity: 1 }] }),
  });
  if (!createRes.ok) {
    return [catalogResult, { name: 'cart', ok: false, detail: `POST cart -> ${createRes.status}` }];
  }
  const cart = await createRes.json() as { token?: string; grandTotal?: number };
  if (!cart.token) return [catalogResult, { name: 'cart', ok: false, detail: 'cart response missing token' }];

  const getRes = await app.request(`/v1/shop/cart/${cart.token}`, { headers });
  const fetched = getRes.ok ? await getRes.json() as { grandTotal?: number } : null;
  const totalsOk = getRes.ok && typeof fetched?.grandTotal === 'number';

  // Best-effort cleanup — this is a dry run, not a real cart. Cart TTL/reaper
  // (cart-maintenance.ts) would eventually clear it anyway, but don't rely on
  // a paused scheduler (maintenance mode) to do that for us.
  await pool.query(`DELETE FROM cart WHERE token = $1`, [cart.token]).catch(() => undefined);

  return [
    catalogResult,
    totalsOk
      ? { name: 'cart', ok: true, detail: 'created, priced and cleaned up; no checkout/payment call made' }
      : { name: 'cart', ok: false, detail: `GET cart -> ${getRes.status}, totals present: ${totalsOk}` },
  ];
}

async function main(): Promise<void> {
  const results: CheckResult[] = [];
  results.push(await checkDatabase());
  results.push(...await checkCatalogAndCart());
  results.push(await checkQueue());

  for (const r of results) {
    console.log(`[functional-check] ${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  }
  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.error(`[functional-check] ${failed.length} check(s) failed`);
    process.exitCode = 1;
  } else {
    console.log('[functional-check] all checks passed');
  }
}

main()
  .catch((e) => {
    console.error('[functional-check] crashed', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => undefined);
  });
