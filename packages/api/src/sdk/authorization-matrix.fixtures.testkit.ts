/** Disposable synthetic fixtures shared by core & composed authorization cases. */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readdir, open } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { join } from 'node:path';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { withStore } from '../db/client.js';
import { createSession } from '../auth/session.js';
import { createAdminSession, resolveAdmin } from '../auth/admin-session.js';
import { newAgentToken, hashAgentToken, resolveAgentByToken } from '../auth/admin-api-token.js';
import { hashPassword } from '../auth/password.js';
import { sealTotpSecret } from '../auth/totp-secret.js';
import { assertTestDatabase } from '../db/rls-test-utils.js';
import { PRINCIPALS, type MatrixApp, type MatrixPrincipal } from './authorization-matrix.testkit.js';

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';
export async function createAuthorizationFixtures(options: {
  owner: Pool; app: MatrixApp; databaseUrl: string; runtimeDir: string;
  providerCalls: readonly unknown[]; releaseToken: string; cacheToken: string;
  /** Dedicated bootstrap harness reuses the genuine first administrator; never create a second installation admin. */
  installationAdminId?: string;
  /** Composed plugins bind their deployment store slug before enrollment. */
  storeSlug?: string;
}) {
  assertTestDatabase(options.databaseUrl, 'authorization-matrix.fixtures.testkit.ts');
  const { owner, app } = options;
  const storeId = randomUUID(), foreignStoreId = randomUUID();
  const storeSlug = options.storeSlug ?? `matrix-${randomBytes(6).toString('hex')}`;
  if (!/^[a-z0-9-]+$/.test(storeSlug)) throw new Error('matrix storeSlug must match deployment slug constraints');
  const foreignStoreSlug = `${storeSlug}-foreign`;
  const requestHeaders = {} as Record<MatrixPrincipal, Record<string, string>>;
  const people = new Map<string, { id: string; email: string; token: string; totpSecret: string | null }>();
  const password = `matrix-${randomBytes(24).toString('hex')}`;
  const passwordHash = await hashPassword(password);
  const queryGlobal = (sql: string, values: unknown[] = []) => owner.query(sql, values);
  async function withStoreQuery<T>(id: string, fn: (query: (sql: string, values?: unknown[]) => Promise<{ rows: QueryResultRow[] }>) => Promise<T>): Promise<T> {
    const client: PoolClient = await owner.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_store',$1,true)", [id]);
      const result = await fn((sql, values = []) => client.query(sql, values));
      await client.query('COMMIT');
      return result;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  const queryStore = (id: string, sql: string, values: unknown[] = []) => withStoreQuery(id, query => query(sql, values));
  for (const [id, slug] of [[storeId, storeSlug], [foreignStoreId, foreignStoreSlug]]) {
    await queryStore(id!, `INSERT INTO store(id,slug,name,currency,config) VALUES($1,$2,$3,'USD','{}')`, [id, slug, `Synthetic ${slug}`]);
  }
  // Owner is intentionally NOT installation admin; additional controls keep those grants distinct.
  for (const principal of ['owner', 'manager', 'staff', 'read_only', 'foreign_store', 'installation_admin', 'granted_staff', 'agent']) {
    const reuseBootstrap = principal === 'installation_admin' ? options.installationAdminId : undefined;
    const id = reuseBootstrap ?? randomUUID();
    let email = `${principal}-${storeSlug}@matrix.invalid`;
    const role = principal === 'foreign_store' || principal === 'installation_admin' ? 'owner' : principal === 'granted_staff' || principal === 'agent' ? 'staff' : principal;
    const target = principal === 'foreign_store' ? foreignStoreId : storeId;
    const agent = principal === 'agent';
    if (reuseBootstrap) {
      // Enrollment follows genuine bootstrap qualification. Keep its identity, first-store
      // membership, installation authority & bootstrap session intact.
      const enrolled = (await queryGlobal("UPDATE admin_user SET password_hash=$2,totp_secret=$3 WHERE id=$1 AND kind='human' AND is_installation_admin=true RETURNING email",
        [id, passwordHash, sealTotpSecret(id, 'JBSWY3DPEHPK3PXP')])).rows;
      if (enrolled.length !== 1 || typeof enrolled[0]!.email !== 'string') throw new Error('qualified bootstrap administrator is missing');
      email = enrolled[0]!.email;
    } else {
      await queryGlobal(`INSERT INTO admin_user(id,email,password_hash,kind,totp_secret,is_installation_admin) VALUES($1,$2,$3,$4,$5,$6)`,
        [id, email, agent ? null : passwordHash, agent ? 'agent' : 'human', agent ? null : sealTotpSecret(id, 'JBSWY3DPEHPK3PXP'), principal === 'installation_admin']);
    }
    await queryGlobal(`INSERT INTO admin_user_store(admin_user_id,store_id,role,permissions) VALUES($1,$2,$3,$4)`,
      [id, target, role, JSON.stringify(principal === 'granted_staff' ? { releases: true, refunds: true, discounts: true, licenses: true, customer_verification: true } : {})]);
    let token: string;
    if (agent) {
      token = newAgentToken();
      await queryGlobal(`INSERT INTO admin_api_token(admin_user_id,store_id,name,token_hash,expires_at) VALUES($1,$2,'Synthetic matrix',$3,now()+interval '1 hour')`, [id, target, hashAgentToken(token)]);
      const resolved = await resolveAgentByToken(token);
      if (resolved?.kind !== 'agent' || resolved.stores.length !== 1 || resolved.stores[0]?.storeId !== storeId || resolved.stores[0]?.role !== 'staff') throw new Error('matrix agent binding failed');
    } else {
      token = await createAdminSession(id);
      const resolved = await resolveAdmin(token);
      if (resolved?.kind !== 'human' || !resolved.totpEnabled || !resolved.stores.some(store => store.storeId === target && store.role === role) || resolved.isInstallationAdmin !== (principal === 'installation_admin')) throw new Error('matrix human enrollment failed');
    }
    people.set(principal, { id, email, token, totpSecret: agent ? null : 'JBSWY3DPEHPK3PXP' });
    if ((PRINCIPALS as readonly string[]).includes(principal)) requestHeaders[principal as MatrixPrincipal] = {
      authorization: `Bearer ${token}`, 'x-store-slug': storeSlug, 'content-type': 'application/json',
    };
  }
  requestHeaders.release_service = { authorization: `Bearer ${options.releaseToken}`, 'x-store-slug': storeSlug, 'content-type': 'application/json' };
  requestHeaders.cache_token = { 'x-cache-admin-token': options.cacheToken, 'x-store-slug': storeSlug, 'content-type': 'application/json' };
  const headersFor = (name: string) => ({ authorization: `Bearer ${people.get(name)!.token}`, 'x-store-slug': storeSlug, 'content-type': 'application/json' });
  const identityFor = (principal: string) => {
    const identity = people.get(principal);
    if (!identity) throw new Error('matrix principal has no admin identity: ' + principal);
    return { ...identity, password };
  };
  async function freshIdentity(principal: MatrixPrincipal, settings: { enrolled?: boolean } = {}) {
    if (!['owner', 'manager', 'staff', 'read_only', 'foreign_store'].includes(principal)) throw new Error('fresh matrix identity must be human');
    const id = randomUUID(), email = 'fresh-' + principal + '-' + randomUUID() + '@matrix.invalid';
    const target = principal === 'foreign_store' ? foreignStoreId : storeId;
    const role = principal === 'foreign_store' ? 'owner' : principal;
    const totpSecret = settings.enrolled === false ? null : 'JBSWY3DPEHPK3PXP';
    await queryGlobal("INSERT INTO admin_user(id,email,password_hash,kind,totp_secret,is_installation_admin) VALUES($1,$2,$3,'human',$4,false)",
      [id, email, passwordHash, totpSecret ? sealTotpSecret(id, totpSecret) : null]);
    await queryGlobal("INSERT INTO admin_user_store(admin_user_id,store_id,role,permissions) VALUES($1,$2,$3,'{}')", [id, target, role]);
    const token = await createAdminSession(id);
    return { id, email, password, token, totpSecret, headers: { authorization: 'Bearer ' + token, 'x-store-slug': storeSlug, 'content-type': 'application/json' } };
  }
  async function seedProduct(target = storeId) {
    const productId = randomUUID(), variantId = randomUUID(), unique = randomBytes(8).toString('hex');
    await queryStore(target, `INSERT INTO product(id,store_id,slug,name,status) VALUES($1,$2,$3,$4,'active')`, [productId, target, `matrix-${unique}`, `Matrix ${unique}`]);
    await queryStore(target, `INSERT INTO product_variant(id,store_id,product_id,sku,name,price) VALUES($1,$2,$3,$4,'Matrix variant',2500)`, [variantId, target, productId, `matrix-${unique}`]);
    await queryStore(target, `INSERT INTO stock(store_id,variant_id,on_hand,allocated) VALUES($1,$2,0,0)`, [target, variantId]);
    return { productId, variantId };
  }
  const initialProduct = await seedProduct(), foreignProduct = await seedProduct(foreignStoreId);
  await queryStore(storeId, `UPDATE product SET name='000 authorization matrix sentinel' WHERE id=$1`, [initialProduct.productId]);
  const expectedCustomerId = randomUUID();
  await queryStore(storeId, `INSERT INTO customer(id,store_id,email,first_name,last_name,email_verified) VALUES($1,$2,$3,'Matrix','Customer',true)`, [expectedCustomerId, storeId, `customer-${storeSlug}@matrix.invalid`]);
  const foreignCustomerId = randomUUID();
  await queryStore(foreignStoreId, `INSERT INTO customer(id,store_id,email,first_name,last_name) VALUES($1,$2,$3,'Foreign','Customer')`, [foreignCustomerId, foreignStoreId, `foreign-${storeSlug}@matrix.invalid`]);

  const customerSession = await withStore(storeId, tx => createSession(tx, storeId, expectedCustomerId));
  const customerHeaders = { authorization: `Bearer ${customerSession}`, 'x-store-slug': storeSlug };

  async function files(dir: string): Promise<unknown[]> {
    const out: unknown[] = [];
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : 1)) {
      const file = join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error('matrix file snapshot refuses symlink');
      if (entry.isDirectory()) { out.push([entry.name, await files(file)]); continue; }
      const handle = await open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      try { out.push([entry.name, digest(await handle.readFile())]); } finally { await handle.close(); }
    }
    return out;
  }
  type AuditExpectation = { principal: MatrixPrincipal; method: string; path: string };
  // admin-agent-guard.ts attributes only these admin mutations; ordinary GET
  // denials append no agent row. Keep every GET audit row in the full snapshot.
  const attributedMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
  const expectsAgentAttribution = (expected: AuditExpectation) => expected.principal === 'agent'
    && attributedMethods.has(expected.method) && expected.path.startsWith('/v1/admin/')
    && !['/v1/admin/login', '/v1/admin/logout'].includes(expected.path);
  async function capture(expected?: AuditExpectation) {
    const tables = (await queryGlobal(`SELECT schemaname,tablename FROM pg_tables WHERE schemaname NOT LIKE 'pg_%' AND schemaname <> 'information_schema' ORDER BY schemaname,tablename`)).rows;
    const data: unknown[] = [], matchingAudit = new Map<string, Record<string, unknown>>();
    for (const target of [storeId, foreignStoreId]) await withStoreQuery(target, async query => {
      // One round trip per store context; every table & row remains represented.
      // Each arm still executes under the same real RLS store context.
      const args: string[] = [];
      const arms = tables.map(table => {
        args.push(table.schemaname, table.tablename);
        return `SELECT $${args.length - 1}::text AS schemaname,$${args.length}::text AS tablename,COALESCE(jsonb_agg(to_jsonb(t)),'[]'::jsonb) AS entries FROM ${quote(table.schemaname)}.${quote(table.tablename)} t`;
      });
      const capturedTables = arms.length ? (await query(arms.join(' UNION ALL '), args)).rows : [];
      for (const table of capturedTables) {
        const values: unknown[] = [];
        for (const raw of table.entries as unknown[]) {
          const value = raw as Record<string, unknown>;
          // Exact resolver bookkeeping only. Credential/ACL/expiry/step-up changes remain visible.
          const authenticating = expected ? people.get(expected.principal) : undefined;
          if (table.schemaname === 'public' && table.tablename === 'session' && authenticating && value.token_hash === digest(authenticating.token)) delete value.last_seen_at;
          if (table.schemaname === 'public' && table.tablename === 'admin_api_token' && expected?.principal === 'agent' && value.token_hash === hashAgentToken(people.get('agent')!.token)) delete value.last_used_at;
          const who = people.get('agent');
          if (expected && expectsAgentAttribution(expected) && table.schemaname === 'public' && table.tablename === 'audit_log'
            && value.entity === 'agent' && value.entity_id === who!.id && value.actor === who!.email
            && value.store_id === storeId && (value.action === 'denied' || value.action === 'request')) {
            const details = value.data as Record<string, unknown>;
            if (details.method === expected.method && details.path === expected.path) {
              matchingAudit.set(String(value.id), value); continue;
            }
          }
          values.push(value);
        }
        // Re-sort after normalizing bookkeeping fields, so touch timestamps cannot reorder rows.
        values.sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
        data.push([target, table.schemaname, table.tablename, values]);
      }
    });
    return { value: { data, files: await files(options.runtimeDir), providerCalls: structuredClone(options.providerCalls) }, matchingAudit };
  }
  const snapshot = async () => (await capture()).value;
  function snapshotFor(principal: MatrixPrincipal, method: string, path: string, expectedStatus = 403, expectedAgentGroup?: string) {
    path = new URL(path, 'http://matrix.invalid').pathname;
    let baseline: Map<string, Record<string, unknown>> | undefined;
    return async () => {
      const captured = await capture({ principal, method, path });
      if (expectsAgentAttribution({ principal, method, path })) {
        if (!baseline) baseline = new Map(captured.matchingAudit);
        else {
          for (const [id, row] of baseline) {
            if (JSON.stringify(captured.matchingAudit.get(id)) !== JSON.stringify(row)) throw new Error('matrix denial changed preexisting agent audit');
          }
          const added = [...captured.matchingAudit].filter(([id]) => !baseline!.has(id));
          if (added.length !== 1) throw new Error('matrix denial needs exactly one expected agent attribution');
          const audit = added[0]![1], details = audit.data as Record<string, unknown>;
          if (audit.action === 'request' && details.status !== expectedStatus) throw new Error('matrix denial agent attribution status mismatch');
          if (audit.action === 'denied' && typeof details.group !== 'string') throw new Error('matrix denial agent group missing');
          if (expectedAgentGroup && (audit.action !== 'denied' || details.group !== expectedAgentGroup)) throw new Error('matrix denial agent policy attribution mismatch');
        }
      }
      return captured.value;
    };
  }
  return { storeId, storeSlug, foreignStoreId, foreignStoreSlug, requestHeaders, queryStore,
    withStoreQuery, queryGlobal, snapshot, snapshotFor, seedProduct, identityFor, freshIdentity,
    request: (url: string, init?: RequestInit, bindings?: Record<string, unknown>) => app.request(url, init, bindings),
    expectedAasaAppIds: ['MATRIXTEAM.cc.sellright.matrix'],
    customerHeaders, expectedCustomerEmail: `customer-${storeSlug}@matrix.invalid`, expectedProductId: initialProduct.productId, foreignProductId: foreignProduct.productId, expectedCustomerId, foreignCustomerId,
    positiveControls: { installationAdmin: headersFor('installation_admin'), grantedStaff: headersFor('granted_staff') },
    /** Explicit on-demand step-up: callers must supply a fresh valid TOTP code, not mutate session state. */
    stepUp: (control: 'installation_admin' | 'granted_staff', totp: string) => app.request('/v1/admin/step-up', {
      method: 'POST', headers: headersFor(control), body: JSON.stringify({ password, totp }),
    }),
  };
}
