import { Pool, type PoolClient } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { z } from 'zod';
import * as schema from '../db/schema.js';
import type { Tx } from '../db/client.js';
import { migrationId, type ImportContext } from './context.js';
import { importCatalog } from './catalog.js';
import { importCustomers } from './customers.js';
import { importOrders } from './orders.js';
import { importHistory } from './history.js';
import { importSettings } from './settings.js';
import { canonical, digest, readPrivateJson, writePrivateJson, stageVendureAssets } from './artifacts.js';

export const migrationConfig = z.object({
  storeId: z.string().uuid(), slug: z.string().regex(/^[a-z0-9-]+$/), name: z.string().min(1),
  sourceKey: z.string().min(1), channelId: z.number().int().positive(), currency: z.literal('USD'),
  sourceAssetRoot: z.string().min(1), targetAssetRoot: z.string().min(1),
  storefrontUrl: z.string().url(),
  gatewayAccounts: z.record(z.string(), z.object({ accountId: z.string().min(1), mode: z.enum(['test', 'live']) })),
}).strict();
type Config = z.infer<typeof migrationConfig>;
export const MIGRATION_TABLES = ['asset', 'product', 'product_option_group', 'product_option', 'product_variant', 'variant_option',
  'stock', 'location', 'stock_location', 'promotion', 'collection', 'collection_product', 'product_asset', 'variant_asset',
  'customer', 'address', 'order', 'order_line', 'payment', 'fulfillment', 'fulfillment_line', 'refund', 'refund_line',
  'promotion_usage', 'shipping_method', 'tax_zone'] as const;

/** One source snapshot, one target transaction. No table-wide delete/truncate. */
export async function runMigration(input: {
  sourceUrl: string; targetUrl: string; config: Config; manifestPath: string;
  apply?: boolean; expectedDigest?: string;
}) {
  const config = migrationConfig.parse(input.config);
  const sourceUrl = new URL(input.sourceUrl), targetUrl = new URL(input.targetUrl);
  if (sourceUrl.host === targetUrl.host && sourceUrl.pathname === targetUrl.pathname) throw new Error('Source and target must differ');
  if (input.apply && !input.expectedDigest) throw new Error('Apply requires the reviewed dry-run source digest');
  const sourcePool = new Pool({ connectionString: input.sourceUrl, max: 1 });
  const targetPool = new Pool({ connectionString: input.targetUrl, max: 1 });
  let source: PoolClient | undefined, target: PoolClient | undefined;
  try {
    source = await sourcePool.connect();
    target = await targetPool.connect();
    const snapshot = source;
    await source.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await target.query('BEGIN');
    await target.query("SELECT set_config('app.current_store', $1, true)", [config.storeId]);
    await target.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['migration:' + config.storeId]);
    const beforeStore = (await target.query('SELECT * FROM store WHERE id=$1 FOR UPDATE', [config.storeId])).rows;
    const scopedTables = (await target.query<{ table_name: string }>(`
      SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='store_id'
        AND table_name NOT IN ('admin_user_store','staff_invite','session','processed_event') ORDER BY table_name
    `)).rows.map(row => row.table_name);
    for (const table of scopedTables) {
      if (!/^[a-z_]+$/.test(table)) throw new Error('Unexpected tenant table name');
      const rows = await target.query('SELECT 1 FROM "' + table + '" WHERE store_id=$1 LIMIT 1', [config.storeId]);
      if (rows.rowCount) throw new Error('Target tenant must be empty; use a fresh rehearsal tenant or verified restore: ' + table);
    }
    const sourceReads: unknown[] = [];
    const q: ImportContext['q'] = async (sql, values = []) => {
      const rows = (await snapshot.query(sql, values)).rows;
      sourceReads.push({ sql, values, rows: [...rows].sort((a, b) => canonical(a).localeCompare(canonical(b))) });
      return rows;
    };
    const channels = await q('SELECT id, "defaultCurrencyCode", "pricesIncludeTax" FROM channel ORDER BY id');
    if (channels.length !== 1 || Number(channels[0]!.id) !== config.channelId ||
        channels[0]!.defaultCurrencyCode !== config.currency) {
      throw new Error('Use a dedicated single-channel source snapshot with the selected currency');
    }
    const unresolved = await q(`SELECT id FROM payment WHERE state IN ('Created','Authorized','Pending') LIMIT 1`);
    if (unresolved.length) throw new Error('Resolve source pending/authorized payments before cutover');
    const invalidCurrency = await q('SELECT id FROM "order" WHERE "currencyCode" <> $1 LIMIT 1', [config.currency]);
    if (invalidCurrency.length) throw new Error('Source contains orders in another currency');
    const tx = drizzle(target, { schema, casing: 'snake_case' }) as Tx;
    const configBefore = beforeStore[0]?.config ?? {};
    const storeConfig = { ...configBefore, storefrontUrl: config.storefrontUrl,
      payments: Object.fromEntries(Object.keys(config.gatewayAccounts).map(method => [method, true])),
      paymentAccounts: Object.fromEntries(Object.entries(config.gatewayAccounts).map(([method, account]) => [method, account.accountId])) };
    if (beforeStore[0] && beforeStore[0].slug !== config.slug) throw new Error('Target store identity differs');
    await tx.insert(schema.store).values({ id: config.storeId, slug: config.slug, name: config.name,
      currency: config.currency, taxInclusive: channels[0]!.pricesIncludeTax,
      config: storeConfig,
    }).onConflictDoUpdate({ target: schema.store.id, set: { taxInclusive: channels[0]!.pricesIncludeTax, config: storeConfig } });
    const ctx: ImportContext = { tx, source, q, ...config,
      id: (entity, id) => migrationId(config.storeId, config.sourceKey, entity, id) };
    await importCatalog(ctx);
    await importCustomers(ctx);
    await importOrders(ctx);
    await importHistory(ctx);
    await importSettings(ctx);
    const assetRows = await q('SELECT id, source, preview FROM asset ORDER BY id');
    const assets = await stageVendureAssets(config.sourceAssetRoot, config.targetAssetRoot, config.storeId,
      assetRows as Array<{ id: unknown; source: string; preview: string | null }>, false);
    const sourceDigest = digest({ config, sourceReads, assets });
    if (input.apply && sourceDigest !== input.expectedDigest) throw new Error('Source or migration configuration changed since dry run');
    const after: Record<string, unknown[]> = {};
    for (const table of MIGRATION_TABLES) {
      after[table] = (await target.query('SELECT * FROM "' + table + '" WHERE store_id=$1', [config.storeId])).rows;
    }
    after.store = (await target.query('SELECT * FROM store WHERE id=$1', [config.storeId])).rows;
    const manifest = { version: 1, storeId: config.storeId, sourceKey: config.sourceKey, sourceDigest,
      mode: input.apply ? 'apply' : 'dry-run', commitStatus: 'prepared', createdAt: new Date().toISOString(), before: { store: beforeStore }, after,
      afterDigest: digest(Object.fromEntries(Object.entries(after).map(([table, rows]) =>
        [table, [...rows].sort((a, b) => canonical(a).localeCompare(canonical(b)))]))), assets };
    // Exclusive private file creation must succeed before COMMIT. This manifest
    // contains customer PII/password hashes and must never be a public CI artifact.
    await writePrivateJson(input.manifestPath, manifest);
    if (input.apply) {
      const copied = await stageVendureAssets(config.sourceAssetRoot, config.targetAssetRoot, config.storeId,
        assetRows as Array<{ id: unknown; source: string; preview: string | null }>, true);
      if (digest(copied) !== digest(assets)) throw new Error('Source assets changed during migration');
      await target.query('COMMIT');
    } else await target.query('ROLLBACK');
    await source.query('COMMIT');
    return { applied: !!input.apply, sourceDigest, counts: Object.fromEntries(Object.entries(after).map(([table, rows]) => [table, rows.length])) };
  } catch (error) {
    await target?.query('ROLLBACK').catch(() => undefined);
    await source?.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    source?.release(); target?.release();
    await sourcePool.end(); await targetPool.end();
  }
}

export async function migrationCli() {
  const arg = (name: string) => process.argv[process.argv.indexOf(name) + 1];
  const configPath = process.argv.includes('--config') ? arg('--config') : undefined;
  const manifestPath = process.argv.includes('--manifest') ? arg('--manifest') : undefined;
  if (!configPath || !manifestPath || !process.env.SOURCE_DATABASE_URL || !process.env.DATABASE_URL) {
    throw new Error('Required: --config, --manifest, SOURCE_DATABASE_URL and DATABASE_URL');
  }
  await runMigration({ sourceUrl: process.env.SOURCE_DATABASE_URL, targetUrl: process.env.DATABASE_URL,
    config: migrationConfig.parse(await readPrivateJson(configPath)), manifestPath,
    apply: process.argv.includes('--apply'), expectedDigest: process.argv.includes('--expected-digest') ? arg('--expected-digest') : undefined,
  }).then(result => console.log(JSON.stringify(result))).catch(() => {
    console.error('Migration aborted. Target transaction rolled back; inspect the source/configuration with private diagnostics.');
    process.exitCode = 1;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await migrationCli();
}
