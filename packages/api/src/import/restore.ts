import { Pool } from 'pg';
import { z } from 'zod';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { MIGRATION_TABLES } from './run.js';
import { canonical, digest, readPrivateJson, writePrivateJson } from './artifacts.js';
import { buildRollbackAuthPack, frozenSourceAuthSchema, rollbackExportConfigSchema,
  type FrozenSourceAuth, type RollbackExportConfig } from './rollback-auth.js';
import { legacyRollbackSessionInventory } from './rollback-auth-inventory.js';
import { assertFederatedIssuanceCoverage, RollbackAuthBlocked } from './rollback-auth-artifacts.js';
export { legacyRollbackSessionInventory } from './rollback-auth-inventory.js';

const manifestSchema = z.object({
  version: z.literal(1), storeId: z.string().uuid(), sourceKey: z.string(), afterDigest: z.string(),
  before: z.object({ store: z.array(z.record(z.string(), z.unknown())).max(1) }),
  after: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))),
});
type SnapshotRow = Record<string, unknown>;
const rollbackAccountFields = ['email', 'password_hash', 'email_verified', 'google_sub', 'apple_user_id'] as const;
export interface LegacyRollbackDecision {
  invalidate: boolean;
  expiresAt: string | null;
  accountReconciliationRequired: boolean;
  reason: string;
}
/** A rollback may shorten sessions, but may never restore old account credentials. */
export function legacyRollbackDecision(input: {
  grant: SnapshotRow; importedCustomer?: SnapshotRow; currentCustomer?: SnapshotRow;
  currentGrant?: SnapshotRow; currentSession?: SnapshotRow; now?: number;
}): LegacyRollbackDecision {
  const { grant, importedCustomer, currentCustomer, currentGrant, currentSession } = input;
  const now = input.now ?? Date.now();
  const changedAccount = grant.authenticated === true && (!importedCustomer || !currentCustomer ||
    rollbackAccountFields.some(key => canonical(importedCustomer[key]) !== canonical(currentCustomer[key])));
  if (changedAccount) return { invalidate: true, expiresAt: null, accountReconciliationRequired: true,
    reason: 'Account deleted or authentication details changed; reconcile source account before reopening' };
  if (!currentGrant || ['store_id', 'source_key', 'source_session_id', 'source_user_id', 'source_customer_id', 'authenticated', 'token_hash', 'customer_id', 'session_id']
      .some(key => canonical(currentGrant[key]) !== canonical(grant[key])) ||
      (grant.authenticated === true && (!currentSession || currentGrant.session_id !== grant.session_id ||
        currentSession.id !== grant.session_id || currentSession.store_id !== grant.store_id ||
        currentSession.customer_id !== grant.customer_id || currentSession.token_hash !== grant.token_hash))) {
    return { invalidate: true, expiresAt: null, accountReconciliationRequired: false, reason: 'Target grant or exact imported session revoked' };
  }
  const expiry = Math.min(new Date(String(grant.expires_at)).getTime(), new Date(String(currentGrant.expires_at)).getTime(),
    grant.authenticated === true ? new Date(String(currentSession!.expires_at)).getTime() : Infinity,
    grant.authenticated === true && currentSession!.legacy_expires_at ? new Date(String(currentSession!.legacy_expires_at)).getTime() : Infinity);
  if (!Number.isFinite(expiry) || expiry <= now) return { invalidate: true, expiresAt: null,
    accountReconciliationRequired: false, reason: 'Target or original session expired' };
  return { invalidate: false, expiresAt: new Date(expiry).toISOString(), accountReconciliationRequired: false,
    reason: 'Keep exact original capability with earliest expiry' };
}

/** Read-only operator plan. Source revocations must be applied & verified before rollback routing reopens. */
export async function planLegacySessionRollback(input: { targetUrl: string; manifest: unknown }) {
  const manifest = manifestSchema.parse(input.manifest);
  const normalize = (rows: unknown[]) => [...rows].sort((a, b) => canonical(a).localeCompare(canonical(b)));
  if (digest(Object.fromEntries(Object.entries(manifest.after).map(([table, rows]) => [table, normalize(rows)]))) !== manifest.afterDigest) {
    throw new Error('Manifest changed; rollback plan refused');
  }
  const pool = new Pool({ connectionString: input.targetUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SELECT set_config('app.current_store', $1, true)", [manifest.storeId]);
    const grants = manifest.after.legacy_session_grant ?? [];
    const importedCustomers = new Map<unknown, SnapshotRow>((manifest.after.customer ?? []).map(row => [row.id, row]));
    const currentCustomers = new Map<unknown, SnapshotRow>((await client.query('SELECT * FROM customer WHERE store_id=$1', [manifest.storeId])).rows.map((row: SnapshotRow) => [row.id, row]));
    const accountChanges = [...new Set([...importedCustomers.keys(), ...currentCustomers.keys()])].flatMap(id => {
      const before = importedCustomers.get(id); const current = currentCustomers.get(id);
      if (!before || !current || rollbackAccountFields.some(key => canonical(before[key]) !== canonical(current[key]))) {
        return [{ targetCustomerId: id, reason: !before ? 'New account requires source reconciliation' : !current ? 'Deleted account requires source reconciliation' : 'Account credentials require source reconciliation' }];
      }
      return [];
    });
    const nativeSessions = legacyRollbackSessionInventory({ storeId: manifest.storeId,
      importedSessions: manifest.after.session ?? [],
      currentSessions: (await client.query('SELECT * FROM session WHERE store_id=$1', [manifest.storeId])).rows });
    const actions = [];
    for (const grant of grants) {
      if (grant.store_id !== manifest.storeId || grant.source_key !== manifest.sourceKey) throw new Error('Grant identity differs from manifest');
      const currentGrant = (await client.query('SELECT * FROM legacy_session_grant WHERE id=$1 AND store_id=$2', [grant.id, manifest.storeId])).rows[0];
      const currentSession = grant.session_id ? (await client.query('SELECT * FROM session WHERE id=$1 AND store_id=$2', [grant.session_id, manifest.storeId])).rows[0] : undefined;
      const currentCustomer = currentCustomers.get(grant.customer_id);
      const importedCustomer = importedCustomers.get(grant.customer_id);
      actions.push({ sourceKey: manifest.sourceKey, sourceSessionId: grant.source_session_id,
        expectedTokenHash: grant.token_hash, sourceUserId: grant.source_user_id,
        ...legacyRollbackDecision({ grant, importedCustomer, currentCustomer, currentGrant, currentSession }) });
    }
    await client.query('ROLLBACK');
    return { storeId: manifest.storeId, sourceKey: manifest.sourceKey, actions,
      accountChanges, accountReconciliationRequired: accountChanges.length > 0 || actions.some(action => action.accountReconciliationRequired),
      nativeSessions, nativeSessionReconciliationRequired: nativeSessions.some(row => row.sourceBridgeRequired),
      sourceReconciliationRequired: true, readyToReopen: false };
  } finally { await client.query('ROLLBACK').catch(() => undefined); client.release(); await pool.end(); }
}

/** Export auth authority from one final read-only target snapshot. No source connection exists here. */
export async function exportRollbackAuthPack(input: {
  targetUrl: string; manifest: unknown; config: RollbackExportConfig; frozenSource: FrozenSourceAuth; outputPath: string;
}) {
  const manifest = manifestSchema.parse(input.manifest);
  const config = rollbackExportConfigSchema.parse(input.config);
  const frozenSource = frozenSourceAuthSchema.parse(input.frozenSource);
  const normalize = (rows: unknown[]) => [...rows].sort((a, b) => canonical(a).localeCompare(canonical(b)));
  if (digest(Object.fromEntries(Object.entries(manifest.after).map(([table, rows]) => [table, normalize(rows)]))) !== manifest.afterDigest) {
    throw new Error('Original import snapshot digest mismatch');
  }
  const pool = new Pool({ connectionString: input.targetUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SELECT set_config('app.current_store', $1, true)", [manifest.storeId]);
    const customers = (await client.query('SELECT * FROM customer WHERE store_id=$1 ORDER BY id', [manifest.storeId])).rows;
    const sessions = (await client.query(`SELECT id, store_id, customer_id, admin_user_id, api_token_id,
      token_hash, expires_at, legacy_expires_at FROM session WHERE store_id=$1 ORDER BY id`, [manifest.storeId])).rows;
    const grants = (await client.query('SELECT * FROM legacy_session_grant WHERE store_id=$1 ORDER BY id', [manifest.storeId])).rows;
    const pendingArtifacts = (await client.query(`SELECT id, store_id, customer_id, kind, token_hash, expires_at, used_at
      FROM customer_token WHERE store_id=$1 ORDER BY id`, [manifest.storeId])).rows;
    const federatedIssuances = (await client.query<{ id: unknown; payload: unknown }>(
      "SELECT id, payload FROM email_outbox WHERE store_id=$1 AND kind='federated_link_confirm' ORDER BY id", [manifest.storeId])).rows;
    assertFederatedIssuanceCoverage({ storeId: manifest.storeId, rows: federatedIssuances, now: Date.now() });
    const pack = buildRollbackAuthPack({ manifest: input.manifest, config, frozenSource, customers, sessions, grants, pendingArtifacts });
    await client.query('ROLLBACK');
    await writePrivateJson(input.outputPath, pack);
    return { schema: pack.schema, cloneId: pack.cloneId, packDigest: pack.packDigest,
      targetAuthDigest: pack.pins.finalTargetAuthDigest, accounts: pack.accounts.length, aliases: pack.aliases.length,
      tombstones: pack.tombstones.length, pendingAuthArtifacts: pack.pendingAuthArtifacts.length, readyToReopen: false };
  } finally { await client.query('ROLLBACK').catch(() => undefined); client.release(); await pool.end(); }
}

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
      AND table_name NOT IN ('admin_user_store','staff_invite','processed_event')`)).rows;
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
  const manifest = await readPrivateJson(process.argv[index + 1]!);
  const exportAuth = process.argv.includes('--export-auth-rollback');
  if (exportAuth && (process.argv.includes('--apply') || process.argv.includes('--plan-session-rollback'))) throw new Error('Auth export must run alone');
  const arg = (flag: string): string => {
    const at = process.argv.indexOf(flag);
    if (at < 0 || !process.argv[at + 1]) throw new Error('Missing rollback export input');
    return process.argv[at + 1]!;
  };
  const operation = exportAuth
    ? exportRollbackAuthPack({ targetUrl: process.env.DATABASE_URL, manifest,
      config: rollbackExportConfigSchema.parse(await readPrivateJson(arg('--rollback-config'))),
      frozenSource: frozenSourceAuthSchema.parse(await readPrivateJson(arg('--frozen-source'))), outputPath: arg('--output') })
    : process.argv.includes('--plan-session-rollback')
    ? planLegacySessionRollback({ targetUrl: process.env.DATABASE_URL, manifest })
    : restoreMigration({ targetUrl: process.env.DATABASE_URL, manifest, apply: process.argv.includes('--apply') });
  operation.then(result => console.log(JSON.stringify(result))).catch(error => {
    if (error instanceof RollbackAuthBlocked) console.error(JSON.stringify({ code: error.code, entityId: error.entityId }));
    console.error('Restore refused or rolled back. Preserve the manifest and reconcile destination changes.'); process.exitCode = 1;
  });
}
