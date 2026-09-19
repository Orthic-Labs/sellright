/**
 * SR-08 / SR-09 / SR-03(import) rehearsal tests against disposable fixtures.
 *
 * The source database gets a synthetic Vendure schema in each variant — never
 * real store data:
 *   dd — the Damned Designs shape: SheerID customer fields, order/variant
 *        pre-order fields, blog + affiliate + waitlist plugin tables, NMI and
 *        Sezzle and Stripe payment methods.
 *   rh — the Rotten Hand shape: Listmonk + stripeCustomerId customer fields
 *        only, blog plugin, no affiliate/waitlist tables, Stripe payments.
 *   broken — dd minus a required customer column (preflight failure path).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runMigration } from './run.js';
import { restoreMigration } from './restore.js';
import { migrationId } from './context.js';
import { assertTestDatabase } from '../db/rls-test-utils.js';

function fixtureUrl(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} to a separately provisioned disposable *_test database`);
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !/^\/[a-zA-Z0-9_]+_test$/.test(url.pathname)) {
    throw new Error(`${name} must name a disposable *_test PostgreSQL database`);
  }
  return value;
}
const SOURCE_URL = fixtureUrl('IMPORT_SOURCE_DATABASE_URL');
const TARGET_URL = fixtureUrl('IMPORT_TARGET_DATABASE_URL');
if (new URL(SOURCE_URL).pathname === new URL(TARGET_URL).pathname) {
  throw new Error('Import source and target fixture databases must have different names');
}
assertTestDatabase(SOURCE_URL, 'import source fixture');
assertTestDatabase(TARGET_URL, 'import target fixture');

const sourcePool = new Pool({ connectionString: SOURCE_URL, max: 1 });
const targetPool = new Pool({ connectionString: TARGET_URL, max: 1 });
const tempRoots: string[] = [];
afterAll(async () => {
  await sourcePool.end(); await targetPool.end();
  for (const root of tempRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

type Variant = 'dd' | 'rh' | 'broken';

const TABLE = (name: string, cols: string[]) => `CREATE TABLE ${name} (${cols.join(', ')})`;

/** Every table in REQUIRED_SOURCE_COLUMNS, minimal columns only. */
function buildSource(variant: Variant): string[] {
  const dd = variant !== 'rh';
  const customerCf = variant === 'rh'
    ? ['"customFieldsListmonksubscribedat" timestamp', '"customFieldsStripecustomerid" text']
    : ['"customFieldsListmonksubscribedat" timestamp', '"customFieldsSheeridverifications" text',
      '"customFieldsActiveverifications" text', '"customFieldsVerificationmetadata" text',
      '"customFieldsLegacyflag" text'];
  const statements = [
    TABLE('channel', ['id int PRIMARY KEY', '"defaultCurrencyCode" varchar(3)', '"pricesIncludeTax" boolean', '"defaultTaxZoneId" int']),
    TABLE('region', ['id int PRIMARY KEY', 'code varchar(2)']),
    TABLE('"user"', ['id int PRIMARY KEY', 'verified boolean']),
    TABLE('authentication_method', ['"userId" int', 'type text', '"passwordHash" text']),
    TABLE('customer', ['id int PRIMARY KEY', '"emailAddress" text', '"firstName" text', '"lastName" text',
      '"phoneNumber" text', '"userId" int, "deletedAt" timestamp', '"createdAt" timestamp', '"updatedAt" timestamp', ...customerCf]),
    TABLE('address', ['id int PRIMARY KEY', '"customerId" int', '"fullName" text', '"streetLine1" text', '"streetLine2" text',
      'city text', 'province text', '"postalCode" text', '"phoneNumber" text',
      '"defaultShippingAddress" boolean', '"defaultBillingAddress" boolean', '"countryId" int']),
    TABLE('"order"', ['id int PRIMARY KEY', 'code text', 'state text', '"currencyCode" varchar(3)', '"orderPlacedAt" timestamp',
      '"subTotal" int', '"subTotalWithTax" int', 'shipping int', '"shippingWithTax" int',
      '"shippingAddress" text', '"billingAddress" text', '"couponCodes" text', '"customerId" int',
      '"createdAt" timestamp', '"updatedAt" timestamp', ...(dd ? ['"customFieldsIspreorder" boolean'] : [])]),
    TABLE('order_line', ['id int PRIMARY KEY', '"productVariantId" int', '"orderId" int', 'quantity int',
      '"orderPlacedQuantity" int', '"listPrice" int', '"listPriceIncludesTax" boolean', 'adjustments text', '"taxLines" text']),
    TABLE('product', ['id int PRIMARY KEY', 'enabled boolean', '"featuredAssetId" int', '"deletedAt" timestamp']),
    TABLE('product_translation', ['"baseId" int', '"languageCode" varchar(5)', 'name text', 'slug text', 'description text']),
    TABLE('product_variant', ['id int PRIMARY KEY', '"productId" int', 'sku text', 'enabled boolean',
      '"trackInventory" varchar(20)', '"useGlobalOutOfStockThreshold" boolean', '"outOfStockThreshold" int',
      '"deletedAt" timestamp', '"taxCategoryId" int',
      ...(dd ? ['"customFieldsSaleprice" int', '"customFieldsPreorderprice" int', '"customFieldsIspreorder" boolean', '"customFieldsShipdate" text']
        : ['"customFieldsSaleprice" int'])]),
    TABLE('product_variant_translation', ['"baseId" int', '"languageCode" varchar(5)', 'name text']),
    TABLE('product_variant_price', ['"variantId" int', '"channelId" int', '"currencyCode" varchar(3)', 'price int']),
    TABLE('product_option_group', ['id int PRIMARY KEY', '"deletedAt" timestamp']),
    TABLE('product_option_groups_product_option_group', ['"productOptionGroupId" int', '"productId" int']),
    TABLE('product_option_group_translation', ['"baseId" int', '"languageCode" varchar(5)', 'name text']),
    TABLE('product_option', ['id int PRIMARY KEY', '"groupId" int', '"deletedAt" timestamp']),
    TABLE('product_option_translation', ['"baseId" int', '"languageCode" varchar(5)', 'name text']),
    TABLE('product_variant_options_product_option', ['"productVariantId" int', '"productOptionId" int']),
    TABLE('product_variant_facet_values_facet_value', ['"productVariantId" int', '"facetValueId" int']),
    TABLE('product_facet_values_facet_value', ['"productId" int', '"facetValueId" int']),
    TABLE('facet', ['id int PRIMARY KEY', '"isPrivate" boolean']),
    TABLE('facet_value', ['id int PRIMARY KEY', '"facetId" int']),
    TABLE('facet_value_translation', ['"baseId" int', '"languageCode" varchar(5)', 'name text']),
    TABLE('global_settings', ['id int', '"trackInventory" boolean', '"outOfStockThreshold" int']),
    TABLE('stock_level', ['id int PRIMARY KEY', '"productVariantId" int', '"stockLocationId" int', '"stockOnHand" int', '"stockAllocated" int']),
    TABLE('stock_location', ['id int PRIMARY KEY', 'name text']),
    TABLE('promotion', ['id int PRIMARY KEY', '"couponCode" text', 'conditions text', 'actions text',
      '"startsAt" timestamp', '"endsAt" timestamp', '"usageLimit" int', '"perCustomerUsageLimit" int',
      '"priorityScore" int', 'enabled boolean', '"deletedAt" timestamp']),
    TABLE('collection', ['id int PRIMARY KEY', '"parentId" int', 'position int', '"isPrivate" boolean', '"isRoot" boolean', '"featuredAssetId" int']),
    TABLE('collection_translation', ['"baseId" int', '"languageCode" varchar(5)', 'name text', 'slug text', 'description text']),
    TABLE('collection_product_variants_product_variant', ['"collectionId" int', '"productVariantId" int']),
    TABLE('asset', ['id int PRIMARY KEY', 'type text', 'source text', 'preview text', 'width int', 'height int']),
    TABLE('product_asset', ['"productId" int', '"assetId" int', 'position int']),
    TABLE('product_variant_asset', ['"productVariantId" int', '"assetId" int', 'position int']),
    TABLE('payment', ['id int PRIMARY KEY', '"createdAt" timestamp', '"orderId" int', 'method text', 'state text',
      'amount int', '"transactionId" text', 'metadata text', '"errorMessage" text']),
    TABLE('payment_method', ['id int PRIMARY KEY', 'code text', 'handler text']),
    TABLE('order_line_reference', ['id int PRIMARY KEY', 'discriminator text', '"fulfillmentId" int', '"refundId" int', '"orderLineId" int', 'quantity int']),
    TABLE('fulfillment', ['id int PRIMARY KEY', 'state text', '"trackingCode" text', 'method text', '"handlerCode" text', '"createdAt" timestamp', '"updatedAt" timestamp']),
    TABLE('refund', ['id int PRIMARY KEY', '"paymentId" int', 'total int', 'items int', 'shipping int', 'adjustment int',
      'state text', '"transactionId" text', 'reason text', 'metadata text', '"createdAt" timestamp']),
    TABLE('order_promotions_promotion', ['"orderId" int', '"promotionId" int']),
    TABLE('shipping_method', ['id int PRIMARY KEY', 'code text', 'checker text', 'calculator text', '"deletedAt" timestamp']),
    TABLE('shipping_method_translation', ['"baseId" int', '"languageCode" varchar(5)', 'name text']),
    TABLE('tax_rate', ['id int PRIMARY KEY', 'enabled boolean', '"zoneId" int', '"categoryId" int', 'value int', '"customerGroupId" int']),
    // Plugin tables exist only where the source enabled the plugin. Both
    // stores run BlogPlugin; affiliate + waitlist are DD-only.
    TABLE('blog_post', ['id int PRIMARY KEY', 'title text', 'slug text', 'excerpt text', 'body text', '"bodyHtml" text',
      '"authorName" text', '"readingTime" int', '"featuredAssetId" int', 'tags text', '"isPublished" boolean',
      '"publishDate" timestamp', '"seoTitle" text', '"seoDescription" text']),
    ...(dd ? [
      TABLE('affiliate', ['id int PRIMARY KEY', '"promotionId" int', 'email varchar(320)', '"accessToken" varchar(64)', '"onboardedAt" timestamp']),
      TABLE('affiliate_settle', ['id int PRIMARY KEY', '"promotionId" int', '"amountCents" int', '"periodStartAt" timestamp',
        '"periodEndAt" timestamp', '"settledAt" timestamp', '"txRef" varchar(255)', 'notes text']),
      TABLE('waitlist_signup', ['id int PRIMARY KEY', '"productId" int', '"productSlug" varchar(255)', '"productName" varchar(255)',
        '"variantId" varchar(32)', 'email varchar(320)', 'status varchar(16)', '"notifiedAt" timestamp', '"createdAt" timestamp', '"updatedAt" timestamp']),
    ] : []),
  ];
  return statements;
}

const CORE_SEED = [
  `INSERT INTO channel VALUES (1, 'USD', false, 1)`,
  `INSERT INTO region VALUES (1, 'US')`,
  `INSERT INTO "user" VALUES (10, true)`,
  `INSERT INTO authentication_method VALUES (10, 'NativeAuthenticationMethod', '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy')`,
  `INSERT INTO global_settings VALUES (1, true, 0)`,
  `INSERT INTO stock_location VALUES (1, 'Main warehouse')`,
  `INSERT INTO product VALUES (1, true, NULL, NULL)`,
  `INSERT INTO product_translation VALUES (1, 'en', 'Widget', 'widget', 'A widget')`,
  `INSERT INTO facet VALUES (1, false), (2, true)`,
  `INSERT INTO facet_value VALUES (1, 1), (2, 2), (3, 1)`,
  `INSERT INTO facet_value_translation VALUES (1, 'en', 'edc'), (2, 'en', 'internal-only'), (3, 'en', 'folding knives')`,
  `INSERT INTO product_facet_values_facet_value VALUES (1, 1), (1, 2)`,
  `INSERT INTO product_variant_facet_values_facet_value VALUES (1, 3)`,
  `INSERT INTO asset VALUES (5, 'image', 'img.png', NULL, 100, 100)`,
  `INSERT INTO stock_level VALUES (1, 1, 1, 5, 0)`,
  `INSERT INTO tax_rate VALUES (1, true, 1, 1, 0, NULL)`,
  `INSERT INTO shipping_method VALUES (1, 'standard',
     '{"code":"default-shipping-eligibility-checker","args":[{"name":"orderMinimum","value":"0"}]}',
     '{"code":"default-shipping-calculator","args":[{"name":"rate","value":"500"},{"name":"taxRate","value":"0"},{"name":"includesTax","value":"exclude"}]}', NULL)`,
  `INSERT INTO shipping_method_translation VALUES (1, 'en', 'Standard')`,
  `INSERT INTO blog_post VALUES
     (1, 'Hello World', 'hello-world', 'intro', '# Hello', '<p>Hello</p>', 'Admin', 2, 5, '["news","launch"]', true, '2024-02-01 00:00:00', 'SEO title', 'SEO desc'),
     (2, 'Draft Post', 'draft-post', 'ex', 'body', '<p>body</p>', 'Admin', 1, NULL, NULL, false, NULL, NULL, NULL)`,
];

const DD_SEED = [
  `INSERT INTO customer VALUES (1, 'Buyer@Example.COM', 'Buyer', 'One', '555-1', 10, NULL,
     '2024-01-01 00:00:00', '2024-01-02 00:00:00', '2024-02-01 00:00:00',
     '[{"verify":"ok"}]', '["military"]', '{"ip":"1.2.3.4"}', 'legacy')`,
  `INSERT INTO address VALUES (1, 1, 'Buyer One', '1 Main St', NULL, 'Austin', 'TX', '78701', '555-1', true, true, 1)`,
  `INSERT INTO product_variant VALUES (1, 1, 'SKU-1', true, 'TRUE', false, 0, NULL, 1, 1500, 800, false, '2024-06-01')`,
  `INSERT INTO product_variant_translation VALUES (1, 'en', 'Widget Default')`,
  `INSERT INTO product_variant_price VALUES (1, 1, 'USD', 1000)`,
  `INSERT INTO promotion VALUES
     (10, 'AFF10', '[]', '[{"code":"order_percentage_discount","args":[{"name":"discount","value":"10"}]}]', NULL, NULL, NULL, NULL, 0, true, NULL),
     (77, 'OLD20', '[]', '[{"code":"order_percentage_discount","args":[{"name":"discount","value":"20"}]}]', NULL, NULL, NULL, NULL, 0, false, NULL)`,
  `INSERT INTO "order" VALUES
     (1, 'ORD-1', 'PaymentSettled', 'USD', '2024-03-01 00:00:00', 1000, 1000, 0, 0, '{"line1":"1 Main St"}', '{"line1":"1 Main St"}', 'AFF10', 1, '2024-03-01 00:00:00', '2024-03-01 00:00:00', false),
     (2, 'ORD-2', 'PaymentSettled', 'USD', '2024-03-02 00:00:00', 1000, 1000, 0, 0, NULL, NULL, NULL, NULL, '2024-03-02 00:00:00', '2024-03-02 00:00:00', true),
     (3, 'ORD-3', 'PaymentSettled', 'USD', '2024-03-03 00:00:00', 1000, 1000, 0, 0, NULL, NULL, NULL, NULL, '2024-03-03 00:00:00', '2024-03-03 00:00:00', false)`,
  `INSERT INTO order_line VALUES
     (1, 1, 1, 1, 1, 1000, false, '[]', '[]'),
     (2, 1, 2, 1, 1, 1000, false, '[]', '[]'),
     (3, 1, 3, 1, 1, 1000, false, '[]', '[]')`,
  `INSERT INTO payment_method VALUES
     (1, 'nmi-payment', '{"code":"nmi","args":[{"name":"testMode","value":"false"}]}'),
     (2, 'sezzle', '{"code":"sezzle","args":[]}'),
     (3, 'stripe', '{"code":"stripe","args":[{"name":"testMode","value":"false"}]}')`,
  `INSERT INTO payment VALUES
     (1, '2024-03-01 00:00:00', 1, 'nmi-payment', 'Settled', 1000, 'nmi-txn-100', '{"card":"visa"}', NULL),
     (2, '2024-03-02 00:00:00', 2, 'stripe', 'Settled', 1000, 'pi_live_dd_1', '{"paymentIntentId":"pi_live_dd_1"}', NULL),
     (3, '2024-03-03 00:00:00', 3, 'cod', 'Settled', 1000, NULL, NULL, NULL)`,
  `INSERT INTO order_promotions_promotion VALUES (1, 10)`,
  // affiliate.accessToken is globally unique (not per-store), so the seed is
  // parameterized by a per-run suffix to survive re-runs on the same fixture.
  `INSERT INTO affiliate VALUES
     (1, 10, 'aff@example.com', 'tok_aff_dd_1' || $TAG, '2024-01-10 00:00:00'),
     (2, 77, 'aff2@example.com', 'tok_aff_dd_2' || $TAG, '2024-01-11 00:00:00')`,
  `INSERT INTO affiliate_settle VALUES
     (1, 10, 40, NULL, '2024-04-01 00:00:00', '2024-04-02 00:00:00', 'paypal-9', 'first payout'),
     (2, 77, 25, NULL, '2024-04-01 00:00:00', '2024-04-02 00:00:00', NULL, NULL)`,
  `INSERT INTO waitlist_signup VALUES
     (1, 1, 'widget', 'Widget', NULL, 'Wait@Example.com', 'pending', NULL, '2024-01-05 00:00:00', '2024-01-05 00:00:00'),
     (2, 1, 'widget', 'Widget', '1', 'gone@example.com', 'notified', '2024-02-01 00:00:00', '2024-01-06 00:00:00', '2024-02-01 00:00:00'),
     (3, 1, 'widget', 'Widget', NULL, 'wait@example.com', 'pending', NULL, '2024-01-07 00:00:00', '2024-01-07 00:00:00'),
     (4, 99, 'ghost', 'Ghost', NULL, 'ghost@example.com', 'pending', NULL, '2024-01-08 00:00:00', '2024-01-08 00:00:00')`,
];

const RH_SEED = [
  `INSERT INTO customer VALUES (1, 'Buyer@Example.COM', 'Buyer', 'One', '555-1', 10, NULL,
     '2024-01-01 00:00:00', '2024-01-02 00:00:00', '2024-02-01 00:00:00', 'cus_rh_9')`,
  `INSERT INTO product_variant VALUES (1, 1, 'SKU-1', true, 'TRUE', false, 0, NULL, 1, 1500)`,
  `INSERT INTO product_variant_translation VALUES (1, 'en', 'Widget Default')`,
  `INSERT INTO product_variant_price VALUES (1, 1, 'USD', 1000)`,
  `INSERT INTO "order" VALUES
     (1, 'ORD-1', 'PaymentSettled', 'USD', '2024-03-01 00:00:00', 1000, 1000, 0, 0, NULL, NULL, NULL, 1, '2024-03-01 00:00:00', '2024-03-01 00:00:00'),
     (2, 'ORD-2', 'PaymentSettled', 'USD', '2024-03-02 00:00:00', 1000, 1000, 0, 0, NULL, NULL, NULL, NULL, '2024-03-02 00:00:00', '2024-03-02 00:00:00')`,
  `INSERT INTO order_line VALUES
     (1, 1, 1, 1, 1, 1000, false, '[]', '[]'),
     (2, 1, 2, 1, 1, 1000, false, '[]', '[]')`,
  `INSERT INTO payment_method VALUES
     (1, 'stripe', '{"code":"stripe","args":[{"name":"testMode","value":"false"}]}')`,
  `INSERT INTO payment VALUES
     (1, '2024-03-01 00:00:00', 1, 'stripe', 'Settled', 1000, 'pi_live_rh_9', '{"paymentIntentId":"pi_live_rh_9"}', NULL),
     (2, '2024-03-02 00:00:00', 2, 'cod', 'Settled', 1000, NULL, NULL, NULL)`,
];

async function resetSource(variant: Variant, tag: string) {
  const client = await sourcePool.connect();
  try {
    await client.query('DROP SCHEMA public CASCADE');
    await client.query('CREATE SCHEMA public');
    const seeds = variant === 'rh' ? RH_SEED : DD_SEED;
    for (const statement of [...buildSource(variant), ...CORE_SEED, ...seeds]) {
      // $TAG -> a quoted per-run suffix (globally-unique columns only).
      await client.query(statement.replaceAll('$TAG', `'${tag}'`));
    }
    if (variant === 'broken') await client.query('ALTER TABLE customer DROP COLUMN "emailAddress"');
  } finally {
    client.release();
  }
}

async function targetRows(storeId: string, table: string, extra = '') {
  const client = await targetPool.connect();
  try {
    await client.query(`SELECT set_config('app.current_store', $1, false)`, [storeId]);
    // `store` is the tenant row itself — keyed by id, not store_id.
    const where = table === 'store' ? 'WHERE id = $1' : 'WHERE store_id = $1';
    return (await client.query(`SELECT * FROM "${table}" ${where} ${extra}`, [storeId])).rows;
  } finally {
    client.release();
  }
}
const targetOne = async (storeId: string, table: string, extra = '') => (await targetRows(storeId, table, extra))[0];

async function fixtureConfig(storeId: string, gatewayAccounts: Record<string, { accountId: string; mode?: 'test' | 'live' }>) {
  const root = await mkdtemp(join(tmpdir(), 'sr-import-test-'));
  tempRoots.push(root);
  const sourceAssetRoot = join(root, 'src-assets'), targetAssetRoot = join(root, 'dst-assets');
  await mkdir(sourceAssetRoot, { recursive: true });
  await mkdir(targetAssetRoot, { recursive: true });
  await writeFile(join(sourceAssetRoot, 'img.png'), 'fake-png-bytes');
  return {
    manifestPath: join(root, 'manifest.json'),
    applyManifestPath: join(root, 'manifest-apply.json'),
    config: {
      storeId, slug: 'import-' + storeId.slice(0, 8), name: 'Imported Store',
      sourceKey: 'vendure:test', channelId: 1, currency: 'USD' as const,
      sourceAssetRoot, targetAssetRoot, storefrontUrl: 'https://store.example.test',
      gatewayAccounts,
    },
  };
}

describe('Vendure migration rehearsal (synthetic fixtures)', () => {
  it('fails preflight clearly on a missing required source column', async () => {
    await resetSource('broken', 'x');
    const storeId = randomUUID();
    const f = await fixtureConfig(storeId, { stripe: { accountId: 'acct_dd', mode: 'live' } });
    await expect(runMigration({ sourceUrl: SOURCE_URL, targetUrl: TARGET_URL, config: f.config, manifestPath: f.manifestPath }))
      .rejects.toThrow(/missing required source fields:.*"customer"\."emailAddress"/);
    expect(await targetRows(storeId, 'store')).toEqual([]);
  });

  it('rejects Stripe payments without a declared account identity', async () => {
    await resetSource('rh', 'r' + randomUUID().slice(0, 8));
    const storeId = randomUUID();
    const f = await fixtureConfig(storeId, {});
    await expect(runMigration({ sourceUrl: SOURCE_URL, targetUrl: TARGET_URL, config: f.config, manifestPath: f.manifestPath }))
      .rejects.toThrow('Original gateway account is required: stripe');
  });

  it('quarantines — not rejects — a payment whose declared mode contradicts the source method record', async () => {
    await resetSource('rh', 'r' + randomUUID().slice(0, 8));
    const storeId = randomUUID();
    // Source stripe method records testMode=false (live); the operator declares
    // test. Contradictory evidence = unresolved identity → the row imports (the
    // financial record must exist) with gateway_mode NULL and a quarantine flag.
    const f = await fixtureConfig(storeId, { stripe: { accountId: 'acct_rh', mode: 'test' } });
    const dry = await runMigration({ sourceUrl: SOURCE_URL, targetUrl: TARGET_URL, config: f.config, manifestPath: f.manifestPath });
    const applied = await runMigration({ sourceUrl: SOURCE_URL, targetUrl: TARGET_URL, config: f.config,
      manifestPath: f.applyManifestPath, apply: true, expectedDigest: dry.sourceDigest });
    expect(applied.applied).toBe(true);
    expect((await targetOne(storeId, 'product')).tags).toEqual(['edc', 'folding knives']);
    const stripe = await targetOne(storeId, 'payment', `AND method = 'stripe'`);
    expect(stripe.gateway_mode).toBeNull();
    expect(stripe.gateway_account).toBe('acct_rh'); // declared identity still recorded
    expect(stripe.metadata.vendure.modeQuarantined).toBe('conflict');
    expect(stripe.metadata.vendure.sourceMode).toBe('live');
    const manifest = JSON.parse(await readFile(f.applyManifestPath, 'utf8'));
    const quarantined = manifest.exclusions.filter(
      (e: { type: string; table: string; detail?: string }) => e.type === 'unmappable-source-row' && e.table === 'payment',
    );
    expect(quarantined.some((e: { detail: string }) => /conflict/.test(e.detail) && /stripe/.test(e.detail))).toBe(true);
  });

  it('prefers transaction-level metadata evidence over the declared account mode', async () => {
    await resetSource('rh', 'r' + randomUUID().slice(0, 8));
    // A stripe payment whose own metadata records the mode it ran under: the
    // transaction's record beats both the declared account profile (live) and
    // the current source method config (live) — it ran in test.
    const client = await sourcePool.connect();
    try {
      await client.query(`INSERT INTO "order" VALUES (3, 'ORD-3', 'PaymentSettled', 'USD', '2024-03-03 00:00:00', 1000, 1000, 0, 0, NULL, NULL, NULL, NULL, '2024-03-03 00:00:00', '2024-03-03 00:00:00')`);
      await client.query(`INSERT INTO order_line VALUES (3, 1, 3, 1, 1, 1000, false, '[]', '[]')`);
      await client.query(`INSERT INTO payment VALUES (3, '2024-03-03 00:00:00', 3, 'stripe', 'Settled', 1000, 'pi_test_rh_3', '{"testMode":"true","paymentIntentId":"pi_test_rh_3"}', NULL)`);
    } finally { client.release(); }
    const storeId = randomUUID();
    const f = await fixtureConfig(storeId, { stripe: { accountId: 'acct_rh', mode: 'live' } });
    const dry = await runMigration({ sourceUrl: SOURCE_URL, targetUrl: TARGET_URL, config: f.config, manifestPath: f.manifestPath });
    const applied = await runMigration({ sourceUrl: SOURCE_URL, targetUrl: TARGET_URL, config: f.config,
      manifestPath: f.applyManifestPath, apply: true, expectedDigest: dry.sourceDigest });
    expect(applied.applied).toBe(true);
    const payment = await targetOne(storeId, 'payment', `AND provider_ref = 'pi_test_rh_3'`);
    expect(payment.gateway_mode).toBe('test');
    expect(payment.gateway_account).toBe('acct_rh');
    expect(payment.metadata.vendure.modeQuarantined).toBeUndefined();
    expect(payment.metadata.vendure.txnMode).toBe('test');
  });

  it('quarantines a payment whose only mode signal is the current source method config', async () => {
    await resetSource('rh', 'r' + randomUUID().slice(0, 8));
    // A gateway payment whose declared account mapping has NO mode and whose
    // only other signal is the source payment_method's CURRENT testMode: the
    // current config can never be the sole basis for the historical mode →
    // unresolved quarantine. (A declared account with no mode is not a
    // verified historical mapping.)
    const client = await sourcePool.connect();
    try {
      await client.query(`INSERT INTO "order" VALUES (3, 'ORD-3', 'PaymentSettled', 'USD', '2024-03-03 00:00:00', 1000, 1000, 0, 0, NULL, NULL, NULL, NULL, '2024-03-03 00:00:00', '2024-03-03 00:00:00')`);
      await client.query(`INSERT INTO order_line VALUES (3, 1, 3, 1, 1, 1000, false, '[]', '[]')`);
      await client.query(`INSERT INTO payment_method VALUES (2, 'sezzle', '{"code":"sezzle","args":[{"name":"testMode","value":"true"}]}')`);
      await client.query(`INSERT INTO payment VALUES (3, '2024-03-03 00:00:00', 3, 'sezzle', 'Settled', 1000, 'sez-rh-1', NULL, NULL)`);
    } finally { client.release(); }
    const storeId = randomUUID();
    // sezzle account declared WITHOUT a mode — identity mapped, mode unverified.
    const f = await fixtureConfig(storeId, { stripe: { accountId: 'acct_rh', mode: 'live' }, sezzle: { accountId: 'sez_rh' } });
    const dry = await runMigration({ sourceUrl: SOURCE_URL, targetUrl: TARGET_URL, config: f.config, manifestPath: f.manifestPath });
    const applied = await runMigration({ sourceUrl: SOURCE_URL, targetUrl: TARGET_URL, config: f.config,
      manifestPath: f.applyManifestPath, apply: true, expectedDigest: dry.sourceDigest });
    expect(applied.applied).toBe(true);
    const sezzle = await targetOne(storeId, 'payment', `AND method = 'sezzle'`);
    expect(sezzle.gateway_mode).toBeNull();
    expect(sezzle.gateway_account).toBe('sez_rh'); // account identity still lands
    expect(sezzle.metadata.vendure.modeQuarantined).toBe('unresolved');
    expect(sezzle.metadata.vendure.sourceMode).toBe('test'); // kept as corroborating provenance
    const cod = await targetOne(storeId, 'payment', `AND method = 'cod'`);
    expect(cod.gateway_mode).toBeNull();
    // cod is a non-gateway tender: no mode exists to resolve — absence, not quarantine.
    expect(cod.metadata.vendure.modeQuarantined).toBeUndefined();
    // stripe resolves from the declared mode (corroborated by source) — no flag.
    const stripe = await targetOne(storeId, 'payment', `AND method = 'stripe'`);
    expect(stripe.gateway_mode).toBe('live');
    expect(stripe.metadata.vendure.modeQuarantined).toBeUndefined();
    const manifest = JSON.parse(await readFile(f.applyManifestPath, 'utf8'));
    const quarantined = manifest.exclusions.filter(
      (e: { type: string; table: string; detail?: string }) => e.type === 'unmappable-source-row' && e.table === 'payment' && e.detail?.includes('modeQuarantined'),
    );
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0].detail).toMatch(/unresolved/);
    expect(quarantined[0].detail).toMatch(/sezzle/);
  });

  it('rehearses dry-run/apply/restore for the Rotten Hand schema (no SheerID columns)', async () => {
    await resetSource('rh', 'r' + randomUUID().slice(0, 8));
    const storeId = randomUUID();
    const f = await fixtureConfig(storeId, { stripe: { accountId: 'acct_rh', mode: 'live' } });

    const dry = await runMigration({ sourceUrl: SOURCE_URL, targetUrl: TARGET_URL, config: f.config, manifestPath: f.manifestPath });
    expect(dry.applied).toBe(false);
    // Dry-run rolled back — nothing landed.
    expect(await targetRows(storeId, 'customer')).toEqual([]);

    const manifest = JSON.parse(await readFile(join(f.manifestPath), 'utf8'));
    const excluded = manifest.exclusions.map((e: { type: string; table: string }) => e.type + ':' + e.table);
    expect(excluded).toContain('source-extension-absent:affiliate');
    expect(excluded).toContain('source-extension-absent:affiliate_settle');
    expect(excluded).toContain('source-extension-absent:waitlist_signup');
    expect(excluded).not.toContain('source-extension-absent:blog_post');
    expect(excluded).toContain('not-imported:session');

    const applied = await runMigration({
      sourceUrl: SOURCE_URL, targetUrl: TARGET_URL, config: f.config,
      manifestPath: f.applyManifestPath, apply: true, expectedDigest: dry.sourceDigest,
    });
    expect(applied.applied).toBe(true);
    expect(applied.counts.customer).toBe(1);
    expect(applied.counts.blog_post).toBe(2);
    expect(applied.counts.payment).toBe(2);
    expect(applied.counts.order).toBe(2);

    // Optional-absent custom fields import cleanly: SheerID fields are null,
    // the Stripe customer ref maps to the native column.
    const customer = await targetOne(storeId, 'customer');
    expect(customer.sheerid_verifications).toBeNull();
    expect(customer.active_verifications).toBeNull();
    expect(customer.stripe_customer_id).toBe('cus_rh_9');
    expect(customer.email).toBe('buyer@example.com');

    // Blog posts land in the native table with publication + SEO state.
    const posts = await targetRows(storeId, 'blog_post', 'ORDER BY slug');
    expect(posts.map(p => p.slug)).toEqual(['draft-post', 'hello-world']);
    expect(posts[1]!.is_published).toBe(true);
    expect(posts[1]!.featured_asset_id).toBe(migrationId(storeId, 'vendure:test', 'asset', 5));

    // Imported payments keep provider + ref + original account + ORIGINAL mode.
    const payments = await targetRows(storeId, 'payment', 'ORDER BY created_at');
    const stripe = payments.find(p => p.method === 'stripe')!;
    expect(stripe.provider_ref).toBe('pi_live_rh_9');
    expect(stripe.gateway_account).toBe('acct_rh');
    expect(stripe.gateway_mode).toBe('live');
    const cod = payments.find(p => p.method === 'cod')!;
    expect(cod.gateway_account).toBeNull();
    expect(cod.gateway_mode).toBeNull();
    // cod is a non-gateway tender: no mode exists to resolve, so NULL is plain
    // absence — quarantine is reserved for unverifiable GATEWAY identities.
    expect(cod.metadata.vendure.modeQuarantined).toBeUndefined();

    // The migrated store's Stripe mode is written explicitly from the reviewed
    // account profile — never left at the default-test fallback.
    const store = await targetOne(storeId, 'store');
    expect(store.config.stripe.mode).toBe('live');
    expect(store.config.paymentAccounts.stripe).toBe('acct_rh');

    // Restore: dry-run validates, apply empties the tenant.
    const appliedManifest = JSON.parse(await readFile(f.applyManifestPath, 'utf8'));
    const restoreDry = await restoreMigration({ targetUrl: TARGET_URL, manifest: appliedManifest });
    expect(restoreDry.restored).toBe(false);
    const restored = await restoreMigration({ targetUrl: TARGET_URL, manifest: appliedManifest, apply: true });
    expect(restored.restored).toBe(true);
    expect(await targetRows(storeId, 'payment')).toEqual([]);
    expect(await targetRows(storeId, 'blog_post')).toEqual([]);
    expect(await targetRows(storeId, 'store')).toEqual([]);
  });

  it('rehearses the Damned Designs schema: business extensions and gateway provenance', async () => {
    const tag = 'd' + randomUUID().slice(0, 8);
    await resetSource('dd', tag);
    const storeId = randomUUID();
    const f = await fixtureConfig(storeId, {
      nmi: { accountId: 'nmi-acct', mode: 'live' },
      sezzle: { accountId: 'sez-acct', mode: 'live' },
      stripe: { accountId: 'acct_dd', mode: 'live' },
    });

    const dry = await runMigration({ sourceUrl: SOURCE_URL, targetUrl: TARGET_URL, config: f.config, manifestPath: f.manifestPath });
    const applied = await runMigration({
      sourceUrl: SOURCE_URL, targetUrl: TARGET_URL, config: f.config,
      manifestPath: f.applyManifestPath, apply: true, expectedDigest: dry.sourceDigest,
    });
    expect(applied.counts.blog_post).toBe(2);
    expect(applied.counts.affiliate).toBe(2);
    expect(applied.counts.affiliate_settle).toBe(2);
    expect(applied.counts.subscriber).toBe(2); // merged (email, product) dupes; ghost product excluded
    expect(applied.counts.payment).toBe(3);
    expect(applied.counts.restock_event).toBe(1); // stock trigger side-effect of the imported on-hand level

    // Customer keeps the SheerID fields when the source declares them.
    const customer = await targetOne(storeId, 'customer');
    expect(customer.sheerid_verifications).toEqual([{ verify: 'ok' }]);
    expect(customer.active_verifications).toEqual(['military']);
    expect(customer.verification_metadata).toEqual({ ip: '1.2.3.4' });
    expect(customer.listmonk_subscribed_at).toBeTruthy();

    // Variant custom fields map when present (DD declares all four).
    const variant = await targetOne(storeId, 'product_variant');
    expect(variant.sale_price).toBe(1500);
    expect(variant.pre_order_price).toBe(800);

    // Affiliate + links + balances: identity preserved, accessToken verbatim,
    // the disabled source promotion backfilled as an inert tombstone.
    const affiliates = await targetRows(storeId, 'affiliate', 'ORDER BY access_token');
    expect(affiliates.map(a => a.access_token)).toEqual(['tok_aff_dd_1' + tag, 'tok_aff_dd_2' + tag]);
    expect(affiliates[0]!.promotion_id).toBe(migrationId(storeId, 'vendure:test', 'promotion', 10));
    expect(affiliates[1]!.promotion_id).toBe(migrationId(storeId, 'vendure:test', 'promotion', 77));
    const tombstone = await targetOne(storeId, 'promotion', `AND id = '${migrationId(storeId, 'vendure:test', 'promotion', 77)}'`);
    expect(tombstone.enabled).toBe(false);
    expect(tombstone.code).toBe('OLD20');
    const settles = await targetRows(storeId, 'affiliate_settle', 'ORDER BY amount_cents');
    expect(settles.map(r => r.amount_cents)).toEqual([25, 40]);
    expect(settles[1]!.tx_ref).toBe('paypal-9');

    // Coupon attribution links order -> affiliate promotion, which is what the
    // unpaid-balance computation reads.
    const order = await targetOne(storeId, 'order', `AND code = 'ORD-1'`);
    expect(order.promotion_id).toBe(migrationId(storeId, 'vendure:test', 'promotion', 10));

    // Waitlist -> subscriber(kind='waitlist'), topic = the exact key the
    // restock sweep claims: restock:<imported-variant-uuid>. The variant-1
    // product has a single imported variant, so both live signups land on it.
    const variantUuid = migrationId(storeId, 'vendure:test', 'variant', 1);
    const subs = await targetRows(storeId, 'subscriber', 'ORDER BY email');
    expect(subs.map(row => [row.email, row.kind, row.topic, row.status])).toEqual([
      ['gone@example.com', 'waitlist', 'restock:' + variantUuid, 'unsubscribed'],
      ['wait@example.com', 'waitlist', 'restock:' + variantUuid, 'confirmed'],
    ]);
    // 'notified' in the source = the one-shot email already fired — imported
    // as the consumed state so the sweep never re-mails it.
    expect(subs[0]!.meta.vendure.status).toBe('notified');
    expect(subs[0]!.unsubscribed_at).toBeTruthy();
    expect(subs[1]!.meta.productName).toBe('Widget');
    expect(subs[1]!.source).toBe('import');
    // Each expanded row shares the signup's group identity (the source
    // waitlist_signup row id, migration-scoped) — the restock claim consumes
    // by group so one signup is one notification, DD parity.
    expect(subs[0]!.signup_group).toBe(migrationId(storeId, 'vendure:test', 'waitlist-signup', 2));
    expect(subs[1]!.signup_group).toBe(migrationId(storeId, 'vendure:test', 'waitlist-signup', 3));
    const store = await targetOne(storeId, 'store');
    expect(store.config.waitlistLabels['restock:' + variantUuid]).toBe('Widget');

    // Imported payments carry provider + original ref + original account+mode.
    const payments = await targetRows(storeId, 'payment', 'ORDER BY created_at');
    const byMethod = Object.fromEntries(payments.map(p => [p.method, p]));
    expect(byMethod.nmi.provider_ref).toBe('nmi-txn-100');
    expect(byMethod.nmi.gateway_account).toBe('nmi-acct');
    expect(byMethod.nmi.gateway_mode).toBe('live');
    expect(byMethod.stripe.provider_ref).toBe('pi_live_dd_1');
    expect(byMethod.stripe.gateway_account).toBe('acct_dd');
    expect(byMethod.stripe.gateway_mode).toBe('live');
    expect(byMethod.cod.gateway_account).toBeNull();
    expect(byMethod.cod.gateway_mode).toBeNull();
    expect(byMethod.cod.metadata.vendure.modeQuarantined).toBeUndefined();
    expect(byMethod.nmi.metadata.vendure).toEqual({ vendureMethod: 'nmi-payment', sourceMode: 'live' });

    // Exclusion list records the unmapped DD-only custom field and the merge.
    const manifest = JSON.parse(await readFile(f.applyManifestPath, 'utf8'));
    const excluded = manifest.exclusions.map((e: { type: string; table: string; detail?: string }) => `${e.type}:${e.table}`);
    expect(excluded).toContain('unmapped-source-field:customer');
    expect(excluded).toContain('merged-duplicate:waitlist_signup');
    // Signup for a product that never made the catalog is named, not dropped.
    expect(excluded).toContain('unmappable-source-row:waitlist_signup');
    expect(excluded).not.toContain('source-extension-absent:blog_post');
  });

  // Patterns observed in the real damned_vendure clone: headers stale vs their
  // lines (settled payment corroborates lines), unresolvable drift kept at
  // header, Vendure's dummy `standard-payment` handler, 'imported' sentinel
  // transaction ids, 'Modifying' orders, 'Created' fulfillments, total-only
  // refunds, and fulfillment/refund refs beyond ordered quantity.
  it('adjudicates real-source money drift by captured payment and keeps documents verbatim', async () => {
    const tag = 'd' + randomUUID().slice(0, 8);
    await resetSource('dd', tag);
    const extra = [
      // ORD-DRIFT-LINES: header stale (5000), lines 4000+6000, settled 10800.
      `INSERT INTO "order" VALUES (10, 'DRIFT-LINES', 'Delivered', 'USD', '2024-03-04', 5000, 5000, 800, 800, NULL, NULL, NULL, 1, '2024-03-04', '2024-03-04', false)`,
      `INSERT INTO order_line VALUES (10, 1, 10, 1, 1, 4000, false, '[]', '[]'), (12, 1, 10, 1, 1, 6000, false, '[]', '[]')`,
      `INSERT INTO payment VALUES (10, '2024-03-04', 10, 'nmi-payment', 'Settled', 10800, 'txn-drift-1', '{}', NULL)`,
      // ORD-DRIFT-UNRES: header 5000, lines 9000, settled 3300 — nothing agrees.
      `INSERT INTO "order" VALUES (11, 'DRIFT-UNRES', 'Delivered', 'USD', '2024-03-05', 5000, 5000, 800, 800, NULL, NULL, NULL, 1, '2024-03-05', '2024-03-05', false)`,
      `INSERT INTO order_line VALUES (11, 1, 11, 1, 1, 9000, false, '[]', '[]')`,
      `INSERT INTO payment VALUES (11, '2024-03-05', 11, 'nmi-payment', 'Settled', 3300, 'txn-drift-2', '{}', NULL)`,
      // ORD-MOD: 'Modifying' admin-edit state + a dummy-handler manual capture.
      `INSERT INTO "order" VALUES (12, 'MOD-1', 'Modifying', 'USD', '2024-03-06', 2000, 2000, 0, 0, NULL, NULL, NULL, 1, '2024-03-06', '2024-03-06', false)`,
      `INSERT INTO order_line VALUES (13, 1, 12, 1, 1, 2000, false, '[]', '[]')`,
      `INSERT INTO payment_method VALUES (9, 'standard-payment', '{"code":"dummy-payment-handler","args":[]}')`,
      `INSERT INTO payment VALUES (12, '2024-03-06', 12, 'standard-payment', 'Settled', 2000, NULL, NULL, NULL)`,
      // Sentinel 'imported' transactionId on a settled NMI payment (order 3).
      `INSERT INTO payment VALUES (9, '2024-03-04', 3, 'nmi-payment', 'Settled', 500, 'imported', '{}', NULL)`,
      // Over-fulfillment: 'Created' fulfillment refs qty 3 on a qty-1 line.
      `INSERT INTO fulfillment VALUES (1, 'Created', 'TRK-1', NULL, NULL, '2024-03-07', '2024-03-07')`,
      `INSERT INTO order_line_reference VALUES (1, 'FulfillmentLine', 1, NULL, 2, 3)`,
      // Total-only refund, over-settled: 1600 refunded vs 1500 captured on ORD-3.
      `INSERT INTO refund VALUES (1, 9, 1600, 0, 0, 0, 'Settled', 're_1', 'over', NULL, '2024-03-08')`,
    ];
    const client = await sourcePool.connect();
    try { for (const stmt of extra) await client.query(stmt); } finally { client.release(); }

    const storeId = randomUUID();
    const f = await fixtureConfig(storeId, {
      nmi: { accountId: 'nmi-acct', mode: 'live' },
      sezzle: { accountId: 'sez-acct', mode: 'live' },
      stripe: { accountId: 'acct_dd', mode: 'live' },
    });
    const dry = await runMigration({ sourceUrl: SOURCE_URL, targetUrl: TARGET_URL, config: f.config, manifestPath: f.manifestPath });
    await runMigration({ sourceUrl: SOURCE_URL, targetUrl: TARGET_URL, config: f.config,
      manifestPath: f.applyManifestPath, apply: true, expectedDigest: dry.sourceDigest });

    // Payment-corroborated drift: line economics become the order totals.
    const drift = await targetOne(storeId, 'order', `AND code = 'DRIFT-LINES'`);
    expect(drift.grand_total).toBe(10800);
    expect(drift.subtotal).toBe(10000);
    // Unresolved drift keeps the source header — no invented totals.
    const unres = await targetOne(storeId, 'order', `AND code = 'DRIFT-UNRES'`);
    expect(unres.grand_total).toBe(5800);
    expect(unres.subtotal).toBe(5000);
    // 'Modifying' imports as Paid (settled admin-edit order).
    const mod = await targetOne(storeId, 'order', `AND code = 'MOD-1'`);
    expect(mod.state).toBe('Paid');

    const payments = await targetRows(storeId, 'payment');
    const manual = payments.find(p => p.method === 'manual')!;
    expect(manual.amount).toBe(2000);
    expect(manual.gateway_mode).toBeNull();
    // Sentinel transactionId never lands in provider_ref; provenance keeps it.
    const ord3 = await targetOne(storeId, 'order', `AND code = 'ORD-3'`);
    const sentinel = payments.find(p => p.order_id === ord3.id && p.method === 'nmi')!;
    expect(sentinel.provider_ref).toBeNull();
    expect(sentinel.metadata.vendure.transactionId).toBe('imported');

    // 'Created' fulfillment imports as Pending; document qty 3 kept, counter clamped.
    const fulfillment = await targetOne(storeId, 'fulfillment');
    expect(fulfillment.state).toBe('Pending');
    const fl = await targetOne(storeId, 'fulfillment_line');
    expect(fl.quantity).toBe(3);
    const line2 = await targetOne(storeId, 'order_line', `AND id = '${fl.order_line_id}'`);
    expect(line2.fulfilled_qty).toBe(1);

    // Total-only refund imports; ORD-3 over-refunded → PartiallyRefunded + flag.
    const refund = await targetOne(storeId, 'refund');
    expect(refund.amount).toBe(1600);
    expect(ord3.state).toBe('PartiallyRefunded');

    const manifest = JSON.parse(await readFile(f.applyManifestPath, 'utf8'));
    const details = manifest.exclusions.map((e: { detail?: string }) => e.detail ?? '').join('\n');
    expect(details).toContain('DRIFT-LINES');
    expect(details).toContain('stale vs reconstructed lines');
    expect(details).toContain('DRIFT-UNRES');
    expect(details).toContain('review required');
    expect(details).toContain('total-only source record');
    expect(details).toContain('exceed settled payments');
    expect(details).toContain('fulfillment refs exceed ordered quantity');
    expect(details).toContain('sentinel transactionId');
  });
});
