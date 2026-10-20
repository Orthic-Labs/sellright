/** Concrete catalog/settings mutations for B2.8; source-only, never packed. */
import { randomUUID, createHash } from 'node:crypto';
import type { MatrixCase, MatrixCell, MatrixPrincipal, MatrixProof } from './authorization-matrix.testkit.js';

export interface MatrixMutationFixture {
  storeId: string;
  storeSlug: string;
  requestHeaders: Record<MatrixPrincipal, Record<string, string>>;
  snapshot(): Promise<unknown>;
  snapshotFor(principal: MatrixPrincipal, method: string, path: string, expectedStatus?: number, agentGroup?: string): () => Promise<unknown>;
  queryStore(storeId: string, sql: string, values?: unknown[]): Promise<{ rows: Record<string, any>[] }>;
  /** Fresh active product + physical variant with stock, belonging to selected store A. */
  seedProduct(): Promise<{ productId: string; variantId: string }>;
}

type Access = 'write' | 'delete' | 'manage' | 'manage-delete' | 'credentials';
type Prepared = { url: string; body?: unknown; verify(response: Response, proof: MatrixProof): Promise<void> };
type Seed = { productId: string; variantId: string; unique: string };

/** Every outcome is explicit; no policy/role production helper computes expected authorization. */
const OUTCOMES: Record<Access, Record<MatrixPrincipal, number>> = {
  write: { owner: 200, manager: 200, staff: 200, read_only: 403, agent: 200, foreign_store: 403, release_service: 401, cache_token: 401 },
  delete: { owner: 200, manager: 200, staff: 200, read_only: 403, agent: 403, foreign_store: 403, release_service: 401, cache_token: 401 },
  manage: { owner: 200, manager: 200, staff: 403, read_only: 403, agent: 403, foreign_store: 403, release_service: 401, cache_token: 401 },
  'manage-delete': { owner: 200, manager: 200, staff: 403, read_only: 403, agent: 403, foreign_store: 403, release_service: 401, cache_token: 401 },
  credentials: { owner: 200, manager: 200, staff: 403, read_only: 403, agent: 403, foreign_store: 403, release_service: 401, cache_token: 401 },
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createMutationCases(fixture: MatrixMutationFixture): MatrixCase[] {
  const cases: MatrixCase[] = [];
  const query = async (sql: string, values: unknown[] = []) => (await fixture.queryStore(fixture.storeId, sql, values)).rows;
  const one = async (sql: string, values: unknown[] = []) => {
    const rows = await query(sql, values);
    if (rows.length !== 1) throw new Error(`matrix fixture expected one row: ${sql}`);
    return rows[0]!;
  };
  const inserted = async (sql: string, values: unknown[]) => String((await one(sql, values)).id);
  const json = async (response: Response) => await response.json() as Record<string, any>;
  const idResponse = async (response: Response, proof: MatrixProof, id: string) => proof.equal(await json(response), { id }, 'exact entity response');
  const okResponse = async (response: Response, proof: MatrixProof) => proof.equal(await json(response), { ok: true }, 'exact success response');
  const add = (key: string, access: Access, prepare: (seed: Seed) => Promise<Prepared>) => {
    const method = key.split(' ')[0]!;
    const cell = (principal: MatrixPrincipal): MatrixCell => {
      const status = OUTCOMES[access][principal];
      const allow = status === 200;
      return {
        effect: allow ? 'allow' : 'deny', status,
        ...(principal === 'agent' && !allow && ['delete', 'manage-delete', 'credentials'].includes(access) ? { errorCode: 'AGENT_NOT_ALLOWED' } : {}),
        async prepare() {
          // Each of all eight cells gets fresh existing store-A targets, including denials.
          const seed = { ...await fixture.seedProduct(), unique: randomUUID() };
          const prepared = await prepare(seed);
          return {
            url: prepared.url,
            init: { method, headers: { ...fixture.requestHeaders[principal], 'content-type': 'application/json' },
              ...(prepared.body === undefined ? {} : { body: JSON.stringify(prepared.body) }) },
            ...(allow ? {} : { snapshot: fixture.snapshotFor(principal, method, prepared.url, status, principal === 'agent' ? access === 'credentials' ? 'credentials' : access === 'delete' || access === 'manage-delete' ? 'delete' : undefined : undefined) }),
            async verify(response: Response, proof: MatrixProof) {
              if (allow) return prepared.verify(response, proof);
              const body = await json(response);
              if (principal === 'release_service' || principal === 'cache_token') {
                proof.equal(body.error?.code, 'NOT_AUTHENTICATED', 'service/cache credentials do not authenticate admin');
                proof.ok(['not authenticated', 'invalid or expired session'].includes(body.error?.message), 'authentication error message');
              } else if (principal === 'agent' && ['delete', 'manage-delete', 'credentials'].includes(access)) {
                proof.equal(body.error?.code, 'AGENT_NOT_ALLOWED', 'explicit agent hard denial');
                proof.equal(body.error?.message, access === 'credentials'
                  ? 'agents cannot change credentials or payment/e-mail secrets'
                  : 'agents cannot delete — disable or trash instead; deletion needs a human', 'agent denial reason');
              } else {
                const expected = principal === 'foreign_store' ? `no access to store: ${fixture.storeSlug}`
                  : access === 'write' || access === 'delete' ? "role 'read_only' is read-only"
                  : `role '${principal === 'agent' ? 'staff' : principal}' cannot manage settings/staff`;
                proof.equal(body.error?.message, expected, 'role/store authorization error');
              }
            },
          };
        },
      };
    };
    cases.push({ key, contract: 'admin', cells: {
      owner: cell('owner'), manager: cell('manager'), staff: cell('staff'), read_only: cell('read_only'),
      agent: cell('agent'), foreign_store: cell('foreign_store'), release_service: cell('release_service'), cache_token: cell('cache_token'),
    } });
  };
  const productPath = (id: string) => `/v1/admin/products/${id}`;
  const variantPath = (id: string) => `/v1/admin/variants/${id}`;
  const seedAsset = (unique: string) => inserted('insert into asset(store_id,path) values ($1,$2) returning id', [fixture.storeId, `matrix/${unique}.png`]);
  const seedLocation = (unique: string) => inserted('insert into location(store_id,name,code) values ($1,$2,$3) returning id', [fixture.storeId, 'Matrix location', unique]);
  const seedGroup = (productId: string, name: string, position = 0) => inserted('insert into product_option_group(store_id,product_id,name,position) values ($1,$2,$3,$4) returning id', [fixture.storeId, productId, name, position]);
  const seedOption = (groupId: string, value: string, position = 0) => inserted('insert into product_option(store_id,group_id,value,position) values ($1,$2,$3,$4) returning id', [fixture.storeId, groupId, value, position]);

  add('POST /v1/admin/products', 'write', async ({ unique }) => {
    const body = { name: `Matrix ${unique}`, slug: `matrix-${unique}`, description: 'Authorization matrix product', status: 'active' };
    return { url: '/v1/admin/products', body, async verify(response: Response, proof: MatrixProof) {
      const saved = await one('select id,slug,name,description,status from product where slug=$1', [body.slug]);
      proof.equal(saved, { id: saved.id, slug: body.slug, name: body.name, description: body.description, status: 'active' }, 'new product committed', 'state');
      proof.ok(uuid.test(saved.id), 'persisted product UUID', 'state');
      proof.equal(await json(response), { id: saved.id, slug: body.slug }, 'exact create product response');
    } };
  });
  add('PATCH /v1/admin/products/{id}', 'write', async ({ productId, unique }) => {
    const body = { name: `Edited ${unique}`, status: 'draft', description: 'Matrix edited', tags: ['matrix'] };
    return { url: productPath(productId), body, async verify(response: Response, proof: MatrixProof) {
      await idResponse(response, proof, productId);
      proof.equal(await one('select name,status,description,tags from product where id=$1', [productId]), body, 'product patch committed', 'state');
    } };
  });
  add('DELETE /v1/admin/products/{id}', 'delete', async ({ productId, variantId }) => ({
    url: productPath(productId), async verify(response: Response, proof: MatrixProof) {
      await idResponse(response, proof, productId);
      proof.equal(await one('select status,deleted_at is not null as deleted from product where id=$1', [productId]), { status: 'draft', deleted: true }, 'product archived', 'state');
      proof.equal(await one('select enabled,deleted_at is not null as deleted from product_variant where id=$1', [variantId]), { enabled: false, deleted: true }, 'child variant archived', 'state');
    },
  }));
  add('POST /v1/admin/products/{id}/variants', 'write', async ({ productId, unique }) => {
    const body = { sku: `matrix-${unique}`, name: 'Matrix added variant', price: 1234, onHand: 7, fulfillmentType: 'physical' };
    return { url: `${productPath(productId)}/variants`, body, async verify(response: Response, proof: MatrixProof) {
      const saved = await one('select v.id,v.product_id,v.sku,v.name,v.price,s.on_hand,s.allocated from product_variant v join stock s on s.variant_id=v.id where v.sku=$1', [body.sku]);
      await idResponse(response, proof, saved.id);
      proof.equal(saved, { id: saved.id, product_id: productId, sku: body.sku, name: body.name, price: 1234, on_hand: 7, allocated: 0 }, 'variant and stock committed', 'state');
    } };
  });
  add('PATCH /v1/admin/variants/{id}', 'write', async ({ variantId }) => ({
    url: variantPath(variantId), body: { price: 2468, salePrice: 1357, enabled: false, barcode: 'MATRIX' },
    async verify(response: Response, proof: MatrixProof) {
      await idResponse(response, proof, variantId);
      proof.equal(await one('select price,sale_price,enabled,barcode from product_variant where id=$1', [variantId]), { price: 2468, sale_price: 1357, enabled: false, barcode: 'MATRIX' }, 'variant patch committed', 'state');
    },
  }));
  add('DELETE /v1/admin/variants/{id}', 'delete', async ({ variantId }) => ({
    url: variantPath(variantId), async verify(response: Response, proof: MatrixProof) {
      await idResponse(response, proof, variantId);
      proof.equal(await one('select enabled,deleted_at is not null as deleted from product_variant where id=$1', [variantId]), { enabled: false, deleted: true }, 'variant archived', 'state');
    },
  }));
  add('PATCH /v1/admin/variants/{id}/stock', 'write', async ({ variantId }) => ({
    url: `${variantPath(variantId)}/stock`, body: { onHand: 31 },
    async verify(response: Response, proof: MatrixProof) {
      proof.equal(await json(response), { id: variantId, onHand: 31 }, 'exact stock response');
      proof.equal(await one('select on_hand from stock where variant_id=$1', [variantId]), { on_hand: 31 }, 'stock committed', 'state');
      proof.equal(await one("select data->>'onHand' as value from audit_log where entity='variant' and entity_id=$1 and action='stock' order by at desc limit 1", [variantId]), { value: '31' }, 'stock audit committed', 'state');
    },
  }));
  add('PATCH /v1/admin/variants/stock/bulk', 'write', async ({ variantId }) => {
    const second = await fixture.seedProduct();
    const items = [{ id: variantId, onHand: 41 }, { id: second.variantId, onHand: 43 }];
    return { url: '/v1/admin/variants/stock/bulk', body: { items }, async verify(response: Response, proof: MatrixProof) {
      proof.equal(await json(response), { updated: items }, 'exact bulk result');
      for (const item of items) proof.equal(await one('select on_hand from stock where variant_id=$1', [item.id]), { on_hand: item.onHand }, 'bulk stock committed', 'state');
    } };
  });
  add('POST /v1/admin/variants/{id}/stock/adjust', 'write', async ({ variantId }) => {
    const before = await one('select on_hand from stock where variant_id=$1', [variantId]);
    return { url: `${variantPath(variantId)}/stock/adjust`, body: { delta: 5, reason: 'matrix receipt correction' }, async verify(response: Response, proof: MatrixProof) {
      const onHand = before.on_hand + 5;
      proof.equal(await json(response), { id: variantId, onHand }, 'exact adjustment result');
      proof.equal(await one('select on_hand from stock where variant_id=$1', [variantId]), { on_hand: onHand }, 'adjustment committed', 'state');
      proof.equal(await query('select delta,reason from stock_movement where variant_id=$1 and reason=$2', [variantId, 'matrix receipt correction']), [{ delta: 5, reason: 'matrix receipt correction' }], 'movement recorded once', 'state');
    } };
  });
  add('POST /v1/admin/products/{id}/assets', 'write', async ({ productId, unique }) => {
    const assetId = await seedAsset(unique);
    return { url: `${productPath(productId)}/assets`, body: { assetId, position: 3 }, async verify(response: Response, proof: MatrixProof) {
      await okResponse(response, proof);
      proof.equal(await query('select asset_id,position from product_asset where product_id=$1', [productId]), [{ asset_id: assetId, position: 3 }], 'gallery association committed', 'state');
    } };
  });
  add('DELETE /v1/admin/products/{id}/assets/{assetId}', 'delete', async ({ productId, unique }) => {
    const assetId = await seedAsset(unique);
    await query('insert into product_asset(store_id,product_id,asset_id,position) values ($1,$2,$3,0)', [fixture.storeId, productId, assetId]);
    return { url: `${productPath(productId)}/assets/${assetId}`, async verify(response: Response, proof: MatrixProof) {
      await okResponse(response, proof);
      proof.equal(await query('select asset_id from product_asset where product_id=$1 and asset_id=$2', [productId, assetId]), [], 'gallery association removed', 'state');
      proof.equal(await query('select id from asset where id=$1', [assetId]), [{ id: assetId }], 'asset retained', 'state');
    } };
  });
  add('POST /v1/admin/locations', 'write', async ({ unique }) => {
    const body = { name: `Matrix ${unique}`, code: unique, isDefault: false, address: { city: 'Matrix City' } };
    return { url: '/v1/admin/locations', body, async verify(response: Response, proof: MatrixProof) {
      const saved = await one('select id,name,code,is_default,address from location where code=$1', [unique]);
      await idResponse(response, proof, saved.id);
      proof.equal(saved, { id: saved.id, name: body.name, code: unique, is_default: false, address: body.address }, 'location committed', 'state');
    } };
  });
  add('PATCH /v1/admin/variants/{id}/location-stock', 'write', async ({ variantId, unique }) => {
    const locationId = await seedLocation(unique);
    return { url: `${variantPath(variantId)}/location-stock`, body: { locationId, onHand: 19 }, async verify(response: Response, proof: MatrixProof) {
      proof.equal(await json(response), { id: variantId, onHand: 19 }, 'exact location-stock response');
      proof.equal(await query('select location_id,on_hand from stock_location where variant_id=$1', [variantId]), [{ location_id: locationId, on_hand: 19 }], 'location stock committed', 'state');
      proof.equal(await one('select on_hand from stock where variant_id=$1', [variantId]), { on_hand: 19 }, 'aggregate stock committed', 'state');
    } };
  });
  add('POST /v1/admin/variants/{id}/transfer', 'write', async ({ variantId, unique }) => {
    const from = await seedLocation(`${unique}-from`), to = await seedLocation(`${unique}-to`);
    await query('insert into stock_location(store_id,variant_id,location_id,on_hand) values ($1,$2,$3,10)', [fixture.storeId, variantId, from]);
    await query('update stock set on_hand=10 where variant_id=$1', [variantId]);
    return { url: `${variantPath(variantId)}/transfer`, body: { fromLocationId: from, toLocationId: to, quantity: 4 }, async verify(response: Response, proof: MatrixProof) {
      await idResponse(response, proof, variantId);
      proof.equal(await one('select on_hand from stock_location where variant_id=$1 and location_id=$2', [variantId, from]), { on_hand: 6 }, 'transfer source committed', 'state');
      proof.equal(await one('select on_hand from stock_location where variant_id=$1 and location_id=$2', [variantId, to]), { on_hand: 4 }, 'transfer destination committed', 'state');
      proof.equal(await one('select on_hand from stock where variant_id=$1', [variantId]), { on_hand: 10 }, 'aggregate preserved', 'state');
    } };
  });
  add('POST /v1/admin/products/{id}/option-groups', 'write', async ({ productId }) => ({
    url: `${productPath(productId)}/option-groups`, body: { name: 'Matrix size', values: ['Small', 'Large'] },
    async verify(response: Response, proof: MatrixProof) {
      const saved = await one('select id,name,position from product_option_group where product_id=$1', [productId]);
      await idResponse(response, proof, saved.id);
      proof.equal(saved, { id: saved.id, name: 'Matrix size', position: 0 }, 'option group committed', 'state');
      proof.equal(await query('select value,position from product_option where group_id=$1 order by position', [saved.id]), [{ value: 'Small', position: 0 }, { value: 'Large', position: 1 }], 'ordered options committed', 'state');
    },
  }));
  add('POST /v1/admin/option-groups/{groupId}/options', 'write', async ({ productId }) => {
    const group = await seedGroup(productId, 'Matrix color');
    return { url: `/v1/admin/option-groups/${group}/options`, body: { value: 'Blue' }, async verify(response: Response, proof: MatrixProof) {
      const saved = await one('select id,value,position from product_option where group_id=$1', [group]);
      await idResponse(response, proof, saved.id);
      proof.equal(saved, { id: saved.id, value: 'Blue', position: 0 }, 'option committed', 'state');
    } };
  });
  add('PUT /v1/admin/products/{id}/option-groups/reorder', 'write', async ({ productId }) => {
    const first = await seedGroup(productId, 'First', 0), second = await seedGroup(productId, 'Second', 1);
    return { url: `${productPath(productId)}/option-groups/reorder`, body: { order: [second, first] }, async verify(response: Response, proof: MatrixProof) {
      await okResponse(response, proof);
      proof.equal(await query('select id,position from product_option_group where product_id=$1 order by position', [productId]), [{ id: second, position: 0 }, { id: first, position: 1 }], 'group permutation committed', 'state');
    } };
  });
  add('PUT /v1/admin/option-groups/{groupId}/options/reorder', 'write', async ({ productId }) => {
    const group = await seedGroup(productId, 'Matrix order');
    const first = await seedOption(group, 'First', 0), second = await seedOption(group, 'Second', 1);
    return { url: `/v1/admin/option-groups/${group}/options/reorder`, body: { order: [second, first] }, async verify(response: Response, proof: MatrixProof) {
      await okResponse(response, proof);
      proof.equal(await query('select id,position from product_option where group_id=$1 order by position', [group]), [{ id: second, position: 0 }, { id: first, position: 1 }], 'value permutation committed', 'state');
    } };
  });
  add('PUT /v1/admin/variants/{id}/options', 'write', async ({ productId, variantId }) => {
    const group = await seedGroup(productId, 'Matrix assignment');
    const old = await seedOption(group, 'Old', 0), selected = await seedOption(group, 'New', 1);
    await query('insert into variant_option(store_id,variant_id,option_id) values ($1,$2,$3)', [fixture.storeId, variantId, old]);
    return { url: `${variantPath(variantId)}/options`, body: { optionIds: [selected] }, async verify(response: Response, proof: MatrixProof) {
      await idResponse(response, proof, variantId);
      proof.equal(await query('select option_id from variant_option where variant_id=$1', [variantId]), [{ option_id: selected }], 'previous option replaced', 'state');
    } };
  });

  const seedShipping = (unique: string) => inserted('insert into shipping_method(store_id,code,name,calculator) values ($1,$2,$3,$4::jsonb) returning id', [fixture.storeId, unique, 'Matrix existing shipping', JSON.stringify({ flat: 100 })]);
  const seedTax = () => inserted('insert into tax_zone(store_id,name,countries,rate) values ($1,$2,$3,500) returning id', [fixture.storeId, 'Matrix existing tax', ['US']]);
  add('POST /v1/admin/shipping-methods', 'manage', async ({ unique }) => {
    const body = { code: unique, name: 'Matrix shipping', calculator: { flat: 321, countries: ['US'] }, enabled: true };
    return { url: '/v1/admin/shipping-methods', body, async verify(response: Response, proof: MatrixProof) {
      const saved = await one('select id,code,name,calculator,enabled from shipping_method where code=$1', [unique]);
      await idResponse(response, proof, saved.id);
      proof.equal(saved, { id: saved.id, ...body }, 'shipping method committed', 'state');
    } };
  });
  add('PATCH /v1/admin/shipping-methods/{id}', 'manage', async ({ unique }) => {
    const id = await seedShipping(unique);
    const body = { name: 'Matrix revised shipping', calculator: { flat: 456 }, enabled: false };
    return { url: `/v1/admin/shipping-methods/${id}`, body, async verify(response: Response, proof: MatrixProof) {
      await idResponse(response, proof, id);
      proof.equal(await one('select name,calculator,enabled from shipping_method where id=$1', [id]), body, 'shipping update committed', 'state');
    } };
  });
  add('DELETE /v1/admin/shipping-methods/{id}', 'manage-delete', async ({ unique }) => {
    const id = await seedShipping(unique);
    return { url: `/v1/admin/shipping-methods/${id}`, async verify(response: Response, proof: MatrixProof) {
      await idResponse(response, proof, id);
      proof.equal(await query('select id from shipping_method where id=$1', [id]), [], 'shipping method deleted', 'state');
    } };
  });
  add('POST /v1/admin/tax-zones', 'manage', async ({ unique }) => {
    const body = { name: `Matrix tax ${unique}`, countries: ['us', 'ca'], rate: 725, priority: 4, enabled: true };
    return { url: '/v1/admin/tax-zones', body, async verify(response: Response, proof: MatrixProof) {
      const saved = await one('select id,name,countries,rate,priority,enabled from tax_zone where name=$1', [body.name]);
      await idResponse(response, proof, saved.id);
      proof.equal(saved, { id: saved.id, ...body, countries: ['US', 'CA'] }, 'normalized tax zone committed', 'state');
    } };
  });
  add('PATCH /v1/admin/tax-zones/{id}', 'manage', async () => {
    const id = await seedTax();
    const body = { name: 'Matrix revised tax', countries: ['gb'], rate: 2000, priority: 8, enabled: false };
    return { url: `/v1/admin/tax-zones/${id}`, body, async verify(response: Response, proof: MatrixProof) {
      await idResponse(response, proof, id);
      proof.equal(await one('select name,countries,rate,priority,enabled from tax_zone where id=$1', [id]), { ...body, countries: ['GB'] }, 'tax patch committed', 'state');
    } };
  });
  add('DELETE /v1/admin/tax-zones/{id}', 'manage-delete', async () => {
    const id = await seedTax();
    return { url: `/v1/admin/tax-zones/${id}`, async verify(response: Response, proof: MatrixProof) {
      await idResponse(response, proof, id);
      proof.equal(await query('select id from tax_zone where id=$1', [id]), [], 'tax zone deleted', 'state');
    } };
  });
  add('PATCH /v1/admin/settings/store', 'manage', async ({ unique }) => {
    const body = { name: `Matrix store ${unique}`, taxRate: 625, taxInclusive: false, shippingTaxable: true };
    return { url: '/v1/admin/settings/store', body, async verify(response: Response, proof: MatrixProof) {
      await okResponse(response, proof);
      proof.equal(await one('select name,tax_rate,tax_inclusive,shipping_taxable from store where id=$1', [fixture.storeId]), { name: body.name, tax_rate: 625, tax_inclusive: false, shipping_taxable: true }, 'store settings committed', 'state');
    } };
  });
  add('PATCH /v1/admin/settings/payments', 'manage', async () => ({
    url: '/v1/admin/settings/payments', body: { cod: false }, async verify(response: Response, proof: MatrixProof) {
      const saved = await one("select config->'payments' as payments from store where id=$1", [fixture.storeId]);
      proof.equal(saved.payments.cod, false, 'payment setting committed', 'state');
      proof.equal(await json(response), { payments: saved.payments }, 'exact payments response matches persisted config');
    },
  }));
  add('PATCH /v1/admin/settings/notifications', 'manage', async ({ unique }) => ({
    url: '/v1/admin/settings/notifications', body: { matrixMarker: unique, orderConfirmation: false }, async verify(response: Response, proof: MatrixProof) {
      await okResponse(response, proof);
      const saved = await one("select config->'notifications' as notifications from store where id=$1", [fixture.storeId]);
      proof.equal({ matrixMarker: saved.notifications.matrixMarker, orderConfirmation: saved.notifications.orderConfirmation }, { matrixMarker: unique, orderConfirmation: false }, 'notification config committed', 'state');
    },
  }));
  add('PATCH /v1/admin/settings/identity', 'manage', async ({ unique }) => ({
    url: '/v1/admin/settings/identity', body: { tagline: unique, legalName: 'Matrix Commerce' }, async verify(response: Response, proof: MatrixProof) {
      await okResponse(response, proof);
      const saved = await one("select config->'identity' as identity from store where id=$1", [fixture.storeId]);
      proof.equal({ tagline: saved.identity.tagline, legalName: saved.identity.legalName }, { tagline: unique, legalName: 'Matrix Commerce' }, 'identity config committed', 'state');
    },
  }));
  add('PATCH /v1/admin/settings/publish', 'manage', async () => {
    // Ensure this is a real transition while avoiding publication readiness/providers.
    await query("update store set config=coalesce(config,'{}'::jsonb)||'{\"published\":true}'::jsonb where id=$1", [fixture.storeId]);
    return { url: '/v1/admin/settings/publish', body: { published: false }, async verify(response: Response, proof: MatrixProof) {
      proof.equal(await json(response), { published: false }, 'exact unpublish response');
      proof.equal(await one("select config->'published' as published from store where id=$1", [fixture.storeId]), { published: false }, 'unpublished config committed', 'state');
    } };
  });
  add('PATCH /v1/admin/settings/google', 'credentials', async ({ unique }) => {
    const clientId = `matrix-${unique}.apps.googleusercontent.com`;
    return { url: '/v1/admin/settings/google', body: { clientId }, async verify(response: Response, proof: MatrixProof) {
      await okResponse(response, proof);
      proof.equal(await one("select config->>'googleClientId' as client_id from store where id=$1", [fixture.storeId]), { client_id: clientId }, 'Google client config committed', 'state');
    } };
  });
  add('POST /v1/admin/settings/preview-token', 'credentials', async ({ unique }) => {
    const previous = createHash('sha256').update(unique).digest('hex');
    await query("update store set config=coalesce(config,'{}'::jsonb)||jsonb_build_object('previewTokenHash',$2::text) where id=$1", [fixture.storeId, previous]);
    return { url: '/v1/admin/settings/preview-token', async verify(response: Response, proof: MatrixProof) {
      const body = await json(response);
      proof.equal(Object.keys(body).sort(), ['previewUrl', 'token'], 'exact preview response fields');
      proof.ok(typeof body.token === 'string' && body.token.length >= 32, 'generated preview token');
      proof.ok(typeof body.previewUrl === 'string' && body.previewUrl.endsWith(`/?preview_token=${body.token}`), 'preview URL binds returned token');
      const saved = await one("select config->>'previewTokenHash' as hash from store where id=$1", [fixture.storeId]);
      proof.equal(saved.hash, createHash('sha256').update(body.token).digest('hex'), 'only returned token hash committed', 'state');
      proof.ok(saved.hash !== previous && saved.hash !== body.token, 'previous preview token rotated', 'state');
    } };
  });
  return cases;
}

