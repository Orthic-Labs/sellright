/**
 * Invariant guard (research §1): every store-scoped table — i.e. every table
 * with a `store_id` column — MUST have FORCE ROW LEVEL SECURITY. With the app on
 * a non-owner role this is belt-and-suspenders (a missing FORCE already fails
 * closed); it's a fast, explicit signal that catches a future table added with
 * ENABLE-but-not-FORCE (or no RLS at all) before it ships.
 *
 * Exemptions are tables that carry a `store_id` FK for convenience but are NOT
 * tenant-data and MUST be readable without a store context:
 *   - store / admin_user / admin_user_store — registry/ACL (resolved pre-context)
 *   - session — auth lookups run by token hash BEFORE any store is chosen; RLS
 *     here would make login return zero rows. Sessions are also cross-store for
 *     admins. Isolation comes from the 256-bit token hash, not RLS.
 *   - processed_event — idempotency ledger; claims happen inside withStore but
 *     the table itself is cross-cutting infra, not per-tenant data.
 * Run via `pnpm verify`.
 */
import { pool } from './client.js';

const EXEMPT = new Set(['store', 'admin_user', 'admin_user_store', 'session', 'processed_event', 'staff_invite']);

async function main() {
  const { rows } = await pool.query<{ table: string; rls: boolean; force: boolean }>(`
    SELECT c.relname AS table, c.relrowsecurity AS rls, c.relforcerowsecurity AS force
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
      AND EXISTS (
        SELECT 1 FROM information_schema.columns col
        WHERE col.table_schema = 'public' AND col.table_name = c.relname AND col.column_name = 'store_id'
      )
    ORDER BY c.relname;
  `);

  const offenders = rows.filter((r) => !EXEMPT.has(r.table) && !(r.rls && r.force));
  await pool.end();

  if (offenders.length) {
    console.error('[assert-force-rls] FAIL — store-scoped tables missing FORCE RLS:');
    for (const o of offenders) console.error(`  - ${o.table} (rls=${o.rls} force=${o.force})`);
    console.error('Add: ALTER TABLE "<t>" ENABLE ROW LEVEL SECURITY; ALTER TABLE "<t>" FORCE ROW LEVEL SECURITY; + a tenant policy.');
    process.exit(1);
  }
  console.log(`[assert-force-rls] OK — ${rows.length} store-scoped tables, all FORCE RLS.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
