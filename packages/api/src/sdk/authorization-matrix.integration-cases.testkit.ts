/** Source-only route-by-principal contracts for integrations, downloads & affiliate accounting. */
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import type { MatrixMutationFixture } from './authorization-matrix.mutation-cases.testkit.js';
import type { MatrixCase, MatrixCell, MatrixPrincipal, MatrixProof } from './authorization-matrix.testkit.js';

export interface MatrixIntegrationFixture extends MatrixMutationFixture {
  snapshotFor(principal: MatrixPrincipal, method: string, path: string, expectedStatus?: number, agentGroup?: string): () => Promise<unknown>;
}
type Access = 'read' | 'write' | 'webhook-create' | 'manage' | 'payout';
type Seed = { productId: string; variantId: string; unique: string };
type Prepared = { url: string; body?: unknown; verify(response: Response, proof: MatrixProof): Promise<void> };
const EXPECTED: Record<Access, Record<MatrixPrincipal, number>> = {
  read: { owner: 200, manager: 200, staff: 200, read_only: 200, agent: 200, foreign_store: 403, release_service: 401, cache_token: 401 },
  write: { owner: 200, manager: 200, staff: 200, read_only: 403, agent: 200, foreign_store: 403, release_service: 401, cache_token: 401 },
  'webhook-create': { owner: 200, manager: 200, staff: 403, read_only: 403, agent: 403, foreign_store: 403, release_service: 401, cache_token: 401 },
  manage: { owner: 200, manager: 200, staff: 403, read_only: 403, agent: 403, foreign_store: 403, release_service: 401, cache_token: 401 },
  payout: { owner: 200, manager: 200, staff: 403, read_only: 403, agent: 403, foreign_store: 403, release_service: 401, cache_token: 401 },
};
const actor = (f: MatrixIntegrationFixture, p: MatrixPrincipal) => `${p}-${f.storeSlug}@matrix.invalid`;
const json = (r: Response) => r.json() as Promise<Record<string, any>>;
const iso = (value: unknown) => new Date(value as string).toISOString();
const query = async (f: MatrixIntegrationFixture, sql: string, values: unknown[] = []) => (await f.queryStore(f.storeId, sql, values)).rows;
const one = async (f: MatrixIntegrationFixture, sql: string, values: unknown[] = []) => {
  const rows = await query(f, sql, values);
  if (rows.length !== 1) throw new Error('integration fixture expected exactly one row: ' + sql);
  return rows[0]!;
};
const csvCell = (value: unknown) => {
  let text = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
  return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
};
const csv = (header: string[], rows: unknown[][], trailing = false) =>
  [header.join(','), ...rows.map(row => row.map(csvCell).join(','))].join('\n') + (trailing ? '\n' : '');
const secretShape = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{48}$/.test(value);

const COLUMN_GROUPS: Array<[string, Array<[string, string]>]> = [
  ['Order', [['code', 'Order'], ['date', 'Date']]],
  ['Customer', [['email', 'Email'], ['customerName', 'Customer name']]],
  ['Status', [['state', 'Internal state'], ['paymentStatus', 'Payment status'], ['fulfillmentStatus', 'Fulfillment status'], ['orderStatus', 'Order status']]],
  ['Order', [['preOrder', 'Pre-order']]],
  ['Status', [['fulfillment', 'Latest fulfillment state']]],
  ['Shipping', [['tracking', 'Tracking']]],
  ['Order', [['paymentMethod', 'Payment method']]],
  ['Shipping', [['shippingMethod', 'Shipping method']]],
  ['Order', [['coupon', 'Coupon']]],
  ['Money', [['subtotal', 'Subtotal'], ['discount', 'Discount'], ['shipping', 'Shipping'], ['tax', 'Tax'], ['total', 'Total'], ['currency', 'Currency']]],
  ['Shipping', [['shipName', 'Ship to name'], ['shipLine1', 'Ship to address 1'], ['shipLine2', 'Ship to address 2'], ['shipCity', 'Ship to city'], ['shipRegion', 'Ship to state/region'], ['shipPostal', 'Ship to postal code'], ['country', 'Ship to country'], ['phone', 'Ship to phone']]],
  ['Line item', [['sku', 'SKU'], ['item', 'Item'], ['quantity', 'Quantity'], ['unitPrice', 'Unit price'], ['lineDiscount', 'Line discount'], ['lineTotal', 'Line total']]],
];
const CATALOG = COLUMN_GROUPS.flatMap(([group, items]) => items.map(([key, label]) => ({ key, label, group, lineOnly: group === 'Line item' })));

export function createIntegrationCases(fixture: MatrixIntegrationFixture): MatrixCase[] {
  const cases: MatrixCase[] = [];
  const add = (key: string, access: Access, prepare: (seed: Seed, principal: MatrixPrincipal) => Promise<Prepared>, hardGroup?: 'credentials' | 'delete' | 'money_out', plainErrors = false) => {
    const method = key.split(' ')[0]!;
    const cell = (principal: MatrixPrincipal): MatrixCell => {
      const status = EXPECTED[access][principal], allowed = status === 200;
      const agentGroup = principal === 'agent' && !allowed ? hardGroup : undefined;
      return { effect: allowed ? 'allow' : 'deny', status, ...(agentGroup ? { errorCode: 'AGENT_NOT_ALLOWED' } : {}),
        async prepare() {
          const prepared = await prepare({ ...await fixture.seedProduct(), unique: randomUUID() }, principal);
          return { url: prepared.url,
            init: { method, headers: { ...fixture.requestHeaders[principal], 'content-type': 'application/json' }, ...(prepared.body === undefined ? {} : { body: JSON.stringify(prepared.body) }) },
            ...(allowed ? {} : { snapshot: fixture.snapshotFor(principal, method, prepared.url, status, agentGroup) }),
            async verify(response: Response, proof: MatrixProof) {
              if (allowed) return prepared.verify(response, proof);
              const body = await json(response), message = typeof body.error === 'string' ? body.error : body.error?.message;
              if (status === 401) {
                if (typeof body.error === 'string') proof.ok(plainErrors && principal === 'cache_token', 'only plain order-export handler exposes a string auth error');
                else proof.equal(body.error?.code, 'NOT_AUTHENTICATED', 'service/cache credential rejection code');
                proof.ok(['not authenticated', 'invalid or expired session'].includes(message), 'explicit admin credential rejection reason');
                return;
              }
              if (agentGroup) {
                proof.equal(body.error?.code, 'AGENT_NOT_ALLOWED', 'hard agent policy code');
                proof.equal(message, agentGroup === 'credentials' ? 'agents cannot change credentials or payment/e-mail secrets'
                  : agentGroup === 'delete' ? 'agents cannot delete — disable or trash instead; deletion needs a human'
                  : 'agents cannot move money out of the store', 'exact agent policy reason');
                return;
              }
              const role = principal === 'agent' ? 'staff' : principal;
              const expected = principal === 'foreign_store' ? `no access to store: ${fixture.storeSlug}`
                : access === 'webhook-create' ? `role '${role}' lacks the 'webhooks' permission`
                : access === 'manage' ? `role '${role}' cannot manage settings/staff`
                : access === 'payout' && principal === 'staff' ? "role 'staff' lacks the 'affiliate_payouts' permission"
                : "role 'read_only' is read-only";
              proof.equal(message, expected, 'exact store/role/permission denial');
              if (typeof body.error === 'string') proof.ok(plainErrors && principal === 'foreign_store', 'plain error shape belongs to order export store guard');
            },
          };
        },
      };
    };
    cases.push({ key, contract: 'admin', cells: { owner: cell('owner'), manager: cell('manager'), staff: cell('staff'), read_only: cell('read_only'),
      agent: cell('agent'), foreign_store: cell('foreign_store'), release_service: cell('release_service'), cache_token: cell('cache_token') } });
  };
  const audit = async (proof: MatrixProof, principal: MatrixPrincipal, entity: string, id: string | null, action: string, data: unknown) =>
    proof.equal(await query(fixture, 'select actor,data from audit_log where entity=$1 and entity_id is not distinct from $2::text and action=$3' + (id == null ? ' and data=$4::jsonb' : ''),
      id == null ? [entity, id, action, JSON.stringify(data)] : [entity, id, action]), [{ actor: actor(fixture, principal), data }], 'committed audit attributes authenticated actor', 'state');
  const promotion = async (unique: string) => {
    const code = 'MX' + unique.replace(/-/g, '').slice(0, 22).toUpperCase();
    const saved = await one(fixture, "insert into promotion(store_id,code,type,value,enabled) values ($1,$2,'percentage',20,true) returning id", [fixture.storeId, code]);
    return { id: String(saved.id), code };
  };
  const affiliate = async (unique: string) => {
    const promo = await promotion(unique), email = 'affiliate-' + unique + '@matrix.invalid';
    const token = unique.replace(/-/g, '') + unique.replace(/-/g, '').slice(0, 16);
    const row = await one(fixture, 'insert into affiliate(store_id,promotion_id,email,access_token) values ($1,$2,$3,$4) returning id', [fixture.storeId, promo.id, email, token]);
    return { id: String(row.id), promotionId: promo.id, code: promo.code, email, token };
  };
  const paidOrder = async (unique: string, promotionId: string | null = null) => {
    const code = 'MATRIX-' + unique;
    const row = await one(fixture, 'insert into "order"(store_id,code,state,currency,subtotal,discount_total,grand_total,promotion_id,placed_at) values ($1,$2,\'Paid\',\'USD\',10000,0,10000,$3,now()) returning id,created_at,placed_at', [fixture.storeId, code, promotionId]);
    return { id: String(row.id), code, createdAt: iso(row.created_at), placedAt: iso(row.placed_at) };
  };
  const mail = async (proof: MatrixProof, email: string, kind: 'welcome' | 'rotation', suffix: string, token: string, code: string) => {
    const rows = await query(fixture, 'select kind,recipient,dedupe_key,status,payload from email_outbox where dedupe_key=$1', ['affiliate_' + kind + ':' + suffix]);
    proof.equal(rows.length, 1, 'exactly one transactional affiliate mail', 'state');
    const saved = rows[0]!;
    proof.equal({ kind: saved.kind, recipient: saved.recipient, dedupe_key: saved.dedupe_key, status: saved.status },
      { kind: 'affiliate_' + kind, recipient: email, dedupe_key: 'affiliate_' + kind + ':' + suffix, status: 'pending' }, 'recipient & mail intent committed', 'state');
    proof.equal(saved.payload.to, email, 'outbox destination matches affiliate', 'state');
    proof.ok(String(saved.payload.html).includes(token) && String(saved.payload.text).includes(token), 'mail contains current token only', 'state');
    proof.ok(String(saved.payload.html).includes(code) && String(saved.payload.text).includes(code), 'mail contains correct affiliate code', 'state');
  };

  add('POST /v1/admin/webhooks', 'webhook-create', async ({ unique }, principal) => {
    const url = 'https://8.8.8.8/matrix/' + unique, topics = ['order.paid'];
    return { url: '/v1/admin/webhooks', body: { url, topics }, async verify(response: Response, proof: MatrixProof) {
      const body = await json(response);
      proof.ok(secretShape(body.secret), 'one-time secret has 24 random bytes encoded as hex');
      const row = await one(fixture, 'select id,url,topics,secret,enabled from webhook_endpoint where url=$1', [url]);
      proof.equal(body, { id: row.id, secret: row.secret }, 'exact one-time webhook signing secret response');
      proof.equal(row, { id: row.id, url, topics, secret: body.secret, enabled: true }, 'secret & endpoint persisted together', 'state');
      await audit(proof, principal, 'webhook_endpoint', row.id, 'create', { url, topics });
      proof.equal(await query(fixture, 'select id from webhook_delivery where endpoint_id=$1', [row.id]), [], 'endpoint registration sends no webhook', 'state');
    } };
  }, 'credentials');
  for (const method of ['PATCH', 'DELETE']) add(method + ' /v1/admin/webhooks/{id}', 'manage', async ({ unique }, principal) => {
    const url = 'https://8.8.8.8/matrix/' + unique, secret = unique.replace(/-/g, '').repeat(2).slice(0, 48);
    const row = await one(fixture, "insert into webhook_endpoint(store_id,url,topics,secret) values ($1,$2,array['order.created'],$3) returning id", [fixture.storeId, url, secret]);
    const id = String(row.id);
    if (method === 'DELETE') await query(fixture, "insert into webhook_delivery(store_id,endpoint_id,topic,payload) values ($1,$2,'order.created',$3::jsonb)", [fixture.storeId, id, JSON.stringify({ marker: unique })]);
    const body = { topics: ['order.paid'], enabled: false };
    return { url: '/v1/admin/webhooks/' + id, ...(method === 'PATCH' ? { body } : {}), async verify(response: Response, proof: MatrixProof) {
      proof.equal(await json(response), { id }, 'exact webhook mutation response');
      if (method === 'PATCH') {
        proof.equal(await one(fixture, 'select url,topics,secret,enabled from webhook_endpoint where id=$1', [id]), { url, topics: body.topics, secret, enabled: false }, 'patch preserves signing secret & commits disabled topic configuration', 'state');
        await audit(proof, principal, 'webhook_endpoint', id, 'update', { before: { url, topics: ['order.created'], enabled: true }, after: body });
      } else {
        proof.equal(await query(fixture, 'select id from webhook_endpoint where id=$1', [id]), [], 'endpoint removed', 'state');
        proof.equal(await query(fixture, 'select id from webhook_delivery where endpoint_id=$1', [id]), [], 'queued deliveries removed with endpoint', 'state');
        await audit(proof, principal, 'webhook_endpoint', id, 'delete', { url });
      }
    } };
  }, method === 'DELETE' ? 'delete' : 'credentials');

  add('GET /v1/admin/export/products.csv', 'read', async ({ productId }) => {
    const rows = await query(fixture, 'select p.slug,p.name,p.status,v.sku,v.price,v.sale_price,v.barcode from product p left join product_variant v on v.product_id=p.id and v.store_id=$1 and v.deleted_at is null where p.store_id=$1 and p.deleted_at is null order by p.name', [fixture.storeId]);
    if (!rows.some(row => row.slug != null)) throw new Error('product export fixture has no data');
    const target = await one(fixture, 'select slug from product where id=$1', [productId]);
    return { url: '/v1/admin/export/products.csv', async verify(response: Response, proof: MatrixProof) {
      proof.equal(response.headers.get('content-disposition'), 'attachment; filename="products.csv"', 'product export filename');
      proof.equal(response.headers.get('content-type'), 'text/csv', 'product CSV media type');
      const text = await response.text();
      proof.equal(text, csv(['slug', 'name', 'status', 'sku', 'price', 'salePrice', 'barcode'], rows.map(r => [r.slug,r.name,r.status,r.sku,r.price,r.sale_price,r.barcode])), 'complete tenant product export');
      proof.ok(text.includes(target.slug), 'fresh existing target appears in product download');
    } };
  });
  add('GET /v1/admin/export/customers.csv', 'read', async ({ unique }) => {
    const email = 'export-' + unique + '@matrix.invalid';
    await query(fixture, 'insert into customer(store_id,email,first_name,last_name,email_verified) values ($1,$2,$3,$4,true)', [fixture.storeId,email,'=Matrix','Export']);
    const rows = await query(fixture, 'select email,first_name,last_name,phone,email_verified,created_at from customer where store_id=$1 and deleted_at is null order by created_at desc', [fixture.storeId]);
    return { url: '/v1/admin/export/customers.csv', async verify(response: Response, proof: MatrixProof) {
      proof.equal(response.headers.get('content-disposition'), 'attachment; filename="customers.csv"', 'customer export filename');
      proof.equal(response.headers.get('content-type'), 'text/csv', 'customer CSV media type');
      proof.equal(await response.text(), csv(['email','firstName','lastName','phone','emailVerified','createdAt'], rows.map(r => [r.email,r.first_name,r.last_name,r.phone,r.email_verified,iso(r.created_at)])), 'complete tenant customer export with literal formula text');
    } };
  });
  add('GET /v1/admin/export/orders/columns', 'read', async () => ({ url: '/v1/admin/export/orders/columns', async verify(response: Response, proof: MatrixProof) {
    proof.equal(await json(response), { columns: CATALOG,
      defaults: ['code','date','email','state','preOrder','fulfillment','tracking','subtotal','discount','shipping','tax','total','currency'],
      lineDefaults: ['sku','item','quantity','unitPrice','lineTotal'], cap: 50000 }, 'exact downloadable order-column contract');
  } }), undefined, true);
  for (const suffix of ['', '.xlsx']) add('GET /v1/admin/export/orders' + suffix, 'read', async ({ unique }) => {
    const order = await paidOrder(unique);
    return { url: '/v1/admin/export/orders' + suffix + '?columns=code,total,currency&q=' + order.code, async verify(response: Response, proof: MatrixProof) {
      proof.equal(response.headers.get('content-disposition'), 'attachment; filename="orders-' + fixture.storeSlug + (suffix || '.csv') + '"', 'tenant order download filename');
      proof.equal(response.headers.get('x-export-rows'), '1', 'one matching fresh paid order');
      proof.equal(response.headers.get('x-export-capped'), '0', 'export not capped');
      if (!suffix) {
        proof.equal(response.headers.get('content-type'), 'text/csv; charset=utf-8', 'order CSV media type');
        proof.equal(await response.text(), 'code,total,currency\n' + order.code + ',100.00,USD', 'exact selected order CSV fields');
      } else {
        proof.equal(response.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'real XLSX media type');
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(Buffer.from(await response.arrayBuffer()) as any);
        proof.equal(workbook.worksheets.map(sheet => sheet.name), ['Orders'], 'one order worksheet');
        const sheet = workbook.getWorksheet('Orders')!;
        proof.equal(sheet.rowCount, 2, 'exact workbook row count');
        proof.equal(sheet.columnCount, 3, 'exact workbook column count');
        proof.equal([sheet.getCell('A1').value,sheet.getCell('B1').value,sheet.getCell('C1').value], ['code','total','currency'], 'exact workbook headers');
        proof.equal([sheet.getCell('A2').value,sheet.getCell('B2').value,sheet.getCell('C2').value], [order.code,100,'USD'], 'actual selected paid-order workbook values');
      }
    } };
  }, undefined, true);
  add('GET /v1/admin/subscribers/export', 'read', async ({ unique }, principal) => {
    const email = 'subscriber-' + unique + '@matrix.invalid', name = '=Matrix, Export', topic = 'matrix-' + unique;
    const row = await one(fixture, "insert into subscriber(store_id,email,name,kind,topic,status,source,confirmed_at) values ($1,$2,$3,'newsletter',$4,'confirmed','api','2002-03-04T00:00:00Z') returning confirmed_at::text,created_at::text", [fixture.storeId,email,name,topic]);
    return { url: '/v1/admin/subscribers/export?kind=newsletter&status=confirmed&topic=' + topic, async verify(response: Response, proof: MatrixProof) {
      proof.equal(response.headers.get('content-disposition'), 'attachment; filename="subscribers-' + fixture.storeSlug + '.csv"', 'subscriber CSV filename');
      proof.equal(response.headers.get('content-type'), 'text/csv; charset=utf-8', 'subscriber CSV media type');
      proof.equal(await response.text(), csv(['email','name','kind','topic','status','source','confirmed_at','unsubscribed_at','created_at'],
        [[email,name,'newsletter',topic,'confirmed','api',row.confirmed_at,null,row.created_at]], true), 'exact filtered subscriber export & formula-safe name');
      await audit(proof, principal, 'subscriber', null, 'export', { kind: 'newsletter', topic, status: 'confirmed', rows: 1 });
    } };
  });
  add('GET /v1/admin/waitlist/report.csv', 'read', async ({ unique, productId, variantId }) => {
    // Reserve an otherwise empty historical UTC day so each cell has one independent aggregate.
    let day = '';
    for (let attempt = 0; attempt < 100; attempt++) {
      const date = new Date(Date.UTC(1900,0,1) + (Number.parseInt(randomUUID().slice(0,8),16) % 35000) * 86400000);
      day = date.toISOString().slice(0,10);
      const count = await one(fixture, "select (select count(*) from subscriber where created_at >= $1::timestamptz and created_at < $1::timestamptz+interval '1 day')::int + (select count(*) from restock_request where created_at >= $1::timestamptz and created_at < $1::timestamptz+interval '1 day')::int as n", [day]);
      if (Number(count.n) === 0) break;
      day = '';
    }
    if (!day) throw new Error('could not reserve isolated waitlist fixture date');
    const at = day + 'T12:00:00.000Z';
    await query(fixture, "insert into subscriber(store_id,email,kind,topic,status,source,created_at,confirmed_at) values ($1,$2,'waitlist',$3,'confirmed','api',$4,$4)", [fixture.storeId,'waitlist-' + unique + '@matrix.invalid','restock:' + variantId,at]);
    const product = await one(fixture, 'select p.name,v.name as variant_name,v.sku,st.on_hand-st.allocated as available from product p join product_variant v on v.product_id=p.id join stock st on st.variant_id=v.id where p.id=$1 and v.id=$2', [productId,variantId]);
    return { url: '/v1/admin/waitlist/report.csv?groupBy=variant&from=' + day + '&to=' + day, async verify(response: Response, proof: MatrixProof) {
      proof.equal(response.headers.get('content-disposition'), 'attachment; filename="waitlist-demand-variant.csv"', 'waitlist report filename');
      proof.equal(response.headers.get('content-type'), 'text/csv; charset=utf-8', 'waitlist CSV media type');
      proof.equal(await response.text(), csv(['Product','Variant','SKU','Waiting now','Notified','Canceled','Unconfirmed','Legacy closed','Total signups','In stock now','Oldest waiting','Latest signup'],
        [[product.name,product.variant_name,product.sku,1,0,0,0,0,1,product.available,at,at]], true), 'exact fresh variant waitlist aggregate');
    } };
  });

  for (const base of ['/v1/admin/discounts','/v1/admin/promotions']) add('GET ' + base + '/{id}', 'read', async ({ unique }) => {
    const promo = await promotion(unique);
    return { url: base + '/' + promo.id, async verify(response: Response, proof: MatrixProof) {
      proof.equal(await json(response), { id: promo.id, code: promo.code, type: 'percentage', value: 20, freeShipping: false, conditions: null, enabled: true,
        usedCount: 0, usageLimit: null, perCustomerUsageLimit: null, startsAt: null, endsAt: null, usage: [] }, 'exact existing tenant discount detail');
    } };
  });
  add('GET /v1/admin/affiliates/{id}', 'read', async ({ unique }) => {
    const aff = await affiliate(unique), order = await paidOrder(unique, aff.promotionId);
    return { url: '/v1/admin/affiliates/' + aff.id, async verify(response: Response, proof: MatrixProof) {
      proof.equal(await json(response), { id: aff.id, email: aff.email, code: aff.code, accessToken: aff.token, commissionPct: 10,
        earned: 1000, settled: 0, unsettled: 1000, subtotals: 10000,
        orders: [{ code: order.code, subtotal: 10000, state: 'Paid', placedAt: order.placedAt, createdAt: order.createdAt, commission: 1000 }], settlements: [] }, 'exact affiliate detail with attributed paid order');
    } };
  });
  add('GET /v1/admin/affiliates/{id}/stats', 'read', async ({ unique }) => {
    const aff = await affiliate(unique);
    await paidOrder(unique, aff.promotionId);
    return { url: '/v1/admin/affiliates/' + aff.id + '/stats', async verify(response: Response, proof: MatrixProof) {
      proof.equal(await json(response), { range: { from: null, to: null }, totals: { orders: 1, units: 0, revenue: 10000, commission: 1000 }, bySku: [], commissionPct: 10 }, 'affiliate statistics count paid order with no surviving lines');
    } };
  });
  add('POST /v1/admin/affiliates', 'write', async ({ unique }, principal) => {
    const email = 'new-affiliate-' + unique + '@matrix.invalid', code = 'MX' + unique.replace(/-/g,'').slice(0,22).toUpperCase();
    return { url: '/v1/admin/affiliates', body: { email, code, discountPct: 15 }, async verify(response: Response, proof: MatrixProof) {
      const body = await json(response), saved = await one(fixture, 'select a.id,a.email,a.access_token,p.code,p.type,p.value,p.enabled from affiliate a join promotion p on p.id=a.promotion_id where a.email=$1', [email]);
      proof.ok(secretShape(body.accessToken), 'new private affiliate dashboard token');
      proof.equal(body, { id: saved.id, code, accessToken: saved.access_token }, 'exact affiliate registration response');
      proof.equal(saved, { id: saved.id, email, access_token: body.accessToken, code, type: 'percentage', value: 15, enabled: true }, 'coupon & affiliate committed atomically', 'state');
      await audit(proof, principal, 'affiliate', saved.id, 'onboard', { email, code });
      await mail(proof, email, 'welcome', saved.id, saved.access_token, code);
    } };
  });
  add('PATCH /v1/admin/affiliates/{id}', 'write', async ({ unique }, principal) => {
    const aff = await affiliate(unique), email = 'reassigned-' + unique + '@matrix.invalid';
    return { url: '/v1/admin/affiliates/' + aff.id, body: { email }, async verify(response: Response, proof: MatrixProof) {
      proof.equal(await json(response), { id: aff.id, email, code: aff.code }, 'exact affiliate reassignment response');
      const saved = await one(fixture, 'select email,access_token,promotion_id from affiliate where id=$1', [aff.id]);
      proof.ok(secretShape(saved.access_token) && saved.access_token !== aff.token, 'old dashboard token replaced', 'state');
      proof.equal(saved, { email, access_token: saved.access_token, promotion_id: aff.promotionId }, 'recipient change preserves promotion attribution', 'state');
      await audit(proof, principal, 'affiliate', aff.id, 'rotate', { from: aff.email, to: email, code: aff.code });
      await mail(proof, email, 'rotation', aff.id + ':' + email, saved.access_token, aff.code);
      const outbox = await one(fixture, 'select payload from email_outbox where dedupe_key=$1', ['affiliate_rotation:' + aff.id + ':' + email]);
      proof.ok(!String(outbox.payload.html).includes(aff.token) && !String(outbox.payload.text).includes(aff.token), 'rotation mail excludes old recipient token', 'state');
    } };
  });
  add('POST /v1/admin/affiliates/link', 'write', async ({ unique }, principal) => {
    const promo = await promotion(unique), email = 'linked-' + unique + '@matrix.invalid';
    return { url: '/v1/admin/affiliates/link', body: { promotionId: promo.id, email }, async verify(response: Response, proof: MatrixProof) {
      proof.equal(await json(response), { result: 'onboarded' }, 'exact new affiliate binding result');
      const saved = await one(fixture, 'select id,email,access_token,promotion_id from affiliate where promotion_id=$1', [promo.id]);
      proof.ok(secretShape(saved.access_token), 'binding creates private dashboard token', 'state');
      proof.equal(saved, { id: saved.id, email, access_token: saved.access_token, promotion_id: promo.id }, 'new affiliate belongs to requested promotion', 'state');
      proof.equal(await one(fixture, 'select affiliate_email from promotion where id=$1', [promo.id]), { affiliate_email: email }, 'binding committed to promotion', 'state');
      await audit(proof, principal, 'affiliate', saved.id, 'onboard', { email, code: promo.code, source: 'promotion' });
      await mail(proof, email, 'welcome', saved.id, saved.access_token, promo.code);
    } };
  });
  add('POST /v1/admin/affiliates/{id}/settle', 'payout', async ({ unique }, principal) => {
    const aff = await affiliate(unique), order = await paidOrder(unique, aff.promotionId), txRef = 'matrix-transfer-' + unique, notes = 'Matrix partial payout ' + unique;
    return { url: '/v1/admin/affiliates/' + aff.id + '/settle', body: { amountCents: 400, txRef, notes }, async verify(response: Response, proof: MatrixProof) {
      proof.equal(await json(response), { settled: 400 }, 'exact payout record response');
      proof.equal(await query(fixture, 'select amount_cents,period_start_at,tx_ref,notes from affiliate_settle where promotion_id=$1', [aff.promotionId]),
        [{ amount_cents: 400, period_start_at: null, tx_ref: txRef, notes }], 'one partial settlement committed', 'state');
      proof.equal(await one(fixture, 'select (select coalesce(sum(greatest(subtotal-discount_total,0)),0)::int from "order" where promotion_id=$1 and state in (\'Paid\',\'PartiallyRefunded\')) as revenue,(select coalesce(sum(amount_cents),0)::int from affiliate_settle where promotion_id=$1) as settled', [aff.promotionId]),
        { revenue: 10000, settled: 400 }, 'commission basis preserved & remaining commission is 600 cents', 'state');
      proof.equal(await one(fixture, 'select state,grand_total from "order" where id=$1', [order.id]), { state: 'Paid', grand_total: 10000 }, 'payout record leaves paid order intact', 'state');
      await audit(proof, principal, 'affiliate', aff.id, 'settle', { amountCents: 400 });
    } };
  }, 'money_out');
  return cases;
}

