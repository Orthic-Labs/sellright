/** Complete pre-enrollment bootstrap journal; source-only, no discarded auth/domain writes. */
import { createHash } from 'node:crypto';
import { open, readdir } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { join } from 'node:path';

type Query = (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, any>[] }>;
const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';
export function createAuthorizationBootstrapSnapshot(options: {
  ownerQuery: Query; runtimeDir: string; providerCalls: readonly unknown[];
}): () => Promise<unknown> {
  async function files(dir: string): Promise<unknown[]> {
    const entries: unknown[] = [];
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : 1)) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error('bootstrap snapshot refuses symlink');
      if (entry.isDirectory()) { entries.push([entry.name, await files(path)]); continue; }
      const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      try { entries.push([entry.name, createHash('sha256').update(await handle.readFile()).digest('hex')]); } finally { await handle.close(); }
    }
    return entries;
  }
  return async () => {
    // Harness verifies privileged fixture-owner role so RLS cannot conceal table rows.
    const tables = (await options.ownerQuery("SELECT schemaname,tablename FROM pg_tables WHERE schemaname NOT LIKE 'pg_%' AND schemaname <> 'information_schema' ORDER BY schemaname,tablename")).rows;
    const args: string[] = [];
    const arms = tables.map(table => {
      args.push(table.schemaname, table.tablename);
      return 'SELECT $' + (args.length - 1) + '::text AS schema,$' + args.length + "::text AS name,COALESCE(jsonb_agg(to_jsonb(t)),'[]'::jsonb) AS entries FROM " + quote(table.schemaname) + '.' + quote(table.tablename) + ' t';
    });
    const captured = arms.length ? (await options.ownerQuery(arms.join(' UNION ALL '), args)).rows : [];
    return {
      data: captured.map(table => [table.schema, table.name, (table.entries as unknown[]).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))]),
      files: await files(options.runtimeDir), providerCalls: structuredClone(options.providerCalls),
    };
  };
}
