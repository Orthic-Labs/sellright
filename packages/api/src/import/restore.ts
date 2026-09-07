import { Pool } from 'pg';
import { z } from 'zod';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { MIGRATION_TABLES } from './run.js';
import { canonical, digest, readPrivateJson } from './artifacts.js';

const manifestSchema = z.object({
  version: z.literal(1), storeId: z.string().uuid(), sourceKey: z.string(), afterDigest: z.string(),
  before: z.object({ store: z.array(z.record(z.string(), z.unknown())).max(1) }),
  after: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))),
});
/** Restore only an untouched imported tenant. New commerce activity is a hard
 * stop requiring reconciliation; it must never be erased by automatic rollback. */
export async function restoreMigration(input: { targetUrl: string; manifest: unknown; apply?: boolean }) {
  const manifest = manifestSchema.parse(input.manifest);
  const pool = new Pool({ connectionString: input.targetUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_store', $1, true)", [manifest.storeId]);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['migration:' + manifest.storeId]);
    await client.query('SELECT id FROM store WHERE id=$1 FOR UPDATE', [manifest.storeId]);
    const current: Record<string, unknown[]> = {};
    const normalize = (rows: unknown[]) => [...rows].sort((a, b) => canonical(a).localeCompare(canonical(b)));
    const scoped = (await client.query<{ table_name: string }>(`SELECT table_name FROM information_schema.columns
      WHERE table_schema='public' AND column_name='store_id'
      AND table_name NOT IN ('admin_user_store','staff_invite','session','processed_event')`)).rows;
    for (const row of scoped) {
      if (!/^[a-z_]+$/.test(row.table_name)) throw new Error('Unexpected tenant table');
      const data = (await client.query('SELECT * FROM "' + row.table_name + '" WHERE store_id=$1', [manifest.storeId])).rows;
      if (!(MIGRATION_TABLES as readonly string[]).includes(row.table_name) && data.length) {
        throw new Error('New tenant activity prevents restore: ' + row.table_name);
      }
    }
    for (const table of MIGRATION_TABLES) {
      current[table] = normalize((await client.query('SELECT * FROM "' + table + '" WHERE store_id=$1 FOR UPDATE', [manifest.storeId])).rows);
    }
    current.store = normalize((await client.query('SELECT * FROM store WHERE id=$1', [manifest.storeId])).rows);
    if (digest(current) !== manifest.afterDigest ||
        digest(Object.fromEntries(Object.entries(manifest.after).map(([table, rows]) => [table, normalize(rows)]))) !== manifest.afterDigest) {
      throw new Error('Destination or manifest changed; automatic restore refused');
    }
    for (const table of [...MIGRATION_TABLES].reverse()) {
      await client.query('DELETE FROM "' + table + '" WHERE store_id=$1', [manifest.storeId]);
    }
    const before = manifest.before.store[0];
    if (before) {
      if (before.id !== manifest.storeId) throw new Error('Before-image store mismatch');
      const columns = Object.keys(before).filter(key => key !== 'id');
      if (columns.some(key => !/^[a-z_]+$/.test(key))) throw new Error('Invalid before-image columns');
      const list = columns.map(key => '"' + key + '"').join(',');
      await client.query('UPDATE store SET (' + list + ') = (SELECT ' + list +
        ' FROM json_populate_record(NULL::store, $1::json)) WHERE id=$2', [JSON.stringify(before), manifest.storeId]);
    } else await client.query('DELETE FROM store WHERE id=$1', [manifest.storeId]);
    await client.query(input.apply ? 'COMMIT' : 'ROLLBACK');
    return { restored: !!input.apply, storeId: manifest.storeId };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined); throw error;
  } finally { client.release(); await pool.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const index = process.argv.indexOf('--manifest');
  if (index < 0 || !process.argv[index + 1] || !process.env.DATABASE_URL) throw new Error('Required: --manifest and DATABASE_URL');
  restoreMigration({ targetUrl: process.env.DATABASE_URL,
    manifest: await readPrivateJson(process.argv[index + 1]!), apply: process.argv.includes('--apply'),
  }).then(result => console.log(JSON.stringify(result))).catch(() => {
    console.error('Restore refused or rolled back. Preserve the manifest and reconcile destination changes.'); process.exitCode = 1;
  });
}
