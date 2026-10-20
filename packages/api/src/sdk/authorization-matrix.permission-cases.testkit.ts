/** Permission-gated issuance + discount alias coverage; source-only B2.8 fixtures. */
import { randomUUID } from 'node:crypto';
import type { MatrixMutationFixture } from './authorization-matrix.mutation-cases.testkit.js';
import type { MatrixApp, MatrixCase, MatrixCell, MatrixPrincipal, MatrixProof, PreparedMatrixCell } from './authorization-matrix.testkit.js';

export interface MatrixPermissionFixture extends MatrixMutationFixture {
  positiveControls: { grantedStaff: Record<string, string> };
  snapshotFor(principal: MatrixPrincipal, method: string, path: string, expectedStatus?: number, agentGroup?: string): () => Promise<unknown>;
}
type Access = 'write' | 'delete' | 'license' | 'gift-issue' | 'manage';
type Seed = { productId: string; variantId: string; unique: string };
type Prepared = { url: string; body?: unknown; verify(response: Response, proof: MatrixProof): Promise<void> };
const EXPECTED: Record<Access, Record<MatrixPrincipal, number>> = {
  write: { owner: 200, manager: 200, staff: 200, read_only: 403, agent: 200, foreign_store: 403, release_service: 401, cache_token: 401 },
  delete: { owner: 200, manager: 200, staff: 200, read_only: 403, agent: 403, foreign_store: 403, release_service: 401, cache_token: 401 },
  license: { owner: 200, manager: 200, staff: 403, read_only: 403, agent: 403, foreign_store: 403, release_service: 401, cache_token: 401 },
  'gift-issue': { owner: 200, manager: 200, staff: 403, read_only: 403, agent: 403, foreign_store: 403, release_service: 401, cache_token: 401 },
  manage: { owner: 200, manager: 200, staff: 403, read_only: 403, agent: 403, foreign_store: 403, release_service: 401, cache_token: 401 },
};
const actorEmail = (fixture: MatrixPermissionFixture, principal: MatrixPrincipal | 'granted_staff') => `${principal}-${fixture.storeSlug}@matrix.invalid`;
const json = (response: Response) => response.json() as Promise<Record<string, any>>;
const query = async (fixture: MatrixPermissionFixture, sql: string, values: unknown[] = []) => (await fixture.queryStore(fixture.storeId, sql, values)).rows;
const one = async (fixture: MatrixPermissionFixture, sql: string, values: unknown[] = []) => {
  const rows = await query(fixture, sql, values);
  if (rows.length !== 1) throw new Error(`permission matrix fixture expected one row: ${sql}`);
  return rows[0]!;
};
const idResponse = async (response: Response, proof: MatrixProof, id: string) => proof.equal(await json(response), { id }, 'exact discount response');

async function licenseRequest(fixture: MatrixPermissionFixture, expectedActor: string): Promise<Prepared> {
  const unique = randomUUID();
  const body = { appKey: `matrix-app-${unique}`, licenseKey: `MATRIX-${unique}`, seats: 2,
    licenseDurationDays: null, updatesDurationDays: null, reason: `Matrix support grant ${unique}`, metadata: { matrixMarker: unique } };
  return {
    url: '/v1/admin/licenses', body,
    async verify(response, proof) {
      const saved = await one(fixture, 'select id,app_key,license_key,status,source,issued_by,issue_reason,seats,order_id,order_line_id,customer_id,updates_until,expires_at,metadata from license where app_key=$1 and license_key=$2', [body.appKey, body.licenseKey]);
      proof.equal(await json(response), { licenseId: saved.id, licenseKey: body.licenseKey, appKey: body.appKey, seats: 2, updatesUntil: null, expiresAt: null }, 'exact minted license response');
      proof.equal(saved, { id: saved.id, app_key: body.appKey, license_key: body.licenseKey, status: 'active', source: 'admin', issued_by: expectedActor, issue_reason: body.reason,
        seats: 2, order_id: null, order_line_id: null, customer_id: null, updates_until: null, expires_at: null, metadata: body.metadata }, 'orderless license with authenticated issuance provenance committed', 'state');
      proof.equal(await query(fixture, "select actor,data from audit_log where entity='license' and entity_id=$1 and action='mint'", [saved.id]),
        [{ actor: expectedActor, data: { appKey: body.appKey, seats: 2, reason: body.reason, email: null } }], 'mint audit attributes actual session actor once', 'state');
    },
  };
}

export function createPermissionCases(fixture: MatrixPermissionFixture): MatrixCase[] {
  const cases: MatrixCase[] = [];
  const add = (key: string, access: Access, prepare: (seed: Seed, principal: MatrixPrincipal) => Promise<Prepared>) => {
    const method = key.split(' ')[0]!;
    const cell = (principal: MatrixPrincipal): MatrixCell => {
      const status = EXPECTED[access][principal], allow = status === 200;
      const agentGroup = principal === 'agent' ? access === 'delete' ? 'delete' : access === 'license' ? 'entitlement' : undefined : undefined;
      return { effect: allow ? 'allow' : 'deny', status, ...(agentGroup ? { errorCode: 'AGENT_NOT_ALLOWED' } : {}),
        async prepare() {
          const seed = { ...await fixture.seedProduct(), unique: randomUUID() };
          const prepared = await prepare(seed, principal);
          return {
            url: prepared.url,
            init: { method, headers: { ...fixture.requestHeaders[principal], 'content-type': 'application/json' }, ...(prepared.body === undefined ? {} : { body: JSON.stringify(prepared.body) }) },
            ...(allow ? {} : { snapshot: fixture.snapshotFor(principal, method, prepared.url, status, agentGroup) }),
            async verify(response: Response, proof: MatrixProof) {
              if (allow) return prepared.verify(response, proof);
              const body = await json(response);
              if (status === 401) {
                proof.equal(body.error?.code, 'NOT_AUTHENTICATED', 'service/cache credentials cannot authorize admin');
                proof.ok(['not authenticated', 'invalid or expired session'].includes(body.error?.message), 'credential rejection message');
                return;
              }
              if (agentGroup) {
                proof.equal(body.error?.code, 'AGENT_NOT_ALLOWED', 'agent policy denial');
                proof.equal(body.error?.message, agentGroup === 'delete'
                  ? 'agents cannot delete — disable or trash instead; deletion needs a human'
                  : 'agents cannot issue, revoke or release entitlements', 'exact agent denial reason');
                return;
              }
              const role = principal === 'agent' ? 'staff' : principal;
              const message = principal === 'foreign_store' ? `no access to store: ${fixture.storeSlug}`
                : access === 'manage' ? `role '${role}' cannot manage settings/staff`
                : access === 'gift-issue' ? `role '${role}' lacks the 'giftcards' permission`
                : access === 'license' && principal === 'staff' ? "role 'staff' lacks the 'licenses' permission"
                : "role 'read_only' is read-only";
              proof.equal(body.error?.message, message, 'exact store/role/permission denial');
            },
          };
        },
      };
    };
    cases.push({ key, contract: 'admin', cells: { owner: cell('owner'), manager: cell('manager'), staff: cell('staff'), read_only: cell('read_only'),
      agent: cell('agent'), foreign_store: cell('foreign_store'), release_service: cell('release_service'), cache_token: cell('cache_token') } });
  };
  const seedPromotion = async (unique: string) => String((await one(fixture,
    "insert into promotion(store_id,code,type,value,enabled,used_count) values ($1,$2,'percentage',20,true,0) returning id", [fixture.storeId, `MATRIX-${unique}`])).id);
  for (const base of ['/v1/admin/discounts', '/v1/admin/promotions']) {
    add(`POST ${base}`, 'write', async ({ unique }, principal) => {
      const body = { code: `MATRIX-${unique}`, type: 'percentage', value: 15, freeShipping: true, enabled: true, conditions: null, usageLimit: 12 };
      return { url: base, body, async verify(response, proof) {
        const saved = await one(fixture, 'select id,code,type,value,free_shipping,enabled,conditions,usage_limit,used_count from promotion where code=$1', [body.code]);
        await idResponse(response, proof, saved.id);
        proof.equal(saved, { id: saved.id, code: body.code, type: 'percentage', value: 15, free_shipping: true, enabled: true, conditions: null, usage_limit: 12, used_count: 0 }, 'new discount committed', 'state');
        proof.equal(await query(fixture, "select actor,data from audit_log where entity='promotion' and entity_id=$1 and action='create'", [saved.id]),
          [{ actor: actorEmail(fixture, principal), data: { code: body.code } }], 'discount creation actor provenance', 'state');
      } };
    });
    add(`PATCH ${base}/{id}`, 'write', async ({ unique }, principal) => {
      const id = await seedPromotion(unique);
      const url = `${base}/${id}`;
      return { url, body: { value: 35, enabled: false, freeShipping: true }, async verify(response, proof) {
        await idResponse(response, proof, id);
        proof.equal(await one(fixture, 'select type,value,enabled,free_shipping from promotion where id=$1', [id]), { type: 'percentage', value: 35, enabled: false, free_shipping: true }, 'discount patch committed', 'state');
        // Handler has no human entity audit; agent middleware always records attribution.
        if (principal === 'agent') proof.equal(await query(fixture,
          "select actor,data->>'method' as method,data->>'path' as path,(data->>'status')::int as status from audit_log where entity='agent' and actor=$1 and action='request' and data->>'method'='PATCH' and data->>'path'=$2",
          [actorEmail(fixture, principal), url]), [{ actor: actorEmail(fixture, principal), method: 'PATCH', path: url, status: 200 }], 'agent discount patch attribution', 'state');
      } };
    });
    add(`DELETE ${base}/{id}`, 'delete', async ({ unique }) => {
      const id = await seedPromotion(unique);
      return { url: `${base}/${id}`, async verify(response, proof) {
        await idResponse(response, proof, id);
        proof.equal(await query(fixture, 'select id from promotion where id=$1', [id]), [], 'unused discount deleted', 'state');
      } };
    });
  }
  add('POST /v1/admin/licenses', 'license', async (_seed, principal) => licenseRequest(fixture, actorEmail(fixture, principal)));
  add('POST /v1/admin/gift-cards', 'gift-issue', async ({ unique }, principal) => {
    const body = { code: `MATRIX-${unique}`, balance: 3400, expiresAt: null };
    return { url: '/v1/admin/gift-cards', body, async verify(response, proof) {
      const saved = await one(fixture, 'select id,code,initial_balance,balance,enabled,expires_at from gift_card where code=$1', [body.code]);
      proof.equal(await json(response), { id: saved.id, code: body.code }, 'exact gift card response');
      proof.equal(saved, { id: saved.id, code: body.code, initial_balance: 3400, balance: 3400, enabled: true, expires_at: null }, 'human gift card issuance committed', 'state');
      proof.equal(await query(fixture, 'select amount,order_id from gift_card_transaction where gift_card_id=$1', [saved.id]), [{ amount: 3400, order_id: null }], 'gift card issue ledger once', 'state');
      proof.equal(await query(fixture, "select actor,data from audit_log where entity='gift_card' and entity_id=$1 and action='issue'", [saved.id]),
        [{ actor: actorEmail(fixture, principal), data: { balance: 3400, enabled: true } }], 'gift card issuance actor provenance', 'state');
    } };
  });
  add('PATCH /v1/admin/gift-cards/{id}', 'manage', async ({ unique }) => {
    const id = String((await one(fixture, 'insert into gift_card(store_id,code,initial_balance,balance,enabled) values ($1,$2,2000,2000,true) returning id', [fixture.storeId, `MATRIX-${unique}`])).id);
    return { url: `/v1/admin/gift-cards/${id}`, body: { enabled: false, adjust: 600 }, async verify(response, proof) {
      proof.equal(await json(response), { id, balance: 2600 }, 'exact gift card adjustment response');
      proof.equal(await one(fixture, 'select balance,enabled,initial_balance from gift_card where id=$1', [id]), { balance: 2600, enabled: false, initial_balance: 2000 }, 'gift card adjustment committed', 'state');
      proof.equal(await query(fixture, 'select amount,order_id from gift_card_transaction where gift_card_id=$1', [id]), [{ amount: 600, order_id: null }], 'adjustment ledger committed once', 'state');
    } };
  });
  return cases;
}

/** Supplementary control: a real human staff session with explicit licenses grant succeeds. */
export async function assertGrantedStaffLicense(options: {
  app: MatrixApp; fixture: MatrixPermissionFixture; proof: MatrixProof;
}): Promise<void> {
  const { app, fixture, proof } = options;
  await fixture.seedProduct();
  const prepared = await licenseRequest(fixture, actorEmail(fixture, 'granted_staff'));
  const request: PreparedMatrixCell = { ...prepared, init: { method: 'POST', headers: { ...fixture.positiveControls.grantedStaff, 'content-type': 'application/json' }, body: JSON.stringify(prepared.body) } };
  const response = await app.request(request.url, request.init);
  proof.equal(response.status, 200, 'granted staff license issuance succeeds');
  await request.verify(response, proof);
}

