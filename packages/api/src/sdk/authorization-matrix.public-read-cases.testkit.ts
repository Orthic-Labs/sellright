/** Public storefront route contracts, with real tenant-scoped positive fixtures. */
import { randomUUID } from 'node:crypto';
import type { createAuthorizationFixtures } from './authorization-matrix.fixtures.testkit.js';
import type { MatrixCase, MatrixCell, MatrixPrincipal, MatrixProof, PreparedMatrixCell } from './authorization-matrix.testkit.js';
import { invalidateStoreCache } from '../store-context.js';

type CoreFixture = Awaited<ReturnType<typeof createAuthorizationFixtures>>;
export type MatrixPublicReadFixture = Pick<CoreFixture,
  'queryStore' | 'storeId' | 'storeSlug' | 'foreignStoreId' | 'requestHeaders' | 'seedProduct' |
  'expectedAasaAppIds' | 'customerHeaders' | 'expectedCustomerId'>;
type Json = Record<string, any>;
type PreparedRead = { url: string; verify: PreparedMatrixCell['verify'] };
const indexKey = '0123456789abcdef0123456789abcdef';

/** Enumerated mapping is deliberate: service/cache credentials do not restrict public reads. */
function publicCells(f: MatrixPublicReadFixture, prepare: () => Promise<PreparedRead>): Record<MatrixPrincipal, MatrixCell> {
  const cell = (principal: MatrixPrincipal): MatrixCell => ({
    effect: 'allow', status: 200,
    async prepare() { return { ...await prepare(), init: { headers: f.requestHeaders[principal] } }; },
  });
  return { owner: cell('owner'), manager: cell('manager'), staff: cell('staff'), read_only: cell('read_only'),
    agent: cell('agent'), foreign_store: cell('foreign_store'), release_service: cell('release_service'), cache_token: cell('cache_token') };
}

async function configure(f: MatrixPublicReadFixture) {
  const origin = `https://${f.storeSlug}.matrix.invalid`, name = `Public ${f.storeSlug}`;
  const patch = {
    published: true,
    identity: { storeName: name, tagline: 'Matrix public identity', supportEmail: 'public@matrix.invalid', siteOrigin: origin },
    seo: { siteUrl: origin, contactEmail: 'public@matrix.invalid',
      organization: { name, logo: origin + '/logo.png', sameAs: [origin + '/social'] },
      robotsDisallow: ['private-matrix'], staticPaths: ['/', '/matrix-about/'],
      productUrlPattern: '/products/{slug}/', indexNow: { key: indexKey } },
    reviews: { enabled: true, allowGuests: false, autoApprove: false, requirePurchase: false },
    payments: { stripe: false, nmi: false, sezzle: false },
  };
  await f.queryStore(f.storeId, `UPDATE store SET config=coalesce(config,'{}'::jsonb)||$2::jsonb WHERE id=$1`, [f.storeId, JSON.stringify(patch)]);
  invalidateStoreCache(f.storeSlug);
  return { origin, name };
}

async function catalogFixture(f: MatrixPublicReadFixture) {
  const own = await f.seedProduct(), foreign = await f.seedProduct(f.foreignStoreId);
  const slug = `public-${randomUUID()}`, foreignSlug = `foreign-${randomUUID()}`;
  const name = `Public product ${randomUUID()}`, foreignName = 'Foreign private catalog sentinel';
  const collectionId = randomUUID(), foreignCollectionId = randomUUID(), collectionSlug = `collection-${randomUUID()}`;
  await f.queryStore(f.storeId, `UPDATE product SET slug=$2,name=$3,description='Public product description',tags=ARRAY['public-matrix']::text[] WHERE id=$1`, [own.productId, slug, name]);
  await f.queryStore(f.storeId, `UPDATE stock SET on_hand=17,allocated=2 WHERE variant_id=$1`, [own.variantId]);
  await f.queryStore(f.foreignStoreId, `UPDATE product SET slug=$2,name=$3 WHERE id=$1`, [foreign.productId, foreignSlug, foreignName]);
  await f.queryStore(f.storeId, `INSERT INTO collection(id,store_id,slug,name,description,published) VALUES($1,$2,$3,'Public collection','Public collection description',true)`, [collectionId, f.storeId, collectionSlug]);
  await f.queryStore(f.storeId, `INSERT INTO collection_product(store_id,collection_id,product_id) VALUES($1,$2,$3)`, [f.storeId, collectionId, own.productId]);
  // Same collection slug in B makes an accidental missing store filter observable.
  await f.queryStore(f.foreignStoreId, `INSERT INTO collection(id,store_id,slug,name,published) VALUES($1,$2,$3,'Foreign collection',true)`, [foreignCollectionId, f.foreignStoreId, collectionSlug]);
  await f.queryStore(f.foreignStoreId, `INSERT INTO collection_product(store_id,collection_id,product_id) VALUES($1,$2,$3)`, [f.foreignStoreId, foreignCollectionId, foreign.productId]);
  return { ...own, slug, name, foreignSlug, foreignProductId: foreign.productId, collectionSlug };
}

async function blogFixture(f: MatrixPublicReadFixture) {
  const id = randomUUID(), foreignId = randomUUID(), slug = `post-${randomUUID()}`, foreignSlug = `foreign-post-${randomUUID()}`;
  const draftId = randomUUID();
  await f.queryStore(f.storeId, `INSERT INTO blog_post(id,store_id,title,slug,excerpt,body_html,author_name,reading_time,tags,is_published,publish_date)
    VALUES($1,$2,'Public matrix post',$3,'Public excerpt','<p>Public matrix body</p>','Matrix author',3,'["matrix"]'::jsonb,true,now())`, [id, f.storeId, slug]);
  await f.queryStore(f.storeId, `INSERT INTO blog_post(id,store_id,title,slug,is_published) VALUES($1,$2,'Unpublished matrix post',$3,false)`, [draftId, f.storeId, `draft-${randomUUID()}`]);
  await f.queryStore(f.foreignStoreId, `INSERT INTO blog_post(id,store_id,title,slug,is_published,publish_date) VALUES($1,$2,'Foreign matrix post',$3,true,now())`, [foreignId, f.foreignStoreId, foreignSlug]);
  return { id, slug, foreignId, foreignSlug, draftId };
}

function listedProduct(item: Json | undefined, p: Awaited<ReturnType<typeof catalogFixture>>, proof: MatrixProof) {
  proof.ok(item, 'seeded active product is listed');
  proof.equal(item.slug, p.slug, 'product slug');
  proof.equal(item.name, p.name, 'store A product name');
  proof.equal(item.minPrice, 2500, 'live variant price in minor units');
  proof.equal(item.inStock, true, 'live stock availability');
  proof.equal(item.pricingVariant?.price, 2500, 'display variant belongs to seeded price');
}

function publicKey(key: unknown, proof: MatrixProof) {
  proof.ok(key === null || (typeof key === 'string' && /^pk_(test|live)_/.test(key)), 'only nullable public Stripe key is exposed');
}

async function xmlProof(response: Response, proof: MatrixProof, required: readonly string[], forbidden: readonly string[] = []) {
  const text = await response.text();
  proof.ok(response.headers.get('content-type')?.startsWith('application/xml'), 'XML content type');
  proof.ok(text.startsWith('<?xml version="1.0" encoding="UTF-8"?>'), 'XML declaration');
  proof.ok(text.includes('xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"'), 'sitemap namespace');
  for (const value of required) proof.ok(text.includes(`<loc>${value}</loc>`), `expected sitemap URL ${value}`);
  for (const value of forbidden) proof.ok(!text.includes(value), `foreign/draft URL excluded ${value}`);
}

export function createPublicReadCases(f: MatrixPublicReadFixture): MatrixCase[] {
  const cases: MatrixCase[] = [];
  const add = (path: string, prepare: () => Promise<PreparedRead>) => cases.push({ key: 'GET ' + path, contract: 'public', cells: publicCells(f, prepare) });

  add('/v1/shop/blog', async () => {
    const p = await blogFixture(f);
    return { url: '/v1/shop/blog?take=100', async verify(response: Response, proof: MatrixProof) {
      const b = await response.json() as Json;
      proof.ok(Number.isInteger(b.totalItems) && b.totalItems > 0, 'published blog total');
      proof.ok(Array.isArray(b.items), 'blog items');
      const post = b.items.find((x: Json) => x.id === p.id);
      proof.ok(post, 'published store A post present');
      proof.equal(post.title, 'Public matrix post', 'published title');
      proof.equal(post.authorName, 'Matrix author', 'public author');
      proof.equal(post.readingTime, 3, 'reading time');
      proof.ok(!b.items.some((x: Json) => [p.foreignId, p.draftId].includes(x.id)), 'foreign & unpublished posts excluded');
    } };
  });
  add('/v1/shop/blog/{slug}', async () => {
    const p = await blogFixture(f);
    return { url: '/v1/shop/blog/' + p.slug, async verify(response: Response, proof: MatrixProof) {
      const b = await response.json() as Json;
      proof.equal(b.id, p.id, 'post belongs to store A');
      proof.equal(b.slug, p.slug, 'post slug');
      proof.equal(b.bodyHtml, '<p>Public matrix body</p>', 'published HTML content');
      proof.equal(b.tags, ['matrix'], 'published tags');
    } };
  });
  add('/v1/shop/catalog/products', async () => {
    const p = await catalogFixture(f);
    return { url: '/v1/shop/catalog/products?collectionSlug=' + p.collectionSlug, async verify(response: Response, proof: MatrixProof) {
      const b = await response.json() as Json;
      proof.equal(b.total, 1, 'collection-filtered store A product total');
      proof.equal(b.items.length, 1, 'one store A product');
      listedProduct(b.items[0], p, proof);
      proof.ok(!b.items.some((x: Json) => x.slug === p.foreignSlug), 'foreign collection member excluded');
    } };
  });
  add('/v1/shop/catalog/search', async () => {
    const p = await catalogFixture(f);
    return { url: '/v1/shop/catalog/search?term=' + encodeURIComponent(p.name) + '&collectionSlug=' + p.collectionSlug, async verify(response: Response, proof: MatrixProof) {
      const b = await response.json() as Json;
      proof.equal(b.total, 1, 'store A search total');
      proof.equal(b.items.length, 1, 'one matching product');
      listedProduct(b.items[0], p, proof);
    } };
  });
  add('/v1/shop/catalog/products/{slug}', async () => {
    const p = await catalogFixture(f);
    return { url: '/v1/shop/catalog/products/' + p.slug, async verify(response: Response, proof: MatrixProof) {
      const b = await response.json() as Json;
      proof.equal(b.productId, p.productId, 'real store A product identity');
      proof.equal(b.name, p.name, 'product name');
      proof.equal(b.description, 'Public product description', 'public description');
      proof.equal(b.currency, 'USD', 'store currency');
      const variant = b.variants.find((v: Json) => v.id === p.variantId);
      proof.ok(variant, 'seeded variant exposed');
      proof.equal(variant.price, 2500, 'variant price');
      proof.equal(variant.availableQuantity, 15, 'on-hand minus allocation');
      proof.equal(variant.inStock, true, 'physical variant availability');
    } };
  });
  add('/v1/shop/catalog/products/{slug}/stock', async () => {
    const p = await catalogFixture(f);
    const sku = (await f.queryStore(f.storeId, `SELECT sku FROM product_variant WHERE id=$1`, [p.variantId])).rows[0]!.sku;
    return { url: '/v1/shop/catalog/products/' + p.slug + '/stock', async verify(response: Response, proof: MatrixProof) {
      const b = await response.json() as Json;
      proof.equal(b.variants.length, 1, 'single enabled variant');
      proof.equal(b.variants[0].sku, sku, 'stock SKU belongs to store A');
      proof.equal(b.variants[0].availableQuantity, 15, 'live stock count');
      proof.equal(b.variants[0].inStock, true, 'stock availability');
    } };
  });
  add('/v1/shop/catalog/products/{slug}/reviews', async () => {
    await configure(f);
    const p = await catalogFixture(f), approvedId = randomUUID(), pendingId = randomUUID(), foreignId = randomUUID();
    const review = `INSERT INTO product_review(id,store_id,product_id,author_name,author_email,rating,body,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`;
    await f.queryStore(f.storeId, review, [approvedId, f.storeId, p.productId, 'Public reviewer', 'private-a@matrix.invalid', 4, 'Approved matrix review body', 'approved']);
    await f.queryStore(f.storeId, review, [pendingId, f.storeId, p.productId, 'Pending reviewer', 'pending@matrix.invalid', 1, 'Unpublished review body', 'pending']);
    await f.queryStore(f.foreignStoreId, review, [foreignId, f.foreignStoreId, p.foreignProductId, 'Foreign reviewer', 'private-b@matrix.invalid', 1, 'Foreign review body', 'approved']);
    return { url: '/v1/shop/catalog/products/' + p.slug + '/reviews', async verify(response: Response, proof: MatrixProof) {
      const b = await response.json() as Json;
      proof.equal(b.enabled, true, 'reviews published');
      proof.equal(b.count, 1, 'only approved store A review counted');
      proof.equal(b.average, 4, 'approved rating average');
      proof.equal(b.distribution, { '1': 0, '2': 0, '3': 0, '4': 1, '5': 0 }, 'approved rating distribution');
      proof.equal(b.reviews.length, 1, 'pending & foreign reviews excluded');
      proof.equal(b.reviews[0].id, approvedId, 'approved review identity');
      proof.equal(b.reviews[0].body, 'Approved matrix review body', 'public review content');
      proof.equal(b.reviews[0].authorName, 'Public reviewer', 'public review author');
      proof.ok(!('authorEmail' in b.reviews[0]), 'private review email omitted');
    } };
  });
  add('/v1/shop/catalog/collections', async () => {
    const p = await catalogFixture(f);
    return { url: '/v1/shop/catalog/collections', async verify(response: Response, proof: MatrixProof) {
      const b = await response.json() as Json;
      const matching = b.items.filter((x: Json) => x.slug === p.collectionSlug);
      proof.equal(matching.length, 1, 'one collection for tenant-specific slug');
      proof.equal(matching[0].name, 'Public collection', 'store A collection name');
      proof.equal(matching[0].products, 1, 'store A active product count');
    } };
  });
  add('/v1/shop/collections/{slug}', async () => {
    const p = await catalogFixture(f);
    return { url: '/v1/shop/collections/' + p.collectionSlug, async verify(response: Response, proof: MatrixProof) {
      const b = await response.json() as Json;
      proof.equal(b.name, 'Public collection', 'store A collection identity');
      proof.equal(b.description, 'Public collection description', 'collection description');
      proof.equal(b.total, 1, 'tenant-scoped collection total');
      proof.equal(b.products.length, 1, 'foreign linked product excluded');
      listedProduct(b.products[0], p, proof);
    } };
  });
  add('/v1/shop/currencies', async () => {
    const sql = `INSERT INTO currency_rate(store_id,currency,rate,enabled) VALUES($1,$2,$3,$4) ON CONFLICT(store_id,currency) DO UPDATE SET rate=excluded.rate,enabled=excluded.enabled`;
    await f.queryStore(f.storeId, sql, [f.storeId, 'EUR', 12345, true]);
    await f.queryStore(f.storeId, sql, [f.storeId, 'CAD', 13579, false]);
    await f.queryStore(f.foreignStoreId, sql, [f.foreignStoreId, 'GBP', 98765, true]);
    return { url: '/v1/shop/currencies', async verify(response: Response, proof: MatrixProof) {
      const b = await response.json() as Json;
      proof.equal(b.base, 'USD', 'store base currency');
      proof.equal(b.currencies.find((x: Json) => x.currency === 'EUR'), { currency: 'EUR', rate: 12345 }, 'enabled store A rate');
      proof.ok(!b.currencies.some((x: Json) => x.currency === 'CAD' || x.currency === 'GBP'), 'disabled & foreign rates excluded');
    } };
  });
  add('/v1/shop/shipping-methods', async () => {
    const code = `public-${randomUUID()}`, foreignCode = `foreign-${randomUUID()}`, disabledCode = `disabled-${randomUUID()}`;
    const sql = `INSERT INTO shipping_method(id,store_id,code,name,calculator,enabled) VALUES($1,$2,$3,$4,$5::jsonb,$6)`;
    const calculator = JSON.stringify({ flat: 375, min: 1000, countries: ['US'] });
    await f.queryStore(f.storeId, sql, [randomUUID(), f.storeId, code, 'Public shipping', calculator, true]);
    await f.queryStore(f.storeId, sql, [randomUUID(), f.storeId, disabledCode, 'Disabled shipping', calculator, false]);
    await f.queryStore(f.foreignStoreId, sql, [randomUUID(), f.foreignStoreId, foreignCode, 'Foreign shipping', calculator, true]);
    return { url: '/v1/shop/shipping-methods?country=US&subtotal=2500', async verify(response: Response, proof: MatrixProof) {
      const b = await response.json() as Json;
      proof.equal(b.methods.find((x: Json) => x.code === code), { code, name: 'Public shipping', rate: 375 }, 'eligible store A shipping quote');
      proof.ok(!b.methods.some((x: Json) => [foreignCode, disabledCode].includes(x.code)), 'foreign & disabled shipping excluded');
    } };
  });
  add('/v1/shop/config', async () => {
    await configure(f);
    return { url: '/v1/shop/config', async verify(response: Response, proof: MatrixProof) {
      const b = await response.json() as Json;
      proof.ok(['test', 'live'].includes(b.stripeMode), 'published Stripe mode');
      publicKey(b.stripePublishableKey, proof);
      proof.equal(b.stripeConfigured, false, 'disabled Stripe unavailable for checkout');
      proof.equal(b.gateways, { nmi: null, sezzle: false }, 'disabled gateways omitted');
      proof.equal(typeof b.auth.magicLink, 'boolean', 'public sign-in policy');
    } };
  });
  add('/v1/shop/stripe-key', async () => {
    await configure(f);
    return { url: '/v1/shop/stripe-key', async verify(response: Response, proof: MatrixProof) {
      const b = await response.json() as Json;
      proof.equal(Object.keys(b), ['publishableKey'], 'public key response contains no private fields');
      publicKey(b.publishableKey, proof);
    } };
  });
  add('/v1/shop/identity', async () => {
    const config = await configure(f);
    return { url: '/v1/shop/identity', async verify(response: Response, proof: MatrixProof) {
      const b = await response.json() as Json;
      proof.equal(b.storeName, config.name, 'resolved store A identity');
      proof.equal(b.siteOrigin, config.origin, 'store A canonical origin');
      proof.equal(b.tagline, 'Matrix public identity', 'configured tagline');
      proof.equal(b.supportEmail, 'public@matrix.invalid', 'public support address');
      proof.equal(b.currency, 'USD', 'store currency');
      proof.equal(b.published, true, 'published store identity');
    } };
  });
  add('/v1/shop/seo/jsonld/organization', async () => {
    const config = await configure(f);
    return { url: '/v1/shop/seo/jsonld/organization', async verify(response: Response, proof: MatrixProof) {
      const b = await response.json() as Json;
      proof.equal(b.items.length, 2, 'organization & website schemas');
      const org = b.items.find((x: Json) => x['@type'] === 'Organization');
      proof.ok(org, 'organization schema present');
      proof.equal(org['@context'], 'https://schema.org', 'JSON-LD vocabulary');
      proof.equal(org.name, config.name, 'store A organization');
      proof.equal(org.url, config.origin, 'store A organization URL');
      proof.equal(org.logo, config.origin + '/logo.png', 'configured organization logo');
      proof.equal(org.sameAs, [config.origin + '/social'], 'configured social URL');
      proof.equal(b.items.find((x: Json) => x['@type'] === 'WebSite')?.url, config.origin, 'website canonical origin');
    } };
  });
  add('/v1/shop/seo/jsonld/products/{slug}', async () => {
    const config = await configure(f), p = await catalogFixture(f);
    return { url: '/v1/shop/seo/jsonld/products/' + p.slug, async verify(response: Response, proof: MatrixProof) {
      const b = await response.json() as Json;
      proof.equal(b['@type'], 'Product', 'product schema');
      proof.equal(b.name, p.name, 'store A schema product');
      proof.equal(b.url, config.origin + '/products/' + p.slug + '/', 'canonical product URL');
      proof.equal(b.offers.price, '25.00', 'live schema price');
      proof.equal(b.offers.priceCurrency, 'USD', 'schema currency');
      proof.equal(b.offers.availability, 'https://schema.org/InStock', 'live schema availability');
      proof.equal(response.headers.get('cache-control'), 'no-store', 'stock-bearing response uncached');
    } };
  });
  add('/v1/shop/seo/sitemap.xml', async () => {
    const config = await configure(f);
    await catalogFixture(f);
    return { url: '/v1/shop/seo/sitemap.xml', verify: (response: Response, proof: MatrixProof) => xmlProof(response, proof,
      ['sitemap-main.xml', 'sitemap-products.xml', 'sitemap-collections.xml', 'sitemap-blog.xml'].map(x => config.origin + '/' + x)) };
  });
  add('/v1/shop/seo/sitemap-main.xml', async () => {
    const config = await configure(f);
    return { url: '/v1/shop/seo/sitemap-main.xml', verify: (response: Response, proof: MatrixProof) => xmlProof(response, proof, [config.origin + '/', config.origin + '/matrix-about/']) };
  });
  add('/v1/shop/seo/sitemap-products.xml', async () => {
    const config = await configure(f), p = await catalogFixture(f);
    return { url: '/v1/shop/seo/sitemap-products.xml', verify: (response: Response, proof: MatrixProof) => xmlProof(response, proof,
      [config.origin + '/products/' + p.slug + '/'], [p.foreignSlug]) };
  });
  add('/v1/shop/seo/sitemap-collections.xml', async () => {
    const config = await configure(f), p = await catalogFixture(f);
    const foreignSlug = `foreign-only-${randomUUID()}`;
    await f.queryStore(f.foreignStoreId, `INSERT INTO collection(id,store_id,slug,name,published) VALUES($1,$2,$3,'Foreign only',true)`, [randomUUID(), f.foreignStoreId, foreignSlug]);
    return { url: '/v1/shop/seo/sitemap-collections.xml', verify: (response: Response, proof: MatrixProof) => xmlProof(response, proof,
      [config.origin + '/collections/' + p.collectionSlug + '/'], [foreignSlug]) };
  });
  add('/v1/shop/seo/sitemap-blog.xml', async () => {
    const config = await configure(f), p = await blogFixture(f);
    return { url: '/v1/shop/seo/sitemap-blog.xml', verify: (response: Response, proof: MatrixProof) => xmlProof(response, proof,
      [config.origin + '/blog/' + p.slug + '/'], [p.foreignSlug]) };
  });
  add('/v1/shop/seo/robots.txt', async () => {
    const config = await configure(f);
    return { url: '/v1/shop/seo/robots.txt', async verify(response: Response, proof: MatrixProof) {
      const text = await response.text();
      proof.ok(text.includes('User-agent: *\nAllow: /\n'), 'public crawl policy');
      proof.ok(text.includes('Disallow: /private-matrix\n'), 'configured private path excluded');
      proof.ok(text.includes('Sitemap: ' + config.origin + '/sitemap.xml'), 'store A sitemap origin');
    } };
  });
  add('/v1/shop/seo/indexnow-key.txt', async () => {
    await configure(f);
    return { url: '/v1/shop/seo/indexnow-key.txt', async verify(response: Response, proof: MatrixProof) {
      proof.equal(await response.text(), indexKey, 'configured public IndexNow verification key');
    } };
  });
  add('/.well-known/apple-app-site-association', async () => ({
    url: '/.well-known/apple-app-site-association', async verify(response: Response, proof: MatrixProof) {
      const b = await response.json() as Json;
      proof.ok(f.expectedAasaAppIds.length > 0, 'AASA harness configuration is populated');
      proof.equal(b.webcredentials.apps, f.expectedAasaAppIds, 'configured associated app IDs');
    },
  }));

  const customerCell = (principal: MatrixPrincipal): MatrixCell => ({
    effect: 'deny', status: 401, errorCode: 'NOT_AUTHENTICATED',
    async prepare() { return { url: '/v1/shop/sheerid/status', init: { headers: f.requestHeaders[principal] },
      async verify(response: Response, proof: MatrixProof) {
        const b = await response.json() as Json;
        proof.equal(b.error.code, 'NOT_AUTHENTICATED', 'admin/service token is not customer session');
        proof.equal(b.error.message, 'not authenticated', 'customer authentication required');
      } }; },
  });
  cases.push({ key: 'GET /v1/shop/sheerid/status', contract: 'customer', cells: {
    owner: customerCell('owner'), manager: customerCell('manager'), staff: customerCell('staff'), read_only: customerCell('read_only'),
    agent: customerCell('agent'), foreign_store: customerCell('foreign_store'), release_service: customerCell('release_service'), cache_token: customerCell('cache_token'),
  } });
  return cases;
}

/** Pair eight customer-auth denials with an existing, genuine customer-session success. */
export async function prepareSheeridCustomerControl(f: MatrixPublicReadFixture): Promise<PreparedMatrixCell> {
  const programId = `matrix-program-${randomUUID()}`, expiredProgram = `matrix-expired-${randomUUID()}`;
  const sql = `INSERT INTO sheerid_verification(id,store_id,customer_id,program_id,category,status,expires_at) VALUES($1,$2,$3,$4,$5,'success',$6)`;
  await f.queryStore(f.storeId, sql, [randomUUID(), f.storeId, f.expectedCustomerId, programId, 'student', '2099-01-01T00:00:00Z']);
  await f.queryStore(f.storeId, sql, [randomUUID(), f.storeId, f.expectedCustomerId, expiredProgram, 'expired-matrix', '2000-01-01T00:00:00Z']);
  return { url: '/v1/shop/sheerid/status', init: { headers: f.customerHeaders }, async verify(response: Response, proof: MatrixProof) {
    proof.equal(response.status, 200, 'valid customer may read own verification status');
    const b = await response.json() as Json;
    proof.ok(b.activeVerifications.includes('student'), 'live successful customer category active');
    proof.ok(!b.activeVerifications.includes('expired-matrix'), 'expired category inactive');
    const entry = b.verifications.find((x: Json) => x.programId === programId);
    proof.ok(entry, 'customer verification row returned');
    proof.equal(entry.category, 'student', 'successful program category');
    proof.equal(entry.status, 'success', 'successful verification status');
    proof.equal(entry.expiresAt, '2099-01-01T00:00:00.000Z', 'verification expiry');
  } };
}
