/** Blog, collections, reviews, customers & loyalty authorization fixtures; never packed. */
import { createHash, randomUUID } from 'node:crypto';
import type { MatrixMutationFixture } from './authorization-matrix.mutation-cases.testkit.js';
import type { MatrixCase, MatrixCell, MatrixPrincipal, MatrixProof } from './authorization-matrix.testkit.js';

export interface MatrixContentFixture extends MatrixMutationFixture {
  snapshotFor(principal: MatrixPrincipal, method: string, path: string, expectedStatus?: number, agentGroup?: string): () => Promise<unknown>;
}
type Access = 'read' | 'write' | 'delete' | 'manage' | 'write-manage' | 'loyalty' | 'verification';
type Seed = { productId: string; variantId: string; unique: string };
type Prepared = { url: string; body?: unknown; headers?: Record<string, string>; verify(response: Response, proof: MatrixProof): Promise<void> };
const EXPECTED: Record<Access, Record<MatrixPrincipal, number>> = {
  read: { owner: 200, manager: 200, staff: 200, read_only: 200, agent: 200, foreign_store: 403, release_service: 401, cache_token: 401 },
  write: { owner: 200, manager: 200, staff: 200, read_only: 403, agent: 200, foreign_store: 403, release_service: 401, cache_token: 401 },
  delete: { owner: 200, manager: 200, staff: 200, read_only: 403, agent: 403, foreign_store: 403, release_service: 401, cache_token: 401 },
  manage: { owner: 200, manager: 200, staff: 403, read_only: 403, agent: 403, foreign_store: 403, release_service: 401, cache_token: 401 },
  'write-manage': { owner: 200, manager: 200, staff: 403, read_only: 403, agent: 403, foreign_store: 403, release_service: 401, cache_token: 401 },
  loyalty: { owner: 200, manager: 200, staff: 403, read_only: 403, agent: 403, foreign_store: 403, release_service: 401, cache_token: 401 },
  verification: { owner: 200, manager: 200, staff: 403, read_only: 403, agent: 403, foreign_store: 403, release_service: 401, cache_token: 401 },
};
const json = (response: Response) => response.json() as Promise<Record<string, any>>;
const normalized = (value: unknown) => JSON.parse(JSON.stringify(value));
const stable = (value: any): any => Array.isArray(value) ? value.map(stable) : value !== null && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)])) : value;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(stable(normalized(value)))).digest('hex');
const receiptId = (storeId: string, key: string) => {
  const h = createHash('sha256').update(`sellright:blog-create:v1\0${storeId}\0${key}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

export function createContentCases(fixture: MatrixContentFixture): MatrixCase[] {
  const cases: MatrixCase[] = [];
  const actor = (principal: MatrixPrincipal) => `${principal}-${fixture.storeSlug}@matrix.invalid`;
  const query = async (sql: string, values: unknown[] = []) => (await fixture.queryStore(fixture.storeId, sql, values)).rows;
  const one = async (sql: string, values: unknown[] = []) => {
    const rows = await query(sql, values);
    if (rows.length !== 1) throw new Error(`content matrix fixture expected one row: ${sql}`);
    return rows[0]!;
  };
  const insertId = async (sql: string, values: unknown[]) => String((await one(sql, values)).id);
  const idResponse = async (response: Response, proof: MatrixProof, id: string) => proof.equal(await json(response), { id }, 'exact entity response');
  const okResponse = async (response: Response, proof: MatrixProof) => proof.equal(await json(response), { ok: true }, 'exact success response');
  const audit = async (proof: MatrixProof, entity: string, entityId: string, action: string, principal: MatrixPrincipal, data?: unknown) => {
    const rows = await query('select actor,data from audit_log where entity=$1 and entity_id=$2 and action=$3', [entity, entityId, action]);
    if (data === undefined) {
      proof.equal(rows.length, 1, 'one entity audit committed', 'state');
      proof.equal(rows[0]?.actor, actor(principal), 'entity audit attributes session actor', 'state');
    } else proof.equal(rows, [{ actor: actor(principal), data }], 'exact actor attribution committed', 'state');
  };
  const add = (key: string, access: Access, prepare: (seed: Seed, principal: MatrixPrincipal) => Promise<Prepared>) => {
    const method = key.split(' ')[0]!;
    const cell = (principal: MatrixPrincipal): MatrixCell => {
      const status = EXPECTED[access][principal], allow = status === 200;
      const group = principal !== 'agent' ? undefined : access === 'delete' ? 'delete' : access === 'loyalty' ? 'credit' : access === 'verification' ? 'entitlement' : undefined;
      return { effect: allow ? 'allow' : 'deny', status, ...(group ? { errorCode: 'AGENT_NOT_ALLOWED' } : {}), async prepare() {
        const prepared = await prepare({ ...await fixture.seedProduct(), unique: randomUUID() }, principal);
        return { url: prepared.url,
          init: { method, headers: { ...fixture.requestHeaders[principal], 'content-type': 'application/json', ...prepared.headers }, ...(prepared.body === undefined ? {} : { body: JSON.stringify(prepared.body) }) },
          ...(allow ? {} : { snapshot: fixture.snapshotFor(principal, method, prepared.url, status, group) }),
          async verify(response: Response, proof: MatrixProof) {
            if (allow) return prepared.verify(response, proof);
            const body = await json(response);
            if (status === 401) {
              proof.equal(body.error?.code, 'NOT_AUTHENTICATED', 'service/cache cannot authenticate admin');
              proof.ok(['not authenticated', 'invalid or expired session'].includes(body.error?.message), 'authentication denial reason');
            } else if (group) {
              proof.equal(body.error?.code, 'AGENT_NOT_ALLOWED', 'hard agent denial');
              proof.equal(body.error?.message, group === 'delete' ? 'agents cannot delete — disable or trash instead; deletion needs a human'
                : group === 'credit' ? 'agents cannot issue or adjust customer credit — a human does that'
                : 'agents cannot issue, revoke or release entitlements', 'exact hard agent reason');
            } else {
              const role = principal === 'agent' ? 'staff' : principal;
              const message = principal === 'foreign_store' ? `no access to store: ${fixture.storeSlug}`
                : access === 'manage' || access === 'write-manage' && principal !== 'read_only' ? `role '${role}' cannot manage settings/staff`
                : (access === 'loyalty' || access === 'verification') && principal === 'staff' ? `role 'staff' lacks the '${access === 'loyalty' ? 'loyalty' : 'customer_verification'}' permission`
                : "role 'read_only' is read-only";
              proof.equal(body.error?.message, message, 'exact store/role/permission denial');
            }
          },
        };
      } };
    };
    cases.push({ key, contract: 'admin', cells: { owner: cell('owner'), manager: cell('manager'), staff: cell('staff'), read_only: cell('read_only'),
      agent: cell('agent'), foreign_store: cell('foreign_store'), release_service: cell('release_service'), cache_token: cell('cache_token') } });
  };
  const seedBlog = (unique: string) => insertId('insert into blog_post(store_id,title,slug,body,body_html,author_name,reading_time,is_published) values ($1,$2,$3,$4,$4,$5,1,false) returning id',
    [fixture.storeId, `Matrix blog ${unique}`, `matrix-${unique}`, '<p>Matrix article.</p>', 'Matrix fixture author']);
  const blogRow = async (id: string) => normalized(await one('select id,store_id as "storeId",title,slug,excerpt,body,body_html as "bodyHtml",author_name as "authorName",reading_time as "readingTime",featured_asset_id as "featuredAssetId",tags,is_published as "isPublished",publish_date as "publishDate",seo_title as "seoTitle",seo_description as "seoDescription",created_at as "createdAt",updated_at as "updatedAt" from blog_post where id=$1', [id]));

  add('POST /v1/admin/blog', 'write', async ({ unique }, principal) => {
    const body = { title: `Matrix article ${unique}`, slug: `matrix-${unique}`, body: '<p>Matrix article.</p>', excerpt: 'Matrix excerpt', tags: ['matrix'], isPublished: false, publishDate: null };
    const key = `matrix-create-${unique}`;
    return { url: '/v1/admin/blog', body, headers: { 'idempotency-key': key }, async verify(response, proof) {
      const saved = await one('select id,title,slug,body,body_html,excerpt,tags,is_published,publish_date,author_name,reading_time from blog_post where slug=$1', [body.slug]);
      proof.equal(await json(response), { id: saved.id, slug: body.slug }, 'exact created blog response');
      proof.equal(saved, { id: saved.id, title: body.title, slug: body.slug, body: body.body, body_html: body.body, excerpt: body.excerpt, tags: ['matrix'], is_published: false, publish_date: null, author_name: actor(principal), reading_time: 1 }, 'blog body and sanitized HTML committed', 'state');
      await audit(proof, 'blog_post', saved.id, 'idempotent_create', principal, { requestHash: hash(body), postId: saved.id, slug: body.slug });
    } };
  });
  add('GET /v1/admin/blog/{id}', 'read', async ({ unique }) => {
    const id = await seedBlog(unique);
    return { url: `/v1/admin/blog/${id}`, async verify(response, proof) {
      const row = await blogRow(id);
      proof.equal(await json(response), { ...row, seoRevision: hash(row), seoContract: 'revision-v1' }, 'exact owned blog detail and revision');
    } };
  });
  add('GET /v1/admin/blog/requests/{key}', 'read', async ({ unique }) => {
    const id = await seedBlog(unique), key = `matrix-receipt-${unique}`, slug = `matrix-${unique}`;
    const requestHash = hash({ title: `Matrix blog ${unique}`, slug });
    await query("insert into audit_log(id,store_id,actor,entity,entity_id,action,data) values ($1,$2,$3,'blog_post',$4,'idempotent_create',$5::jsonb)",
      [receiptId(fixture.storeId, key), fixture.storeId, actor('owner'), id, JSON.stringify({ requestHash, postId: id, slug })]);
    return { url: `/v1/admin/blog/requests/${key}`, async verify(response, proof) {
      proof.equal(await json(response), { storeId: fixture.storeId, id, slug, requestHash }, 'exact owned durable create receipt');
    } };
  });
  add('PATCH /v1/admin/blog/{id}', 'write', async ({ unique }) => {
    const id = await seedBlog(unique);
    const body = { title: `Edited matrix ${unique}`, body: '<p>Updated matrix article.</p>', excerpt: 'Revised excerpt', tags: ['revised'], seoTitle: 'Matrix SEO' };
    return { url: `/v1/admin/blog/${id}`, body, async verify(response, proof) {
      const row = await blogRow(id);
      proof.equal(await json(response), { id, seoRevision: hash(row) }, 'exact updated blog revision');
      proof.equal({ title: row.title, body: row.body, bodyHtml: row.bodyHtml, excerpt: row.excerpt, tags: row.tags, seoTitle: row.seoTitle },
        { ...body, bodyHtml: body.body }, 'blog patch committed', 'state');
    } };
  });
  add('DELETE /v1/admin/blog/{id}', 'delete', async ({ unique }) => {
    const id = await seedBlog(unique);
    return { url: `/v1/admin/blog/${id}`, async verify(response, proof) {
      await idResponse(response, proof, id);
      proof.equal(await query('select id from blog_post where id=$1', [id]), [], 'blog deleted', 'state');
    } };
  });

  const seedCollection = (unique: string) => insertId('insert into collection(store_id,name,slug,description,published) values ($1,$2,$3,$4,true) returning id',
    [fixture.storeId, `Matrix collection ${unique}`, `matrix-${unique}`, 'Matrix collection description']);
  add('POST /v1/admin/collections', 'write', async ({ unique }, principal) => {
    const body = { name: `Created matrix ${unique}`, slug: `matrix-${unique}`, description: 'Created collection', published: false, seoTitle: 'Matrix collection SEO' };
    return { url: '/v1/admin/collections', body, async verify(response, proof) {
      const saved = await one('select id,name,slug,description,published,seo_title,parent_id,rules from collection where slug=$1', [body.slug]);
      proof.equal(await json(response), { id: saved.id, slug: body.slug }, 'exact created collection response');
      proof.equal(saved, { id: saved.id, name: body.name, slug: body.slug, description: body.description, published: false, seo_title: body.seoTitle, parent_id: null, rules: null }, 'collection committed', 'state');
      await audit(proof, 'collection', saved.id, 'create', principal, { name: body.name });
    } };
  });
  add('GET /v1/admin/collections/{id}', 'read', async ({ unique, productId }) => {
    const id = await seedCollection(unique);
    await query('insert into collection_product(store_id,collection_id,product_id,position) values ($1,$2,$3,2)', [fixture.storeId, id, productId]);
    return { url: `/v1/admin/collections/${id}`, async verify(response, proof) {
      const product = await one('select id,name,status from product where id=$1', [productId]);
      proof.equal(await json(response), { id, slug: `matrix-${unique}`, name: `Matrix collection ${unique}`, description: 'Matrix collection description', parentId: null, rules: null, published: true, seoTitle: null, seoDescription: null, smart: false, products: [{ ...product, position: 2 }] }, 'exact collection detail with owned product');
    } };
  });
  add('PATCH /v1/admin/collections/{id}', 'write', async ({ unique }) => {
    const id = await seedCollection(unique), body = { name: `Revised collection ${unique}`, published: false, seoTitle: 'Revised SEO', description: null };
    return { url: `/v1/admin/collections/${id}`, body, async verify(response, proof) {
      await idResponse(response, proof, id);
      proof.equal(await one('select name,published,seo_title,description from collection where id=$1', [id]), { name: body.name, published: false, seo_title: body.seoTitle, description: null }, 'collection patch committed', 'state');
    } };
  });
  add('DELETE /v1/admin/collections/{id}', 'delete', async ({ unique, productId }, principal) => {
    const id = await seedCollection(unique);
    await query('insert into collection_product(store_id,collection_id,product_id) values ($1,$2,$3)', [fixture.storeId, id, productId]);
    return { url: `/v1/admin/collections/${id}`, async verify(response, proof) {
      await idResponse(response, proof, id);
      proof.equal(await query('select id from collection where id=$1', [id]), [], 'collection deleted', 'state');
      proof.equal(await query('select product_id from collection_product where collection_id=$1', [id]), [], 'membership removed', 'state');
      proof.equal(await query('select id from product where id=$1', [productId]), [{ id: productId }], 'product retained', 'state');
      await audit(proof, 'collection', id, 'delete', principal);
    } };
  });
  add('POST /v1/admin/collections/{id}/products', 'write', async ({ unique, productId }) => {
    const id = await seedCollection(unique);
    return { url: `/v1/admin/collections/${id}/products`, body: { productId }, async verify(response, proof) {
      await okResponse(response, proof);
      proof.equal(await query('select product_id,position from collection_product where collection_id=$1', [id]), [{ product_id: productId, position: 0 }], 'membership committed', 'state');
    } };
  });
  add('DELETE /v1/admin/collections/{id}/products/{productId}', 'delete', async ({ unique, productId }) => {
    const id = await seedCollection(unique);
    await query('insert into collection_product(store_id,collection_id,product_id) values ($1,$2,$3)', [fixture.storeId, id, productId]);
    return { url: `/v1/admin/collections/${id}/products/${productId}`, async verify(response, proof) {
      await okResponse(response, proof);
      proof.equal(await query('select product_id from collection_product where collection_id=$1 and product_id=$2', [id, productId]), [], 'membership removed', 'state');
      proof.equal(await query('select id from collection where id=$1', [id]), [{ id }], 'collection retained', 'state');
    } };
  });

  const seedReview = (productId: string, unique: string) => insertId('insert into product_review(store_id,product_id,author_name,author_email,rating,body,status) values ($1,$2,$3,$4,4,$5,$6) returning id',
    [fixture.storeId, productId, 'Matrix Reviewer', `review-${unique}@matrix.invalid`, 'Matrix review text', 'pending']);
  for (const action of ['approve', 'reject', 'delete'] as const) {
    add(action === 'delete' ? 'DELETE /v1/admin/reviews/{id}' : `POST /v1/admin/reviews/{id}/${action}`, action === 'delete' ? 'delete' : 'write', async ({ productId, unique }, principal) => {
      const id = await seedReview(productId, unique);
      return { url: action === 'delete' ? `/v1/admin/reviews/${id}` : `/v1/admin/reviews/${id}/${action}`, async verify(response, proof) {
        proof.equal(await json(response), { ok: true, bonusPoints: 0 }, 'exact review moderation response');
        if (action === 'delete') proof.equal(await query('select id from product_review where id=$1', [id]), [], 'review deleted', 'state');
        else proof.equal(await one('select status,moderated_by,moderated_at is not null as moderated,bonus_points from product_review where id=$1', [id]),
          { status: action === 'approve' ? 'approved' : 'rejected', moderated_by: actor(principal), moderated: true, bonus_points: 0 }, 'moderation and actor committed', 'state');
        await audit(proof, 'review', id, `review_${action}`, principal, { productId, bonusPoints: 0 });
        if (action === 'approve') proof.equal(await query('select kind,recipient from email_outbox where recipient=$1', [`review-${unique}@matrix.invalid`]),
          [{ kind: 'review_approved', recipient: `review-${unique}@matrix.invalid` }], 'approval notification queued once', 'state');
      } };
    });
  }
  add('PUT /v1/admin/reviews/{id}/reply', 'write', async ({ productId, unique }, principal) => {
    const id = await seedReview(productId, unique);
    return { url: `/v1/admin/reviews/${id}/reply`, body: { reply: 'Matrix merchant reply' }, async verify(response, proof) {
      await okResponse(response, proof);
      proof.equal(await one('select reply,replied_at is not null as replied from product_review where id=$1', [id]), { reply: 'Matrix merchant reply', replied: true }, 'review reply committed', 'state');
      await audit(proof, 'review', id, 'review_reply', principal, { cleared: false });
    } };
  });
  add('PUT /v1/admin/reviews-settings', 'write-manage', async () => {
    const body = { enabled: true, allowGuests: true, autoApprove: false, requirePurchase: true };
    return { url: '/v1/admin/reviews-settings', body, async verify(response, proof) {
      proof.equal(await json(response), body, 'exact review settings response');
      proof.equal(await one("select config->'reviews' as reviews from store where id=$1", [fixture.storeId]), { reviews: body }, 'review settings committed', 'state');
    } };
  });
  add('PUT /v1/admin/currency-rates/{currency}', 'manage', async (_seed, principal) => {
    await query("insert into currency_rate(store_id,currency,rate,enabled) values ($1,'EUR',9000,true) on conflict(store_id,currency) do update set rate=9000,enabled=true", [fixture.storeId]);
    return { url: '/v1/admin/currency-rates/eur', body: { rate: 9250, enabled: false }, async verify(response, proof) {
      proof.equal(await json(response), { currency: 'EUR', rate: 9250 }, 'exact normalized currency response');
      proof.equal(await one("select currency,rate,enabled from currency_rate where currency='EUR'"), { currency: 'EUR', rate: 9250, enabled: false }, 'presentment rate committed', 'state');
      const rows = await query("select actor,data from audit_log where entity='currency_rate' and entity_id='EUR' and action='upsert' and actor=$1", [actor(principal)]);
      proof.equal(rows, [{ actor: actor(principal), data: { rate: 9250, enabled: false } }], 'currency actor provenance', 'state');
    } };
  });

  const seedCustomer = (unique: string) => insertId('insert into customer(store_id,email,first_name,last_name,email_verified) values ($1,$2,$3,$4,true) returning id',
    [fixture.storeId, `customer-${unique}@matrix.invalid`, 'Matrix', 'Customer']);
  add('POST /v1/admin/customers', 'write', async ({ unique }) => {
    const email = `created-${unique}@matrix.invalid`;
    const body = { email: email.toUpperCase(), firstName: 'Created', lastName: 'Customer', phone: '+12025550123', tags: ['matrix'] };
    return { url: '/v1/admin/customers', body, async verify(response, proof) {
      const saved = await one('select id,email,first_name,last_name,phone,tags from customer where email=$1', [email]);
      await idResponse(response, proof, saved.id);
      proof.equal(saved, { id: saved.id, email, first_name: 'Created', last_name: 'Customer', phone: body.phone, tags: ['matrix'] }, 'normalized customer committed', 'state');
    } };
  });
  add('PATCH /v1/admin/customers/{id}', 'write', async ({ unique }) => {
    const id = await seedCustomer(unique);
    return { url: `/v1/admin/customers/${id}`, body: { firstName: 'Updated', lastName: null, phone: '+12025550124', tags: ['updated'] }, async verify(response, proof) {
      await idResponse(response, proof, id);
      proof.equal(await one('select first_name,last_name,phone,tags from customer where id=$1', [id]), { first_name: 'Updated', last_name: null, phone: '+12025550124', tags: ['updated'] }, 'customer patch committed', 'state');
    } };
  });
  const enableLoyalty = async () => query("update store set config=coalesce(config,'{}'::jsonb)||jsonb_build_object('loyalty',$2::jsonb) where id=$1",
    [fixture.storeId, JSON.stringify({ enabled: true, earnRatePerDollar: 1, pointsPerDollarOff: 10, minRedeemPoints: 0, maxRedeemPercentOfSubtotal: null, expiryDays: null, reviewBonusPoints: 0 })]);
  add('POST /v1/admin/customers/{id}/loyalty/adjust', 'loyalty', async ({ unique }, principal) => {
    const id = await seedCustomer(unique);
    await enableLoyalty();
    const body = { points: 120, reason: `Matrix adjustment ${unique}`, idempotencyKey: `matrix-${unique}` };
    return { url: `/v1/admin/customers/${id}/loyalty/adjust`, body, async verify(response, proof) {
      const saved = await one("select id,kind,points,shortfall,reason,actor,expires_at,source_ref,created_at from loyalty_ledger where customer_id=$1", [id]);
      proof.equal({ kind: saved.kind, points: saved.points, shortfall: saved.shortfall, reason: saved.reason, actor: saved.actor, expires_at: saved.expires_at, source_ref: saved.source_ref },
        { kind: 'adjust', points: 120, shortfall: 0, reason: body.reason, actor: actor(principal), expires_at: null, source_ref: `adjust:${body.idempotencyKey}` }, 'adjustment ledger and actor committed', 'state');
      proof.equal(await json(response), { customerId: id, enabled: true, balance: 120, available: 120, pendingExpiry: 0, availableValue: 1200,
        ledger: [{ id: saved.id, kind: 'adjust', points: 120, shortfall: 0, reason: body.reason, actor: actor(principal), expiresAt: null, createdAt: normalized(saved.created_at), orderCode: null, rule: null, reversible: false }] }, 'exact loyalty adjustment balance and ledger response');
      await audit(proof, 'customer', id, 'loyalty_adjust', principal, { ledgerId: saved.id, points: 120, reason: body.reason, balanceAfter: 120 });
    } };
  });
  add('POST /v1/admin/loyalty/ledger/{id}/reverse', 'loyalty', async ({ unique }, principal) => {
    const customerId = await seedCustomer(unique);
    await enableLoyalty();
    const id = await insertId("insert into loyalty_ledger(store_id,customer_id,kind,points,source_ref,actor,reason,metadata) values ($1,$2,'bonus',75,$3,'system:bonus-signup','bonus_signup',$4::jsonb) returning id",
      [fixture.storeId, customerId, `bonus:signup:${customerId}`, JSON.stringify({ rule: 'signup' })]);
    const reason = `Matrix bonus correction ${unique}`;
    return { url: `/v1/admin/loyalty/ledger/${id}/reverse`, body: { reason }, async verify(response, proof) {
      proof.equal(await json(response), { reversed: 75, shortfall: 0 }, 'exact bonus reversal response');
      proof.equal(await query("select kind,points,shortfall,source_ref,actor,reason,metadata from loyalty_ledger where customer_id=$1 and kind='reverse'", [customerId]),
        [{ kind: 'reverse', points: -75, shortfall: 0, source_ref: `bonus_reverse:${id}`, actor: actor(principal), reason: 'bonus_reversal', metadata: { reversesLedgerId: id, note: reason } }], 'reversal ledger and provenance committed', 'state');
      proof.equal(await one('select sum(points)::int as balance from loyalty_ledger where customer_id=$1', [customerId]), { balance: 0 }, 'loyalty balance restored', 'state');
      proof.equal(await one('select points,source_ref from loyalty_ledger where id=$1', [id]), { points: 75, source_ref: `bonus:signup:${customerId}` }, 'original bonus preserved', 'state');
      await audit(proof, 'loyalty_ledger', id, 'loyalty_bonus_reverse', principal, { reversed: 75, shortfall: 0, reason });
    } };
  });
  add('POST /v1/admin/customers/{id}/verification/clear', 'verification', async ({ unique }, principal) => {
    const id = await seedCustomer(unique);
    const verificationId = `matrix-verification-${unique}`;
    const rowId = await insertId("insert into sheerid_verification(store_id,customer_id,verification_id,program_id,category,status,discount_percent) values ($1,$2,$3,'matrix-program','student','success',10) returning id",
      [fixture.storeId, id, verificationId]);
    await query("update customer set active_verifications=ARRAY['student']::text[],sheerid_verifications=$2::jsonb,verification_metadata=$3::jsonb where id=$1",
      [id, JSON.stringify([{ category: 'student', status: 'verified', verificationId }]), JSON.stringify({ student: { discountPercent: 10 } })]);
    const reason = `Matrix verification correction ${unique}`;
    return { url: `/v1/admin/customers/${id}/verification/clear`, body: { category: 'student', reason }, async verify(response, proof) {
      proof.equal(await json(response), { cleared: ['student'], rowsRevoked: 1, importedRemoved: 0, active: [] }, 'exact verification clear response');
      proof.equal(await one('select status from sheerid_verification where id=$1', [rowId]), { status: 'revoked' }, 'verification revoked', 'state');
      proof.equal(await one('select active_verifications,sheerid_verifications,verification_metadata from customer where id=$1', [id]), { active_verifications: [], sheerid_verifications: [], verification_metadata: {} }, 'customer verification cache cleared', 'state');
      await audit(proof, 'customer', id, 'verification_cleared', principal, { scope: 'student', categories: ['student'], rowsRevoked: 1, importedRemoved: 0, reason });
    } };
  });
  return cases;
}

