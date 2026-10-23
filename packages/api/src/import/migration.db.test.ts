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
import { Pool, type PoolClient } from 'pg';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runMigration } from './run.js';
import { restoreMigration, planLegacySessionRollback } from './restore.js';
import { migrationId } from './context.js';
import { digest } from './artifacts.js';
import { assertTestDatabase } from '../db/rls-test-utils.js';
import { refundLineCashAmount, refundUnitBases } from '../payments/refund-credit.js';

function fixtureUrl(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} to a separately provisioned disposable *_test database`);
  assertTestDatabase(value, name);
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

/** Current monetary-credit plugin shape; every fixture remains synthetic. */
async function createCreditSource(client: PoolClient) {
  await client.query(TABLE('account_credit', ['id int PRIMARY KEY', '"createdAt" timestamp NOT NULL DEFAULT now()', '"updatedAt" timestamp NOT NULL DEFAULT now()',
    '"promotionId" int NOT NULL', '"channelId" int NOT NULL DEFAULT 1', '"emailNormalized" text NOT NULL', '"issuanceKey" text NOT NULL',
    '"currencyCode" text NOT NULL', '"initialAmount" int NOT NULL', 'balance int NOT NULL', 'disabled boolean NOT NULL']));
  await client.query(TABLE('account_credit_transaction', ['id int PRIMARY KEY', '"createdAt" timestamp NOT NULL DEFAULT now()', '"updatedAt" timestamp NOT NULL DEFAULT now()',
    '"accountCreditId" int NOT NULL', '"orderId" int', '"orderCode" text', 'kind text NOT NULL', 'status text NOT NULL', 'amount int NOT NULL', 'delta int NOT NULL',
    '"balanceAfter" int', '"relatedTransactionId" int', '"idempotencyKey" text NOT NULL', 'reason text', 'actor text', '"refundId" int', '"orderLineId" int', 'quantity int', 'allocation jsonb']));
}

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
    TABLE('session', ['id int PRIMARY KEY', 'token text', 'type text', 'invalidated boolean', 'expires timestamptz', '"activeChannelId" int', '"activeOrderId" int', '"userId" int']),
    TABLE('administrator', ['"userId" int', '"deletedAt" timestamp']),
    TABLE('order_channels_channel', ['"orderId" int', '"channelId" int', 'PRIMARY KEY ("orderId", "channelId")']),
    TABLE('authentication_method', ['"userId" int', 'type text', '"passwordHash" text']),
    TABLE('customer', ['id int PRIMARY KEY', '"emailAddress" text', '"firstName" text', '"lastName" text',
      '"phoneNumber" text', '"userId" int, "deletedAt" timestamp', '"createdAt" timestamp', '"updatedAt" timestamp', ...customerCf]),
    TABLE('address', ['id int PRIMARY KEY', '"customerId" int', '"fullName" text', '"streetLine1" text', '"streetLine2" text',
      'city text', 'province text', '"postalCode" text', '"phoneNumber" text',
      '"defaultShippingAddress" boolean', '"defaultBillingAddress" boolean', '"countryId" int']),
    TABLE('"order"', ['id int PRIMARY KEY', 'code text', 'state text', '"currencyCode" varchar(3)', '"orderPlacedAt" timestamp',
      '"subTotal" int', '"subTotalWithTax" int', 'shipping int', '"shippingWithTax" int',
      '"shippingAddress" text', '"billingAddress" text', '"couponCodes" text', '"customerId" int',
      '"createdAt" timestamp', '"updatedAt" timestamp', ...(dd ? ['"customFieldsIspreorder" boolean'] : []), 'active boolean NOT NULL DEFAULT false']),
    TABLE('order_line', ['id int PRIMARY KEY', '"productVariantId" int', '"orderId" int', 'quantity int',
      '"orderPlacedQuantity" int', '"listPrice" int', '"listPriceIncludesTax" boolean', 'adjustments text', '"taxLines" text',
      '"shippingLineId" int', '"taxCategoryId" int']),
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
    TABLE('promotion_channels_channel', ['"promotionId" int REFERENCES promotion(id)', '"channelId" int REFERENCES channel(id)',
      'PRIMARY KEY ("promotionId", "channelId")']),
    TABLE('promotion_translation', ['id int PRIMARY KEY', '"baseId" int REFERENCES promotion(id)',
      '"languageCode" varchar(5)', 'name text', 'description text']),
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
    TABLE('shipping_line', ['id int PRIMARY KEY', '"orderId" int', '"shippingMethodId" int',
      '"listPrice" int', '"listPriceIncludesTax" boolean', 'adjustments text', '"taxLines" text']),
    TABLE('surcharge', ['id int PRIMARY KEY', '"orderId" int', '"listPrice" int', '"listPriceIncludesTax" boolean', '"taxLines" text']),
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
  // AFF10 carries a facet-based eligibility condition (facet value 1 = 'edc',
  // a PUBLIC facet on product 1 per product_facet_values_facet_value above) —
  // exercises the de-Vendure translation to a native `at_least_n_in_collections`
  // condition backed by a synthetic collection (see the promotions assertions
  // in the "Damned Designs schema" test below).
  `INSERT INTO promotion VALUES
     (10, 'AFF10', '[{"code":"at_least_n_with_facets","args":[{"name":"minimum","value":"1"},{"name":"facets","value":"[\\"1\\"]"}]}]', '[{"code":"order_percentage_discount","args":[{"name":"discount","value":"10"}]}]', NULL, NULL, NULL, NULL, 0, true, NULL),
     (77, 'OLD20', '[]', '[{"code":"order_percentage_discount","args":[{"name":"discount","value":"20"}]}]', NULL, NULL, NULL, NULL, 0, false, NULL)`,
  `INSERT INTO "order" VALUES
     (1, 'ORD-1', 'PaymentSettled', 'USD', '2024-03-01 00:00:00', 1000, 1000, 0, 0, '{"line1":"1 Main St"}', '{"line1":"1 Main St"}', 'AFF10', 1, '2024-03-01 00:00:00', '2024-03-01 00:00:00', false),
     (2, 'ORD-2', 'PaymentSettled', 'USD', '2024-03-02 00:00:00', 1000, 1000, 0, 0, NULL, NULL, NULL, NULL, '2024-03-02 00:00:00', '2024-03-02 00:00:00', true),
     (3, 'ORD-3', 'PaymentSettled', 'USD', '2024-03-03 00:00:00', 1000, 1000, 0, 0, NULL, NULL, NULL, NULL, '2024-03-03 00:00:00', '2024-03-03 00:00:00', false)`,
  `INSERT INTO order_channels_channel VALUES (1, 1), (2, 1), (3, 1)`,
  `INSERT INTO order_line VALUES
     (1, 1, 1, 1, 1, 1000, false, '[]', '[]', NULL, 1),
     (2, 1, 2, 1, 1, 1000, false, '[]', '[]', NULL, 1),
     (3, 1, 3, 1, 1, 1000, false, '[]', '[]', NULL, 1)`,
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
  `INSERT INTO order_channels_channel VALUES (1, 1), (2, 1)`,
  `INSERT INTO order_line VALUES
     (1, 1, 1, 1, 1, 1000, false, '[]', '[]', NULL, 1),
     (2, 1, 2, 1, 1, 1000, false, '[]', '[]', NULL, 1)`,
  `INSERT INTO payment_method VALUES
     (1, 'stripe', '{"code":"stripe","args":[{"name":"testMode","value":"false"}]}')`,
  `INSERT INTO payment VALUES
     (1, '2024-03-01 00:00:00', 1, 'stripe', 'Settled', 1000, 'pi_live_rh_9', '{"paymentIntentId":"pi_live_rh_9"}', NULL),
     (2, '2024-03-02 00:00:00', 2, 'cod', 'Settled', 1000, NULL, NULL, NULL)`,
];

/** Explicit selected-channel membership & hydrated translation facts for seeded promotions. */
async function seedPromotionScope(client: PoolClient, ids: number[]) {
  await client.query(`INSERT INTO promotion_channels_channel ("promotionId", "channelId")
    SELECT id, 1 FROM promotion WHERE id = ANY($1::int[])`, [ids]);
  await client.query(`INSERT INTO promotion_translation (id, "baseId", "languageCode", name, description)
    SELECT id, id, 'en', 'Synthetic ' || "couponCode", '' FROM promotion WHERE id = ANY($1::int[])`, [ids]);
}

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
    if (variant !== 'rh') await seedPromotionScope(client, [10, 77]);
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
  it('preserves six incomplete addresses & orphan payment dependency facts in atomic dry/apply/restore output', async () => {
    await resetSource('rh', 'retained-' + randomUUID().slice(0, 8));
    await sourcePool.query(`INSERT INTO address
      (id,"customerId","fullName","streetLine1","streetLine2",city,province,"postalCode","phoneNumber","defaultShippingAddress","defaultBillingAddress","countryId") VALUES
      (1,1,'Buyer One','1 Main St',NULL,'Austin','TX','78701','555-1',true,true,1),
      (100,1,NULL,NULL,'','',NULL,'','',NULL,false,1),
      (101,1,'','','Line 2','City','','Zip',NULL,true,NULL,1),
      (102,1,'Name','Line',NULL,NULL,'State',NULL,'Phone',false,true,1),
      (103,1,'Name','Line','','','State','Zip','Phone',false,false,1),
      (104,1,'Name','Line',NULL,'City','State','Zip','Phone',true,false,NULL),
      (105,1,'Name','Line',NULL,'City','State','Zip','Phone',false,true,999)`);
    await sourcePool.query(`INSERT INTO payment VALUES (99,'2024-03-04 12:34:56.123456',NULL,'unknown-source-method','Authorized',1007,'imported','{"private":"original raw metadata"}','')`);
    await sourcePool.query(`INSERT INTO refund VALUES
      (99,99,17,0,0,0,'Pending','raw-refund-txn','source reason','{"private":true}','2024-03-04 12:35:56.654321'),
      (98,99,13,0,0,0,'Pending',NULL,'earlier source ID','{"private":false}','2024-03-04 12:35:56.123456')`);
    await sourcePool.query(`INSERT INTO order_line_reference VALUES (99,'RefundLine',NULL,99,999,3), (98,'RefundLine',NULL,98,998,2)`);
    // Real JSONB numbers must cross node-pg without becoming JavaScript numbers.
    const exactFacts = String.raw`{"unsafe":9007199254740993,"fraction":0.123456789012345678901234567890,"nested":[{"nullable":null,"values":[9007199254740993,0.123456789012345678901]}],"escaped":"quote \" & slash \\"}`;
    await sourcePool.query('ALTER TABLE payment ALTER COLUMN metadata TYPE jsonb USING metadata::jsonb');
    await sourcePool.query('ALTER TABLE refund ALTER COLUMN metadata TYPE jsonb USING metadata::jsonb');
    await sourcePool.query('UPDATE payment SET metadata=$1::jsonb WHERE id=99', [exactFacts]);
    await sourcePool.query('UPDATE refund SET metadata=$1::jsonb WHERE "paymentId"=99', [exactFacts]);
    await sourcePool.query('ALTER TABLE order_line_reference ADD COLUMN retained_facts jsonb');
    await sourcePool.query('UPDATE order_line_reference SET retained_facts=$1::jsonb WHERE id IN (98,99)', [exactFacts]);
    const originalPayment = (await sourcePool.query(`SELECT to_jsonb(p)::text AS row,
      to_jsonb(p)->>'createdAt' AS created, to_jsonb(p.metadata)::text AS metadata FROM payment p WHERE id=99`)).rows[0];
    const originalRefunds = (await sourcePool.query('SELECT to_jsonb(r)::text AS row FROM refund r WHERE "paymentId"=99 ORDER BY id')).rows.map(row => row.row);
    const originalReferences = (await sourcePool.query('SELECT to_jsonb(r)::text AS row FROM order_line_reference r WHERE id IN (98,99) ORDER BY id')).rows.map(row => row.row);
    const originalAddress = (await sourcePool.query('SELECT to_jsonb(a)::text AS row FROM address a WHERE id=100')).rows[0].row;
    const storeId = randomUUID(), f = await fixtureConfig(storeId, { stripe: { accountId: 'acct_rh', mode: 'live' } });
    const dry = await runMigration({ sourceUrl: SOURCE_URL, targetUrl: TARGET_URL, config: f.config, manifestPath: f.manifestPath });
    expect(dry.counts.address).toBe(1);
    expect(dry.counts.customer_address_draft).toBe(6);
    expect(dry.counts.financial_payment_archive).toBe(1);
    expect(await targetRows(storeId, 'customer_address_draft')).toEqual([]);
    expect(await targetRows(storeId, 'financial_payment_archive')).toEqual([]);
    expect(await targetRows(storeId, 'address')).toEqual([]);
    expect(await targetRows(storeId, 'store')).toEqual([]);
    const applied = await runMigration({ sourceUrl: SOURCE_URL, targetUrl: TARGET_URL, config: f.config,
      manifestPath: f.applyManifestPath, apply: true, expectedDigest: dry.sourceDigest });
    expect(applied.applied).toBe(true);
    const drafts = await targetRows(storeId, 'customer_address_draft', 'ORDER BY source_id');
    expect(drafts).toHaveLength(6);
    expect(drafts[0]).toMatchObject({ source_id: '100', source_customer_id: '1', full_name: null, line1: null,
      line2: '', city: '', phone: '', source_country_id: '1', country_code: 'US', is_default_shipping: null, is_default_billing: false });
    expect(drafts[1]).toMatchObject({ full_name: '', line1: '', phone: null, is_default_shipping: true, is_default_billing: null });
    expect(drafts[5]).toMatchObject({ source_country_id: '999', country_code: null });
    expect(drafts.every(row => /^[a-f0-9]{64}$/.test(row.source_digest))).toBe(true);
    expect(drafts[0].source_digest).toBe(digest({ format: 'retained-pg-jsonb-text-v1', address: originalAddress }));
    const archive = await targetOne(storeId, 'financial_payment_archive');
    expect(archive).toMatchObject({ source_id: '99', source_order_id: null, state: 'Authorized', amount: 1007,
      method: 'unknown-source-method', transaction_id: 'imported', metadata: originalPayment.metadata,
      error_message: '', import_currency_context: 'USD', source_created_at: originalPayment.created,
      source_record: originalPayment.row, source_refunds: originalRefunds, source_references: originalReferences });
    expect(archive.source_digest).toBe(digest({ format: 'retained-pg-jsonb-text-v1', payment: originalPayment.row,
      refunds: originalRefunds, references: originalReferences }));
    for (const raw of [archive.metadata, archive.source_record, ...archive.source_refunds, ...archive.source_references]) {
      expect(raw).toContain('9007199254740993');
      expect(raw).toContain('0.123456789012345678901234567890');
    }
    expect(archive.id).toBe(migrationId(storeId, 'vendure:test', 'financial-payment-archive', 99));
    expect((await targetRows(storeId, 'payment')).some(row => row.id === archive.id)).toBe(false);
    expect((await targetRows(storeId, 'refund')).some(row => row.id === migrationId(storeId, 'vendure:test', 'refund', 99))).toBe(false);
    const operationalAddresses = await targetRows(storeId, 'address');
    expect(operationalAddresses).toHaveLength(1);
    expect(operationalAddresses).toMatchObject([{
      id: migrationId(storeId, 'vendure:test', 'address', 1),
      customer_id: migrationId(storeId, 'vendure:test', 'customer', 1),
      full_name: 'Buyer One', line1: '1 Main St', line2: null, city: 'Austin', province: 'TX',
      postal_code: '78701', phone: '555-1', country: 'US', is_default_shipping: true, is_default_billing: true,
    }]);
    const manifest = JSON.parse(await readFile(f.applyManifestPath, 'utf8'));
    expect(manifest.after.customer_address_draft).toHaveLength(6);
    expect(manifest.after.financial_payment_archive).toHaveLength(1);
    expect(manifest.after.address).toHaveLength(1);
    expect(manifest.after.financial_payment_archive[0]).toMatchObject({ metadata: originalPayment.metadata,
      source_record: originalPayment.row, source_refunds: originalRefunds, source_references: originalReferences });
    // Restore must notice a one-digit change beyond JavaScript's safe integer range.
    const target = await targetPool.connect();
    try {
      await target.query("SELECT set_config('app.current_store', $1, false)", [storeId]);
      await target.query('UPDATE financial_payment_archive SET source_record=$2 WHERE store_id=$1',
        [storeId, originalPayment.row.replace('9007199254740993', '9007199254740992')]);
      await expect(restoreMigration({ targetUrl: TARGET_URL, manifest, apply: true }))
        .rejects.toThrow('Destination or manifest changed; automatic restore refused');
      await target.query('UPDATE financial_payment_archive SET source_record=$2 WHERE store_id=$1', [storeId, originalPayment.row]);
    } finally { target.release(); }
    await restoreMigration({ targetUrl: TARGET_URL, manifest, apply: true });
    expect(await targetRows(storeId, 'customer_address_draft')).toEqual([]);
    expect(await targetRows(storeId, 'financial_payment_archive')).toEqual([]);
    expect(await targetRows(storeId, 'address')).toEqual([]);
    // Unknown dependencies abort the whole transaction rather than disappear.
    await sourcePool.query(`INSERT INTO refund VALUES (100,10000,1,0,0,0,'Settled',NULL,NULL,NULL,NULL)`);
    await expect(runMigration({ sourceUrl: SOURCE_URL, targetUrl: TARGET_URL, config: f.config,
      manifestPath: f.manifestPath + '.unknown' })).rejects.toThrow('Source refund references an unknown payment: 100');
    expect(await targetRows(storeId, 'customer_address_draft')).toEqual([]);
    expect(await targetRows(storeId, 'financial_payment_archive')).toEqual([]);
    expect(await targetRows(storeId, 'store')).toEqual([]);
  });

  it('keeps SQL-null metadata distinct from JSON null through private manifest & restore', async () => {
    await resetSource('rh', 'retained-null-' + randomUUID().slice(0, 8));
    await sourcePool.query('ALTER TABLE payment ALTER COLUMN metadata TYPE jsonb USING metadata::jsonb');
    await sourcePool.query(`INSERT INTO payment VALUES
      (99,'2024-03-04 12:34:56.123456',NULL,'source-method','Authorized',1,NULL,NULL,NULL),
      (100,'2024-03-04 12:34:56.654321',NULL,'source-method','Authorized',1,NULL,'null'::jsonb,NULL)`);
    const storeId = randomUUID(), f = await fixtureConfig(storeId, { stripe: { accountId: 'acct_rh', mode: 'live' } });
    const dry = await runMigration({ sourceUrl: SOURCE_URL, targetUrl: TARGET_URL, config: f.config, manifestPath: f.manifestPath });
    await runMigration({ sourceUrl: SOURCE_URL, targetUrl: TARGET_URL, config: f.config, manifestPath: f.applyManifestPath,
      apply: true, expectedDigest: dry.sourceDigest });
    const archives = new Map<string, Record<string, unknown>>((await targetRows(storeId, 'financial_payment_archive'))
      .map(row => [String(row.source_id), row] as const));
    expect(archives.get('99')?.metadata).toBeNull();
    expect(archives.get('100')?.metadata).toBe('null');
    const manifest = JSON.parse(await readFile(f.applyManifestPath, 'utf8'));
    const retained = new Map<unknown, Record<string, unknown>>(manifest.after.financial_payment_archive
      .map((row: Record<string, unknown>) => [row.source_id, row] as const));
    expect(retained.get('99')).toMatchObject({ metadata: null });
    expect(retained.get('100')).toMatchObject({ metadata: 'null' });
    await restoreMigration({ targetUrl: TARGET_URL, manifest, apply: true });
    expect(await targetRows(storeId, 'financial_payment_archive')).toEqual([]);
  });

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
      await client.query('INSERT INTO order_channels_channel VALUES (3, 1)');
      await client.query(`INSERT INTO order_line VALUES (3, 1, 3, 1, 1, 1000, false, '[]', '[]', NULL, 1)`);
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
      await client.query('INSERT INTO order_channels_channel VALUES (3, 1)');
      await client.query(`INSERT INTO order_line VALUES (3, 1, 3, 1, 1, 1000, false, '[]', '[]', NULL, 1)`);
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

  it('imports valid customer/guest capabilities & active carts, excludes revoked/expired/admin/channel proofs & reconciles final freeze', async () => {
    await resetSource('rh', 's' + randomUUID().slice(0, 8));
    await sourcePool.query(`INSERT INTO "user" VALUES (20, true);
      INSERT INTO customer (id,"emailAddress","firstName","lastName","userId","createdAt","updatedAt")
        VALUES (2,'admin-customer@example.com','Admin','Customer',20,'2024-01-01','2024-01-01');
      INSERT INTO administrator VALUES (20,NULL);
      INSERT INTO "order" (id,code,state,"currencyCode","customerId",active) VALUES (100,'ACTIVE-A','AddingItems','USD',1,true),(101,'ACTIVE-G','AddingItems','USD',NULL,true);
      INSERT INTO order_channels_channel VALUES (100,1),(101,1);
      INSERT INTO order_line (id,"productVariantId","orderId",quantity) VALUES (100,1,100,2),(101,1,101,1);
      INSERT INTO session VALUES
        (100,'source_valid_proof','AuthenticatedSession',false,'2100-01-01',1,100,10),
        (101,'source_guest_proof','AnonymousSession',false,'2100-01-01',1,101,NULL),
        (102,'source_revoked_proof','AuthenticatedSession',true,'2100-01-01',1,100,10),
        (103,'source_expired_proof','AuthenticatedSession',false,'2000-01-01',1,100,10),
        (104,'source_wrong_channel','AuthenticatedSession',false,'2100-01-01',2,100,10),
        (105,'source_admin_proof','AuthenticatedSession',false,'2100-01-01',1,NULL,20)`);
    const storeId = randomUUID();
    const f = await fixtureConfig(storeId, { stripe: { accountId: 'acct_rh', mode: 'live' } });
    const dry = await runMigration({ sourceUrl: SOURCE_URL, targetUrl: TARGET_URL, config: f.config, manifestPath: f.manifestPath });
    await runMigration({ sourceUrl: SOURCE_URL, targetUrl: TARGET_URL, config: f.config, manifestPath: f.applyManifestPath, apply: true, expectedDigest: dry.sourceDigest });
    const grants = await targetRows(storeId, 'legacy_session_grant');
    expect(grants).toHaveLength(2);
    expect(grants.map(row => row.authenticated).sort()).toEqual([false,true]);
    expect(await targetRows(storeId, 'session')).toHaveLength(1);
    expect(await targetRows(storeId, 'cart')).toHaveLength(2);
    expect((await targetRows(storeId, 'cart_line')).map(row => row.quantity).sort()).toEqual([1,2]);
    const manifestText = await readFile(f.applyManifestPath, 'utf8');
    expect(manifestText).not.toContain('source_valid_proof');
    expect(manifestText).not.toContain('source_guest_proof');
    // Sessions/accounts created after import need source reconciliation before rollback.
    const nativeCustomerId = randomUUID(); const nativeSessionId = randomUUID();
    const targetClient = await targetPool.connect();
    try {
      await targetClient.query("SELECT set_config('app.current_store', $1, false)", [storeId]);
      await targetClient.query('INSERT INTO customer (id,store_id,email) VALUES ($1,$2,$3)', [nativeCustomerId, storeId, 'new-native@example.com']);
      await targetClient.query("INSERT INTO session (id,store_id,customer_id,token_hash,expires_at) VALUES ($1,$2,$3,$4,'2100-01-01')", [nativeSessionId, storeId, nativeCustomerId, 'native-session-hash']);
    } finally { targetClient.release(); }
    const rollbackPlan = await planLegacySessionRollback({ targetUrl: TARGET_URL, manifest: JSON.parse(manifestText) });
    expect(rollbackPlan).toMatchObject({ readyToReopen: false, nativeSessionReconciliationRequired: true, accountReconciliationRequired: true });
    expect(rollbackPlan.accountChanges).toContainEqual(expect.objectContaining({ targetCustomerId: nativeCustomerId }));
    expect(rollbackPlan.nativeSessions).toContainEqual(expect.objectContaining({ targetSessionId: nativeSessionId, imported: false, state: 'active', sourceBridgeRequired: true }));
    expect(JSON.stringify(rollbackPlan.nativeSessions)).not.toMatch(/token_hash|native-session-hash|source_valid_proof/);
    await targetPool.query('DELETE FROM session WHERE id=$1 AND store_id=$2', [nativeSessionId, storeId]);
    await targetPool.query('DELETE FROM customer WHERE id=$1 AND store_id=$2', [nativeCustomerId, storeId]);
    await restoreMigration({ targetUrl: TARGET_URL, manifest: JSON.parse(manifestText), apply: true });
    await sourcePool.query('UPDATE session SET invalidated=true WHERE id=100');
    await expect(runMigration({ sourceUrl: SOURCE_URL, targetUrl: TARGET_URL, config: f.config,
      manifestPath: f.applyManifestPath + '.stale', apply: true, expectedDigest: dry.sourceDigest })).rejects.toThrow(/changed since dry run/);
    const freeze = await runMigration({ sourceUrl: SOURCE_URL, targetUrl: TARGET_URL, config: f.config, manifestPath: f.manifestPath + '.freeze' });
    await runMigration({ sourceUrl: SOURCE_URL, targetUrl: TARGET_URL, config: f.config,
      manifestPath: f.applyManifestPath + '.freeze', apply: true, expectedDigest: freeze.sourceDigest });
    expect(await targetRows(storeId, 'session')).toHaveLength(0);
    expect(await targetRows(storeId, 'legacy_session_grant')).toHaveLength(1);
  });

  it('retains every active-cart source coupon & blocks parity for unresolved target codes', async () => {
    await resetSource('rh', 'c' + randomUUID().slice(0, 8));
    await sourcePool.query(`INSERT INTO "order" (id,code,state,"currencyCode","customerId",active,"couponCodes") VALUES (100,'ACTIVE-C','AddingItems','USD',1,true,'SAVE,VIP');
      INSERT INTO order_channels_channel VALUES (100,1);
      INSERT INTO session VALUES (100,'source_coupon_proof','AuthenticatedSession',false,'2100-01-01',1,100,10)`);
    const f = await fixtureConfig(randomUUID(), { stripe: { accountId: 'acct_rh', mode: 'live' } });
    const result = await runMigration({ sourceUrl: SOURCE_URL, targetUrl: TARGET_URL, config: f.config, manifestPath: f.manifestPath });
    // This fixture lacks customer-channel membership proof, so auth rollback also blocks parity.
    const expectedParityBlockers = [
      { type: 'unmapped-source-field', table: 'authentication_method', blocking: true,
        detail: 'Auth rollback unavailable; immutable baseline contains explicit identity blockers', count: 2 },
      { type: 'unmapped-source-field', table: 'order', blocking: true,
        detail: 'Active-cart coupon has no unambiguous target promotion; full intent retained for reconciliation',
        count: 2, sourceValues: [JSON.stringify('SAVE,VIP')] },
    ];
    expect(result.parityBlocked).toBe(true);
    expect(result.parityBlockers).toEqual(expectedParityBlockers);
    const manifest = JSON.parse(await readFile(f.manifestPath, 'utf8'));
    expect(manifest.parityBlocked).toBe(true);
    expect(manifest.parityBlockers).toEqual(expectedParityBlockers);
    expect(manifest.rollbackAuthBaseline.blockers.map((blocker: { code: string }) => blocker.code)).toEqual([
      'source_channel_membership_unavailable', 'source_customer_channel_mismatch',
    ]);
    const applied = await runMigration({ sourceUrl: SOURCE_URL, targetUrl: TARGET_URL, config: f.config,
      manifestPath: f.applyManifestPath, apply: true, expectedDigest: result.sourceDigest });
    expect(applied.parityBlockers).toEqual(expectedParityBlockers);
    expect(await targetOne(f.config.storeId, 'cart')).toMatchObject({ coupon_codes: ['SAVE', 'VIP'] });
    expect(await targetOne(f.config.storeId, 'legacy_session_grant')).toMatchObject({ coupon_code: 'SAVE' });
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
    expect(excluded).not.toContain('not-imported:session');

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

  it('moves a configured order-number counter past the highest imported matching code (#309)', async () => {
    await resetSource('rh', 'n' + randomUUID().slice(0, 8));
    const storeId = randomUUID();
    const f = await fixtureConfig(storeId, { stripe: { accountId: 'acct_rh', mode: 'live' } });
    // A store configured before its history arrives: prefix 'ORD-', counter still at 1 (would reuse ORD-1, ORD-2).
    const client = await targetPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_store', $1, true)`, [storeId]);
      await client.query(`INSERT INTO store (id, slug, name, currency) VALUES ($1, $2, 'Imported Store', 'USD')`, [storeId, f.config.slug]);
      await client.query(`INSERT INTO order_number_sequence (store_id, prefix, next_number) VALUES ($1, 'ORD-', 1)`, [storeId]);
      await client.query('COMMIT');
    } finally { client.release(); }
    const dry = await runMigration({ sourceUrl: SOURCE_URL, targetUrl: TARGET_URL, config: f.config, manifestPath: f.manifestPath });
    expect((await targetOne(storeId, 'order_number_sequence')).next_number).toBe('1'); // dry run rolled back
    const applied = await runMigration({ sourceUrl: SOURCE_URL, targetUrl: TARGET_URL, config: f.config,
      manifestPath: f.applyManifestPath, apply: true, expectedDigest: dry.sourceDigest });
    expect(applied.counts.order).toBe(2);
    expect((await targetRows(storeId, 'order', 'ORDER BY code')).map(o => o.code)).toEqual(['ORD-1', 'ORD-2']); // codes kept
    expect(await targetOne(storeId, 'order_number_sequence')).toMatchObject({ prefix: 'ORD-', next_number: '3' });
    // Restore removes the imported tenant data and leaves the forward-only counter configuration in place.
    const restored = await restoreMigration({ targetUrl: TARGET_URL, manifest: JSON.parse(await readFile(f.applyManifestPath, 'utf8')), apply: true });
    expect(restored.restored).toBe(true);
    expect(await targetRows(storeId, 'order')).toEqual([]);
    expect(await targetOne(storeId, 'order_number_sequence')).toMatchObject({ prefix: 'ORD-', next_number: '3' });
  });

  it('retains exact source edit-basis records without changing imported financial projections', async () => {
    await resetSource('rh', 'basis-' + randomUUID().slice(0, 8));
    // Historical shipping was fully discounted; retaining LIST must not turn
    // its 500-cent basis into a new operational shipping charge.
    await sourcePool.query(`INSERT INTO shipping_line VALUES
      (7,1,1,500,false,'[{"amount":-500,"type":"PROMOTION","description":"Historical shipping waiver"}]','[{"taxRate":0}]')`);
    await sourcePool.query('ALTER TABLE surcharge ADD COLUMN description text');
    await sourcePool.query(`INSERT INTO surcharge (id,"orderId","listPrice","listPriceIncludesTax","taxLines",description)
      VALUES (9,1,0,false,'[]','Historical surcharge')`);
    await sourcePool.query('UPDATE order_line SET "shippingLineId"=7, "taxCategoryId"=1 WHERE id=1');
    await sourcePool.query('ALTER TABLE order_line ADD COLUMN "customFieldsRetained" jsonb');
    await sourcePool.query('ALTER TABLE channel ADD COLUMN token text');
    await sourcePool.query('UPDATE channel SET token=$1', ['must-not-enter-edit-basis']);
    await sourcePool.query('ALTER TABLE shipping_method ADD COLUMN "customFieldsRetained" jsonb');
    const exactFacts = String.raw`{"unsafe":9007199254740993,"fraction":0.123456789012345678901,"nullable":null}`;
    await sourcePool.query('UPDATE order_line SET "customFieldsRetained"=$1::jsonb WHERE id=1', [exactFacts]);
    await sourcePool.query('UPDATE shipping_method SET "deletedAt"=$1, "customFieldsRetained"=$2::jsonb WHERE id=1', ['2020-01-01', exactFacts]);
    // Keep a live checkout method alongside the deleted historical method.
    await sourcePool.query(`INSERT INTO shipping_method (id,code,checker,calculator,"deletedAt")
      SELECT 2,'current-standard',checker,calculator,NULL FROM shipping_method WHERE id=1`);
    await sourcePool.query(`INSERT INTO shipping_method_translation VALUES (2,'en','Current standard')`);
    const original = (await sourcePool.query(`SELECT
      (SELECT to_jsonb(o)::text FROM "order" o WHERE id=1) AS header,
      (SELECT to_jsonb(l)::text FROM order_line l WHERE id=1) AS line,
      (SELECT to_jsonb(l)::text FROM shipping_line l WHERE id=7) AS shipping,
      (SELECT to_jsonb(c)::text FROM surcharge c WHERE id=9) AS surcharge,
      (SELECT jsonb_build_object('id',c.id,'defaultCurrencyCode',c."defaultCurrencyCode",
        'pricesIncludeTax',c."pricesIncludeTax",'defaultTaxZoneId',c."defaultTaxZoneId")::text FROM channel c WHERE id=1) AS channel,
      (SELECT to_jsonb(c)::text FROM order_channels_channel c WHERE "orderId"=1 AND "channelId"=1) AS membership,
      (SELECT to_jsonb(m)::text FROM shipping_method m WHERE id=1) AS method`)).rows[0];
    const storeId = randomUUID(), f = await fixtureConfig(storeId, { stripe: { accountId: 'acct_rh', mode: 'live' } });
    const dry = await runMigration({ sourceUrl: SOURCE_URL, targetUrl: TARGET_URL, config: f.config, manifestPath: f.manifestPath });
    expect(await targetRows(storeId, 'order')).toEqual([]);
    await runMigration({ sourceUrl: SOURCE_URL, targetUrl: TARGET_URL, config: f.config,
      manifestPath: f.applyManifestPath, apply: true, expectedDigest: dry.sourceDigest });
    const orderId = migrationId(storeId, 'vendure:test', 'order', 1);
    const order = await targetOne(storeId, 'order', `AND id = '${orderId}'`);
    const basis = order.metadata.vendure.editBasisV1;
    expect(basis).toMatchObject({ version: 1, format: 'retained-pg-jsonb-text-v1', sourceKey: 'vendure:test', sourceOrderId: '1',
      sourceOrderRecord: original.header,
      channel: { sourceId: '1', projection: 'pricing-v1', sourceRecord: original.channel, orderChannelRecord: original.membership },
      shippingMethods: [{ sourceId: '1', sourceRecord: original.method }],
      header: { subTotal: '1000', subTotalWithTax: '1000', shipping: '0', shippingWithTax: '0' },
      shippingLines: [{ sourceId: '7', sourceRecord: original.shipping }],
      surcharges: [{ sourceId: '9', sourceRecord: original.surcharge }],
      lines: [{ sourceId: '1', orderLineId: migrationId(storeId, 'vendure:test', 'order-line', 1), sourceRecord: original.line }] });
    expect(basis.sourceDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(basis.lines[0].sourceRecord).toContain('9007199254740993');
    expect(basis.lines[0].sourceRecord).toContain('0.123456789012345678901');
    expect(basis.shippingMethods[0].sourceRecord).toContain('9007199254740993');
    expect(basis.shippingMethods[0].sourceRecord).toContain('0.123456789012345678901');
    expect(basis.channel.sourceRecord).not.toContain('must-not-enter-edit-basis');
    const { sourceDigest, ...payload } = basis;
    expect(sourceDigest).toBe(digest(payload));
    expect(order).toMatchObject({ subtotal: 1000, discount_total: 0, shipping_total: 0, tax_total: 0, grand_total: 1000,
      shipping_method_code: 'standard' });
    expect((await targetRows(storeId, 'shipping_method')).map(method => method.code)).toEqual(['current-standard']);
    const line = await targetOne(storeId, 'order_line', `AND order_id = '${orderId}'`);
    expect(line).toMatchObject({ unit_price: 1000, line_subtotal: 1000, line_discount: 0, line_tax: 0, line_total: 1000 });
    expect((await targetRows(storeId, 'payment', `AND order_id = '${orderId}'`)).map(payment => payment.amount)).toEqual([1000]);
    const empty = await targetOne(storeId, 'order', `AND id = '${migrationId(storeId, 'vendure:test', 'order', 2)}'`);
    expect(empty.metadata.vendure.editBasisV1).toMatchObject({ shippingLines: [], shippingMethods: [], surcharges: [],
      header: { subTotal: '1000', subTotalWithTax: '1000', shipping: '0', shippingWithTax: '0' } });
  });

  it('archives globally referenced detached shipping history without an operational edit basis', async () => {
    await resetSource('rh', 'detached-' + randomUUID().slice(0, 8));
    await sourcePool.query(`INSERT INTO shipping_method (id,code,checker,calculator,"deletedAt")
      SELECT 2,'detached-history',checker,calculator,'2020-01-01' FROM shipping_method WHERE id=1`);
    await sourcePool.query(`INSERT INTO shipping_line VALUES
      (7,1,1,0,false,'[]','[]'), (8,NULL,2,775,false,'[]','[{"taxRate":10}]')`);
    await sourcePool.query('UPDATE order_line SET "shippingLineId"=8 WHERE id=1');
    await sourcePool.query('ALTER TABLE shipping_line ADD COLUMN "customFieldsExact" jsonb');
    await sourcePool.query(`UPDATE shipping_line SET "customFieldsExact"=$1::jsonb WHERE id=8`,
      [String.raw`{"unsafe":9007199254740993,"fraction":0.123456789012345678901}`]);
    const raw = (await sourcePool.query(`SELECT
      (SELECT to_jsonb(o)::text FROM "order" o WHERE id=1) AS header,
      (SELECT to_jsonb(l)::text FROM order_line l WHERE id=1) AS line,
      (SELECT to_jsonb(l)::text FROM shipping_line l WHERE id=7) AS owned,
      (SELECT to_jsonb(l)::text FROM shipping_line l WHERE id=8) AS detached,
      (SELECT to_jsonb(m)::text FROM shipping_method m WHERE id=2) AS method`)).rows[0];
    const storeId = randomUUID(), f = await fixtureConfig(storeId, { stripe: { accountId: 'acct_rh', mode: 'live' } });
    const dry = await runMigration({ sourceUrl: SOURCE_URL, targetUrl: TARGET_URL, config: f.config, manifestPath: f.manifestPath });
    expect(await targetRows(storeId, 'order')).toEqual([]);
    await runMigration({ sourceUrl: SOURCE_URL, targetUrl: TARGET_URL, config: f.config,
      manifestPath: f.applyManifestPath, apply: true, expectedDigest: dry.sourceDigest });
    const orderId = migrationId(storeId, 'vendure:test', 'order', 1);
    const order = await targetOne(storeId, 'order', `AND id = '${orderId}'`);
    expect(order.metadata.vendure).not.toHaveProperty('editBasisV1');
    const retained = order.metadata.vendure.retainedHistoryV1;
    expect(retained).toMatchObject({ version: 1, format: 'retained-pg-jsonb-text-v1', reason: 'DETACHED_SHIPPING_LINE',
      sourceKey: 'vendure:test', sourceOrderId: '1', sourceOrderRecord: raw.header,
      header: { subTotal: '1000', subTotalWithTax: '1000', shipping: '0', shippingWithTax: '0' },
      shippingLines: [{ sourceId: '7', sourceRecord: raw.owned }],
      referencedDetachedShippingLines: [{ sourceId: '8', sourceRecord: raw.detached }],
      lines: [{ sourceId: '1', orderLineId: migrationId(storeId, 'vendure:test', 'order-line', 1), sourceRecord: raw.line }] });
    expect(retained.shippingMethods.map((method: { sourceId: string }) => method.sourceId)).toEqual(['1', '2']);
    expect(retained.shippingMethods[1]).toEqual({ sourceId: '2', sourceRecord: raw.method });
    expect(retained.referencedDetachedShippingLines[0].sourceRecord).toContain('9007199254740993');
    expect(retained.referencedDetachedShippingLines[0].sourceRecord).toContain('0.123456789012345678901');
    const { sourceDigest, ...payload } = retained;
    expect(sourceDigest).toBe(digest(payload));
    expect(order).toMatchObject({ subtotal: 1000, discount_total: 0, shipping_total: 0, tax_total: 0, grand_total: 1000 });
    expect((await targetRows(storeId, 'payment', `AND order_id = '${orderId}'`)).map(payment => payment.amount)).toEqual([1000]);
    expect(await targetOne(storeId, 'order_line', `AND order_id = '${orderId}'`))
      .toMatchObject({ unit_price: 1000, line_subtotal: 1000, line_discount: 0, line_tax: 0, line_total: 1000 });
    const unaffected = await targetOne(storeId, 'order', `AND id = '${migrationId(storeId, 'vendure:test', 'order', 2)}'`);
    expect(unaffected.metadata.vendure).toHaveProperty('editBasisV1');
    expect(unaffected.metadata.vendure).not.toHaveProperty('retainedHistoryV1');
  });

  it('refuses historical edit-basis capture when a shipping line names a missing source method', async () => {
    await resetSource('rh', 'missing-method-' + randomUUID().slice(0, 8));
    await sourcePool.query(`INSERT INTO shipping_line VALUES (7,1,999,0,false,'[]','[]')`);
    await sourcePool.query('UPDATE order_line SET "shippingLineId"=7 WHERE id=1');
    const storeId = randomUUID(), f = await fixtureConfig(storeId, { stripe: { accountId: 'acct_rh', mode: 'live' } });
    await expect(runMigration({ sourceUrl: SOURCE_URL, targetUrl: TARGET_URL, config: f.config, manifestPath: f.manifestPath }))
      .rejects.toThrow('Edit basis referenced shipping method missing');
    expect(await targetRows(storeId, 'order')).toEqual([]);
  });

  it.each(['missing', 'other-channel'])('refuses historical edit-basis capture with %s order channel ownership', async (ownership) => {
    await resetSource('rh', 'ownership-' + randomUUID().slice(0, 8));
    await sourcePool.query('DELETE FROM order_channels_channel WHERE "orderId"=1');
    if (ownership === 'other-channel') {
      await sourcePool.query(`INSERT INTO channel VALUES (2,'USD',false,1)`);
      await sourcePool.query('INSERT INTO order_channels_channel VALUES (1,2)');
    }
    const storeId = randomUUID(), f = await fixtureConfig(storeId, { stripe: { accountId: 'acct_rh', mode: 'live' } });
    await expect(runMigration({ sourceUrl: SOURCE_URL, targetUrl: TARGET_URL, config: f.config, manifestPath: f.manifestPath }))
      .rejects.toThrow(ownership === 'other-channel'
        ? 'Use a dedicated single-channel source snapshot with the selected currency'
        : 'Edit basis source order ownership missing');
    expect(await targetRows(storeId, 'order')).toEqual([]);
  });

  it('preserves non-date source shipping copy without creating a fulfillment timestamp', async () => {
    await resetSource('dd', 'label-' + randomUUID().slice(0, 8));
    const label = '  Ships late fall & <updates pending>  ';
    await sourcePool.query('UPDATE product_variant SET "customFieldsShipdate" = $1', [label]);
    const storeId = randomUUID();
    const f = await fixtureConfig(storeId, {
      nmi: { accountId: 'nmi-acct', mode: 'live' },
      sezzle: { accountId: 'sez-acct', mode: 'live' },
      stripe: { accountId: 'acct_dd', mode: 'live' },
    });
    const dry = await runMigration({ sourceUrl: SOURCE_URL, targetUrl: TARGET_URL, config: f.config, manifestPath: f.manifestPath });
    await runMigration({ sourceUrl: SOURCE_URL, targetUrl: TARGET_URL, config: f.config,
      manifestPath: f.applyManifestPath, apply: true, expectedDigest: dry.sourceDigest });
    const variant = await targetOne(storeId, 'product_variant');
    expect(variant.metafields.shipDateLabel).toBe(label);
    expect(variant.ship_date).toBeNull();
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
    expect(variant.metafields.shipDateLabel).toBe('2024-06-01');
    expect(variant.ship_date.toISOString()).toBe('2024-06-01T00:00:00.000Z');

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

    // De-Vendure: AFF10's `at_least_n_with_facets` condition (facet value 1,
    // 'edc') is rewritten to native `at_least_n_in_collections`, backed by a
    // synthetic, unpublished collection containing product 1 (the only
    // product carrying that facet value). Runtime never sees a facet id.
    const eligibilityCollectionId = migrationId(storeId, 'vendure:test', 'facet-eligibility-collection', 1);
    const aff10 = await targetOne(storeId, 'promotion', `AND id = '${migrationId(storeId, 'vendure:test', 'promotion', 10)}'`);
    expect(aff10.conditions).toEqual([
      { code: 'at_least_n_in_collections', args: [{ name: 'minimum', value: '1' }, { name: 'collectionIds', value: JSON.stringify([eligibilityCollectionId]) }] },
    ]);
    const eligibilityCollection = await targetOne(storeId, 'collection', `AND id = '${eligibilityCollectionId}'`);
    expect(eligibilityCollection).toMatchObject({ published: false, slug: expect.stringContaining('edc') });
    const eligibilityMembers = await targetRows(storeId, 'collection_product', `AND collection_id = '${eligibilityCollectionId}'`);
    expect(eligibilityMembers.map((m) => m.product_id)).toEqual([migrationId(storeId, 'vendure:test', 'product', 1)]);

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
    expect(byMethod.nmi.id).toBe(migrationId(storeId, 'vendure:test', 'payment', 1));
    expect(byMethod.nmi.metadata.vendure).toEqual({ vendureMethod: 'nmi-payment', sourceMode: 'live', sourcePaymentId: 1, sourceKey: 'vendure:test' });

    // Exclusion list records the unmapped DD-only custom field and the merge.
    const manifest = JSON.parse(await readFile(f.applyManifestPath, 'utf8'));
    const excluded = manifest.exclusions.map((e: { type: string; table: string; detail?: string }) => `${e.type}:${e.table}`);
    expect(excluded).toContain('unmapped-source-field:customer');
    expect(excluded).toContain('merged-duplicate:waitlist_signup');
    // Signup for a product that never made the catalog is named, not dropped.
    expect(excluded).toContain('unmappable-source-row:waitlist_signup');
    expect(excluded).not.toContain('source-extension-absent:blog_post');
  });

  // Migration 0080: Vendure's core schema carries no explicit sortOrder on
  // product_option_group/product_option, so the importer (the one place
  // allowed to know Vendure specifics — see import/catalog.ts) falls back to
  // ascending source id as the "insertion order" proxy. Seeded here with
  // HIGHER ids inserted FIRST into the source, specifically so a naive
  // physical/heap-order import (no explicit ORDER BY) would land them
  // backwards — proving the importer really orders by id, not by whatever
  // order Postgres happens to hand rows back in.
  it('imports stale authorizations on finished orders as history, zero-stocks unstocked variants, and never queues import restocks', async () => {
    const tag = 'a' + randomUUID().slice(0, 8);
    await resetSource('dd', tag);
    for (const statement of [
      `INSERT INTO product_variant VALUES (2, 1, 'SKU-2', true, 'TRUE', false, 0, NULL, 1, NULL, NULL, false, NULL)`,
      `INSERT INTO product_variant_translation VALUES (2, 'en', 'Widget Unstocked')`,
      `INSERT INTO product_variant_price VALUES (2, 1, 'USD', 1200)`,
      `INSERT INTO "order" VALUES (4, 'ORD-4', 'Cancelled', 'USD', '2024-03-04 00:00:00', 1000, 1000, 0, 0, NULL, NULL, NULL, 1, '2024-03-04 00:00:00', '2024-03-04 00:00:00', false)`,
      `INSERT INTO order_channels_channel VALUES (4, 1)`,
      `INSERT INTO order_line VALUES (4, 1, 4, 1, 1, 1000, false, '[]', '[]', NULL, 1)`,
      `INSERT INTO payment VALUES
         (4, '2024-03-04 00:00:00', 4, 'sezzle', 'Authorized', 1000, 'sz-auth-4', '{}', NULL),
         (5, '2024-03-04 00:00:00', NULL, 'sezzle', 'Authorized', 1000, 'sz-orphan-5', '{}', NULL)`,
    ]) await sourcePool.query(statement);
    const storeId = randomUUID();
    const f = await fixtureConfig(storeId, {
      nmi: { accountId: 'nmi-acct', mode: 'live' },
      sezzle: { accountId: 'sez-acct', mode: 'live' },
      stripe: { accountId: 'acct_dd', mode: 'live' },
    });
    const dry = await runMigration({ sourceUrl: SOURCE_URL, targetUrl: TARGET_URL, config: f.config, manifestPath: f.manifestPath });
    expect(dry.exclusions.filter(e => e.table === 'payment' && /stale authorization|has no order/.test(e.detail))).toHaveLength(1);
    expect(dry.counts.financial_payment_archive).toBe(1);
    const applied = await runMigration({
      sourceUrl: SOURCE_URL, targetUrl: TARGET_URL, config: f.config,
      manifestPath: f.applyManifestPath, apply: true, expectedDigest: dry.sourceDigest,
    });
    expect(applied.counts.payment).toBe(4); // the orphan authorization has no order to attach to
    expect((await targetOne(storeId, 'financial_payment_archive')).state).toBe('Authorized');
    const stale = await targetOne(storeId, 'payment', `AND id = '${migrationId(storeId, 'vendure:test', 'payment', 4)}'`);
    expect(stale.state).toBe('Authorized');
    const unstocked = await targetOne(storeId, 'stock', `AND variant_id = '${migrationId(storeId, 'vendure:test', 'variant', 2)}'`);
    expect([unstocked.on_hand, unstocked.allocated]).toEqual([0, 0]);
    const events = await targetRows(storeId, 'restock_event');
    expect(events.length).toBeGreaterThan(0);
    expect(events.every(e => e.processed_at !== null)).toBe(true);
  });

  it('still refuses an authorization whose order can settle after cutover', async () => {
    const tag = 'p' + randomUUID().slice(0, 8);
    await resetSource('dd', tag);
    await sourcePool.query(`INSERT INTO "order" VALUES (4, 'ORD-4', 'PaymentAuthorized', 'USD', '2024-03-04 00:00:00', 1000, 1000, 0, 0, NULL, NULL, NULL, 1, '2024-03-04 00:00:00', '2024-03-04 00:00:00', false)`);
    await sourcePool.query('INSERT INTO order_channels_channel VALUES (4, 1)');
    await sourcePool.query(`INSERT INTO payment VALUES (4, '2024-03-04 00:00:00', 4, 'sezzle', 'Authorized', 1000, 'sz-auth-4', '{}', NULL)`);
    const f = await fixtureConfig(randomUUID(), { sezzle: { accountId: 'sez-acct', mode: 'live' } });
    await expect(runMigration({ sourceUrl: SOURCE_URL, targetUrl: TARGET_URL, config: f.config, manifestPath: f.manifestPath }))
      .rejects.toThrow('Resolve source pending/authorized payments before cutover');
  });

  it.each([true, false])('preserves placed zero & null/absent fallback without changing line totals (source column present: %s)', async (hasPlacedQuantity) => {
    const tag = 'q' + randomUUID().slice(0, 8);
    await resetSource('dd', tag);
    const total = hasPlacedQuantity ? 5000 : 4800;
    await sourcePool.query(`INSERT INTO "order" VALUES (4, 'ORD-4', 'PaymentSettled', 'USD', '2024-03-04 00:00:00', $1, $1, 0, 0, NULL, NULL, NULL, 1, '2024-03-04 00:00:00', '2024-03-04 00:00:00', false)`, [total]);
    await sourcePool.query('INSERT INTO order_channels_channel VALUES (4, 1)');
    // Current quantity remains positive for zero, unknown & cancellation-era placed quantities.
    await sourcePool.query(`INSERT INTO order_line VALUES
      (4, 1, 4, 2, 0, 1000, false, '[{"amount":-400,"type":"PROMOTION"}]', '[]', NULL, 1),
      (5, 1, 4, 2, NULL, 1000, false, '[{"amount":-400,"type":"PROMOTION"}]', '[]', NULL, 1),
      (6, 1, 4, 2, 4, 1000, false, '[{"amount":-400,"type":"PROMOTION"}]', '[]', NULL, 1)`);
    if (!hasPlacedQuantity) await sourcePool.query('ALTER TABLE order_line DROP COLUMN "orderPlacedQuantity"');
    await sourcePool.query(`INSERT INTO payment VALUES (4, '2024-03-04 00:00:00', 4, 'nmi-payment', 'Settled', $1, 'nmi-txn-400', '{}', NULL)`, [total]);
    const storeId = randomUUID();
    const f = await fixtureConfig(storeId, {
      nmi: { accountId: 'nmi-acct', mode: 'live' },
      sezzle: { accountId: 'sez-acct', mode: 'live' },
      stripe: { accountId: 'acct_dd', mode: 'live' },
    });
    const dry = await runMigration({ sourceUrl: SOURCE_URL, targetUrl: TARGET_URL, config: f.config, manifestPath: f.manifestPath });
    const repeatedDry = await runMigration({ sourceUrl: SOURCE_URL, targetUrl: TARGET_URL, config: f.config,
      manifestPath: f.manifestPath + '.repeat' });
    expect(repeatedDry.sourceDigest).toBe(dry.sourceDigest);
    await runMigration({ sourceUrl: SOURCE_URL, targetUrl: TARGET_URL, config: f.config,
      manifestPath: f.applyManifestPath, apply: true, expectedDigest: dry.sourceDigest });
    const orderId = migrationId(storeId, 'vendure:test', 'order', 4);
    const order = await targetOne(storeId, 'order', `AND id = '${orderId}'`);
    const byId = new Map((await targetRows(storeId, 'order_line', `AND order_id = '${orderId}'`)).map(line => [line.id, line]));
    const lines = [4, 5, 6].map(id => byId.get(migrationId(storeId, 'vendure:test', 'order-line', id))!);
    expect(lines.map(line => line.metadata.vendure.placedQuantity)).toEqual(hasPlacedQuantity ? [0, 2, 4] : [2, 2, 2]);
    expect(lines.map(line => line.metadata.vendure.quantity)).toEqual([2, 2, 2]);
    // Projection still divides adjustments by max(current, placed), not refund eligibility.
    expect(lines.map(line => line.line_total)).toEqual(hasPlacedQuantity ? [1600, 1600, 1800] : [1600, 1600, 1600]);
    expect(order).toMatchObject({ subtotal: 6000, discount_total: 6000 - total, tax_total: 0, grand_total: total });
    const refundLines = lines.map(line => ({ id: line.id, quantity: line.quantity, unitPrice: line.unit_price,
      lineTotal: line.line_total, metadata: line.metadata }));
    const units = refundUnitBases({ currency: 'USD', pricingSnapshot: null }, refundLines);
    expect(refundLines.map(line => units.get(line.id))).toEqual(hasPlacedQuantity ? [0, 800, 900] : [800, 800, 800]);
    expect(refundLines.map(line => refundLineCashAmount(line, 2, units.get(line.id)!, false)))
      .toEqual(hasPlacedQuantity ? [0, 1600, 1800] : [1600, 1600, 1600]);
  });

  it('records a synthetic fulfillment for a Delivered source order that has no fulfillment documents', async () => {
    const tag = 'f' + randomUUID().slice(0, 8);
    await resetSource('dd', tag);
    await sourcePool.query(`INSERT INTO "order" VALUES (5, 'ORD-5', 'Delivered', 'USD', '2024-03-05 00:00:00', 2000, 2000, 0, 0, NULL, NULL, NULL, 1, '2024-03-05 00:00:00', '2024-03-06 00:00:00', false)`);
    await sourcePool.query('INSERT INTO order_channels_channel VALUES (5, 1)');
    await sourcePool.query(`INSERT INTO order_line VALUES (5, 1, 5, 2, 2, 1000, false, '[]', '[]', NULL, 1)`);
    await sourcePool.query(`INSERT INTO payment VALUES (5, '2024-03-05 00:00:00', 5, 'nmi-payment', 'Settled', 2000, 'nmi-txn-500', '{}', NULL)`);
    const storeId = randomUUID();
    const f = await fixtureConfig(storeId, {
      nmi: { accountId: 'nmi-acct', mode: 'live' },
      sezzle: { accountId: 'sez-acct', mode: 'live' },
      stripe: { accountId: 'acct_dd', mode: 'live' },
    });
    const dry = await runMigration({ sourceUrl: SOURCE_URL, targetUrl: TARGET_URL, config: f.config, manifestPath: f.manifestPath });
    expect(dry.exclusions.some(e => e.table === 'fulfillment' && /synthetic fulfillment/.test(e.detail))).toBe(true);
    await runMigration({ sourceUrl: SOURCE_URL, targetUrl: TARGET_URL, config: f.config,
      manifestPath: f.applyManifestPath, apply: true, expectedDigest: dry.sourceDigest });
    const orderId = migrationId(storeId, 'vendure:test', 'order', 5);
    const fulfillments = await targetRows(storeId, 'fulfillment', `AND order_id = '${orderId}'`);
    expect(fulfillments).toHaveLength(1);
    expect(fulfillments[0]!.state).toBe('Delivered');
    expect(fulfillments[0]!.tracking_code).toBeNull();
    expect(fulfillments[0]!.metadata).toMatchObject({ synthetic: true, sourceOrderState: 'Delivered' });
    const line = await targetOne(storeId, 'order_line', `AND order_id = '${orderId}'`);
    expect(line.fulfilled_qty).toBe(2);
    // PaymentSettled source orders (not shipped) get nothing synthesized.
    const settled = await targetRows(storeId, 'fulfillment', `AND order_id = '${migrationId(storeId, 'vendure:test', 'order', 1)}'`);
    expect(settled).toHaveLength(0);
  });

  it('keeps source product and blog timestamps (sitemap lastmod) when the source has them', async () => {
    const tag = 't' + randomUUID().slice(0, 8);
    await resetSource('dd', tag);
    for (const statement of [
      `ALTER TABLE product ADD COLUMN "createdAt" timestamp, ADD COLUMN "updatedAt" timestamp`,
      `UPDATE product SET "createdAt" = '2023-01-02 03:04:05', "updatedAt" = '2024-05-06 07:08:09'`,
      `ALTER TABLE blog_post ADD COLUMN "createdAt" timestamp, ADD COLUMN "updatedAt" timestamp`,
      `UPDATE blog_post SET "createdAt" = '2023-02-03 00:00:00', "updatedAt" = '2024-06-07 00:00:00' WHERE id = 1`,
    ]) await sourcePool.query(statement);
    const storeId = randomUUID();
    const f = await fixtureConfig(storeId, {
      nmi: { accountId: 'nmi-acct', mode: 'live' },
      sezzle: { accountId: 'sez-acct', mode: 'live' },
      stripe: { accountId: 'acct_dd', mode: 'live' },
    });
    const dry = await runMigration({ sourceUrl: SOURCE_URL, targetUrl: TARGET_URL, config: f.config, manifestPath: f.manifestPath });
    await runMigration({ sourceUrl: SOURCE_URL, targetUrl: TARGET_URL, config: f.config,
      manifestPath: f.applyManifestPath, apply: true, expectedDigest: dry.sourceDigest });
    const product = await targetOne(storeId, 'product');
    expect(new Date(product.created_at).toISOString()).toBe(new Date('2023-01-02T03:04:05').toISOString());
    expect(new Date(product.updated_at).toISOString()).toBe(new Date('2024-05-06T07:08:09').toISOString());
    const post = await targetOne(storeId, 'blog_post', `AND slug = 'hello-world'`);
    expect(new Date(post.updated_at).toISOString()).toBe(new Date('2024-06-07T00:00:00').toISOString());
    const draft = await targetOne(storeId, 'blog_post', `AND slug = 'draft-post'`);
    expect(draft.updated_at).toBeTruthy(); // NULL source timestamp → import time
  });

  it('carries source id order into option group/value position (id ascending, not source insertion order)', async () => {
    const tag = 'd' + randomUUID().slice(0, 8);
    await resetSource('dd', tag);
    const client = await sourcePool.connect();
    try {
      // Group 20 ("Zebra") inserted before group 10 ("Apple") — id ascending
      // must still put Apple (10) first.
      await client.query(`INSERT INTO product_option_group VALUES (20, NULL), (10, NULL)`);
      await client.query(`INSERT INTO product_option_groups_product_option_group VALUES (20, 1), (10, 1)`);
      await client.query(`INSERT INTO product_option_group_translation VALUES (20, 'en', 'Zebra'), (10, 'en', 'Apple')`);
      // Within group 10: option 200 ("Value B") inserted before option 100
      // ("Value A") — id ascending must still put Value A first.
      await client.query(`INSERT INTO product_option VALUES (200, 10, NULL), (100, 10, NULL), (300, 20, NULL)`);
      await client.query(`INSERT INTO product_option_translation VALUES (200, 'en', 'Value B'), (100, 'en', 'Value A'), (300, 'en', 'Only')`);
      await client.query(`INSERT INTO product_variant_options_product_option VALUES (1, 100), (1, 200), (1, 300)`);
    } finally {
      client.release();
    }
    const storeId = randomUUID();
    const f = await fixtureConfig(storeId, {
      nmi: { accountId: 'nmi-acct', mode: 'live' },
      sezzle: { accountId: 'sez-acct', mode: 'live' },
      stripe: { accountId: 'acct_dd', mode: 'live' },
    });
    const dry = await runMigration({ sourceUrl: SOURCE_URL, targetUrl: TARGET_URL, config: f.config, manifestPath: f.manifestPath });
    await runMigration({ sourceUrl: SOURCE_URL, targetUrl: TARGET_URL, config: f.config, manifestPath: f.applyManifestPath, apply: true, expectedDigest: dry.sourceDigest });

    const groups = (await targetRows(storeId, 'product_option_group', 'ORDER BY position')).map((g) => ({ name: g.name as string, position: g.position as number }));
    expect(groups).toEqual([{ name: 'Apple', position: 0 }, { name: 'Zebra', position: 1 }]);

    const appleGroupId = migrationId(storeId, 'vendure:test', 'option-group', '1:10');
    const client2 = await targetPool.connect();
    let optionRows: { value: string; position: number }[];
    try {
      await client2.query(`SELECT set_config('app.current_store', $1, false)`, [storeId]);
      optionRows = (await client2.query(`SELECT value, position FROM product_option WHERE group_id = $1 ORDER BY position`, [appleGroupId])).rows;
    } finally {
      client2.release();
    }
    expect(optionRows).toEqual([{ value: 'Value A', position: 0 }, { value: 'Value B', position: 1 }]);
  });

  // Patterns observed in the real damned_vendure clone: contradictory headers
  // stay authoritative for historical display even when settlement corroborates
  // reconstructed charges. Also covers Vendure's dummy `standard-payment` handler, 'imported' sentinel
  // transaction ids, 'Modifying' orders, 'Created' fulfillments, total-only
  // refunds, and fulfillment/refund refs beyond ordered quantity.
  it('preserves contradictory source headers & quarantines money while retaining exact documents', async () => {
    const tag = 'd' + randomUUID().slice(0, 8);
    await resetSource('dd', tag);
    const extra = [
      // ORD-DRIFT-LINES: header subtotal 5000, lines 4000+6000,
      // independent ShippingLine 800, settled reconstructed grand 10800.
      `INSERT INTO "order" VALUES (10, 'DRIFT-LINES', 'Delivered', 'USD', '2024-03-04', 5000, 5000, 800, 800, NULL, NULL, NULL, 1, '2024-03-04', '2024-03-04', false)`,
      `INSERT INTO order_channels_channel VALUES (10, 1)`,
      `INSERT INTO shipping_line VALUES (10,10,1,800,false,'[]','[]')`,
      `INSERT INTO order_line VALUES (10, 1, 10, 1, 1, 4000, false, '[]', '[]', 10, 1), (12, 1, 10, 1, 1, 6000, false, '[]', '[]', 10, 1)`,
      `INSERT INTO payment VALUES (10, '2024-03-04', 10, 'nmi-payment', 'Settled', 10800, 'txn-drift-1', '{}', NULL)`,
      // ORD-DRIFT-UNRES: header 5000, lines 9000, settled 3300 — nothing agrees.
      `INSERT INTO "order" VALUES (11, 'DRIFT-UNRES', 'Delivered', 'USD', '2024-03-05', 5000, 5000, 800, 800, NULL, NULL, NULL, 1, '2024-03-05', '2024-03-05', false)`,
      `INSERT INTO order_channels_channel VALUES (11, 1)`,
      `INSERT INTO shipping_line VALUES (11,11,1,800,false,'[]','[]')`,
      `INSERT INTO order_line VALUES (11, 1, 11, 1, 1, 9000, false, '[]', '[]', 11, 1)`,
      `INSERT INTO payment VALUES (11, '2024-03-05', 11, 'nmi-payment', 'Settled', 3300, 'txn-drift-2', '{}', NULL)`,
      // ORD-MOD: 'Modifying' admin-edit state + a dummy-handler manual capture.
      `INSERT INTO "order" VALUES (12, 'MOD-1', 'Modifying', 'USD', '2024-03-06', 2000, 2000, 0, 0, NULL, NULL, NULL, 1, '2024-03-06', '2024-03-06', false)`,
      `INSERT INTO order_channels_channel VALUES (12, 1)`,
      `INSERT INTO order_line VALUES (13, 1, 12, 1, 1, 2000, false, '[]', '[]', NULL, 1)`,
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
    const sourceHistory = (await sourcePool.query(`SELECT o.id::text AS id, to_jsonb(o)::text AS header,
      (SELECT jsonb_build_object('id',c.id,'defaultCurrencyCode',c."defaultCurrencyCode",
        'pricesIncludeTax',c."pricesIncludeTax",'defaultTaxZoneId',c."defaultTaxZoneId")::text FROM channel c WHERE id=1) AS channel,
      (SELECT to_jsonb(c)::text FROM order_channels_channel c WHERE "orderId"=o.id AND "channelId"=1) AS membership,
      (SELECT to_jsonb(m)::text FROM shipping_method m WHERE id=1) AS method,
      (SELECT jsonb_agg(jsonb_build_object('sourceId',l.id::text,'sourceRecord',to_jsonb(l)::text) ORDER BY l.id)
        FROM shipping_line l WHERE l."orderId"=o.id) AS shipping,
      (SELECT jsonb_agg(jsonb_build_object('sourceId',l.id::text,'sourceRecord',to_jsonb(l)::text) ORDER BY l.id)
        FROM order_line l WHERE l."orderId"=o.id) AS lines,
      (SELECT to_jsonb(p)::text FROM payment p WHERE p."orderId"=o.id) AS payment
      FROM "order" o WHERE o.id IN (10,11) ORDER BY o.id`)).rows;

    const storeId = randomUUID();
    const f = await fixtureConfig(storeId, {
      nmi: { accountId: 'nmi-acct', mode: 'live' },
      sezzle: { accountId: 'sez-acct', mode: 'live' },
      stripe: { accountId: 'acct_dd', mode: 'live' },
    });
    const dry = await runMigration({ sourceUrl: SOURCE_URL, targetUrl: TARGET_URL, config: f.config, manifestPath: f.manifestPath });
    await runMigration({ sourceUrl: SOURCE_URL, targetUrl: TARGET_URL, config: f.config,
      manifestPath: f.applyManifestPath, apply: true, expectedDigest: dry.sourceDigest });

    // Settlement corroborates charges diagnostically; displayed source totals remain unchanged.
    const drift = await targetOne(storeId, 'order', `AND code = 'DRIFT-LINES'`);
    expect(drift).toMatchObject({ grand_total: 5800, subtotal: 5000, discount_total: 0, shipping_total: 800, tax_total: 0 });
    expect(drift.metadata.vendure.chargeProjectionV1).toMatchObject({ status: 'settled-corroborated',
      expected: { subTotal: 10000, subTotalWithTax: 10000, shipping: 800, shippingWithTax: 800 },
      sourceHeader: { subTotal: '5000', subTotalWithTax: '5000', shipping: '800', shippingWithTax: '800' },
      settlementProof: { netSettled: '10800', payments: [{ sourceId: '10', sourceRecord: sourceHistory[0]!.payment }], refunds: [] } });
    // Unresolved charges receive identical historical-header protection.
    const unres = await targetOne(storeId, 'order', `AND code = 'DRIFT-UNRES'`);
    expect(unres).toMatchObject({ grand_total: 5800, subtotal: 5000, discount_total: 0, shipping_total: 800, tax_total: 0 });
    expect(unres.metadata.vendure.chargeProjectionV1).toMatchObject({ status: 'unresolved',
      expected: { subTotal: 9000, subTotalWithTax: 9000, shipping: 800, shippingWithTax: 800 },
      sourceHeader: { subTotal: '5000', subTotalWithTax: '5000', shipping: '800', shippingWithTax: '800' } });
    for (const [index, order] of [drift, unres].entries()) {
      const raw = sourceHistory[index]!;
      const retained = order.metadata.vendure.retainedHistoryV1;
      expect(retained).toEqual({ version: 1, format: 'retained-pg-jsonb-text-v1', sourceKey: 'vendure:test',
        sourceOrderId: raw.id, sourceOrderRecord: raw.header,
        header: { subTotal: '5000', subTotalWithTax: '5000', shipping: '800', shippingWithTax: '800' },
        channel: { sourceId: '1', projection: 'pricing-v1', sourceRecord: raw.channel, orderChannelRecord: raw.membership },
        shippingMethods: [{ sourceId: '1', sourceRecord: raw.method }], shippingLines: raw.shipping, surcharges: [],
        lines: raw.lines.map((line: { sourceId: string; sourceRecord: string }) => ({ ...line,
          orderLineId: migrationId(storeId, 'vendure:test', 'order-line', line.sourceId) })),
        reason: 'HEADER_CHARGE_CONTRADICTION', referencedDetachedShippingLines: [],
        sourceDigest: expect.stringMatching(/^[0-9a-f]{64}$/) });
      const { sourceDigest, ...payload } = retained;
      expect(sourceDigest).toBe(digest(payload));
      expect(order.metadata.vendure.financialReconciliationV1).toEqual({ version: 1, status: 'required',
        reasons: ['HEADER_CHARGE_CONTRADICTION'], sourceDigest });
      expect(order.metadata.vendure).not.toHaveProperty('editBasisV1');
      expect(await targetRows(storeId, 'order_adjustment', `AND order_id = '${order.id}'`)).toEqual([]);
    }
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
    expect(details).toContain('known_historical_financial_quarantine HEADER_CHARGE_CONTRADICTION');
    expect(details).toContain('source header retained; reconstructed charges & net settlement are diagnostic only');
    expect(details).toContain('DRIFT-UNRES');
    expect(details).toContain('reconciliation required');
    expect(details).toContain('total-only source record');
    expect(details).toContain('exceed settled payments');
    expect(details).toContain('fulfillment refs exceed ordered quantity');
    expect(details).toContain('sentinel transactionId');
  });

  it('retains exact monetary credits/history without loyalty duplication & keeps combined coupons (R24)', async () => {
    await resetSource('rh', 'r' + randomUUID().slice(0, 8));
    const client = await sourcePool.connect();
    try {
      await createCreditSource(client);
      await client.query(`INSERT INTO promotion VALUES
        (20, 'CREDIT-1', '[]', '[{"code":"account_credit_discount","args":[]}]', NULL, NULL, NULL, NULL, 0, true, NULL),
        (21, 'BUNDLE', '[]', '[{"code":"order_percentage_discount","args":[{"name":"discount","value":"15"}]},{"code":"free_shipping","args":[]}]', NULL, NULL, NULL, NULL, 0, true, NULL),
        (22, 'PLAIN5', '[]', '[{"code":"order_fixed_discount","args":[{"name":"discount","value":"500"}]}]', NULL, NULL, NULL, NULL, 0, true, NULL),
        (23, 'CREDIT-2', '[]', '[{"code":"account_credit_discount","args":[]}]', NULL, NULL, NULL, NULL, 0, true, NULL),
        (24, 'CREDIT-3', '[]', '[{"code":"account_credit_discount","args":[]}]', NULL, NULL, NULL, NULL, 0, true, NULL),
        (25, 'CREDIT-4', '[]', '[{"code":"account_credit_discount","args":[]}]', NULL, NULL, NULL, NULL, 0, true, '2024-01-01')`);
      await seedPromotionScope(client, [20, 21, 22, 23, 24, 25]);
      await client.query(`INSERT INTO account_credit (id,"promotionId","emailNormalized","issuanceKey","currencyCode","initialAmount",balance,disabled) VALUES
        (1,20,'buyer@example.com','issue-1','USD',5000,2550,false),
        (2,23,'stranger@example.com','issue-2','USD',1000,1000,false),
        (3,24,'buyer@example.com','issue-3','USD',900,900,true),
        (4,25,'buyer@example.com','issue-4','USD',700,0,false)`);
      await client.query(`INSERT INTO account_credit_transaction (id,"accountCreditId",kind,status,amount,delta,"balanceAfter","idempotencyKey","orderId","relatedTransactionId") VALUES
        (1,1,'ISSUE','POSTED',5000,5000,5000,'issue:1',NULL,NULL),
        (2,1,'ADJUST','POSTED',2450,-2450,2550,'adjust:1',NULL,1),
        (3,1,'RESERVE','PENDING',100,0,NULL,'hold:1',1,2),
        (4,2,'ISSUE','POSTED',1000,1000,1000,'issue:2',NULL,NULL),
        (5,3,'ISSUE','POSTED',900,900,900,'issue:3',NULL,NULL),
        (6,4,'ISSUE','POSTED',700,700,700,'issue:4',NULL,NULL),
        (7,4,'ADJUST','POSTED',700,-700,0,'adjust:4',NULL,6)`);
    } finally { client.release(); }
    const storeId = randomUUID();
    const f = await fixtureConfig(storeId, { stripe: { accountId: 'acct_rh', mode: 'live' } });
    const config = { ...f.config, loyalty: { enabled: true, earnRatePerDollar: 1, pointsPerDollarOff: 100, minRedeemPoints: 0,
      maxRedeemPercentOfSubtotal: null, expiryDays: null } };
    const dry = await runMigration({ sourceUrl: SOURCE_URL, targetUrl: TARGET_URL, config, manifestPath: f.manifestPath });
    const applied = await runMigration({ sourceUrl: SOURCE_URL, targetUrl: TARGET_URL, config,
      manifestPath: f.applyManifestPath, apply: true, expectedDigest: dry.sourceDigest });
    expect(applied.applied).toBe(true);
    const promos = await targetRows(storeId, 'promotion', 'ORDER BY code');
    expect(promos.map(p => p.code)).toEqual(['BUNDLE', 'CREDIT-1', 'CREDIT-2', 'CREDIT-3', 'CREDIT-4', 'PLAIN5']);
    expect(promos.find(p => p.code === 'BUNDLE')).toMatchObject({ type: 'percentage', value: 15, free_shipping: true });
    expect(promos.find(p => p.code === 'PLAIN5')).toMatchObject({ type: 'fixed', value: 500, free_shipping: false });
    expect(promos.find(p => p.code === 'CREDIT-4')).toMatchObject({ type: 'account_credit', value: 0, enabled: false });
    const accounts = await targetRows(storeId, 'account_credit', 'ORDER BY source_id');
    expect(accounts.map(row => row.balance)).toEqual([2550,1000,900,0]);
    expect(accounts[1]).toMatchObject({ email_normalized: 'stranger@example.com', disabled: false });
    expect(accounts[2]!.disabled).toBe(true);
    expect(accounts.every(row => typeof row.source_record === 'string' && typeof row.source_promotion_record === 'string')).toBe(true);
    const transactions = await targetRows(storeId, 'account_credit_transaction', 'ORDER BY source_id');
    expect(transactions).toHaveLength(7);
    expect(transactions[2]).toMatchObject({ status: 'PENDING', amount: 100, delta: 0, order_id: migrationId(storeId, 'vendure:test', 'order', 1),
      related_transaction_id: migrationId(storeId, 'vendure:test', 'account-credit-transaction', 2) });
    expect(await targetRows(storeId, 'loyalty_ledger')).toEqual([]);
    expect((await targetOne(storeId, 'store')).config.loyalty.pointsPerDollarOff).toBe(100);
    expect(dry.exclusions.some(row => /balances import as loyalty|matches no imported customer|disabled store credits|pending store-credit reservations reconciled/.test(row.detail))).toBe(false);
    const manifest = JSON.parse(await readFile(f.applyManifestPath, 'utf8'));
    expect((await restoreMigration({ targetUrl: TARGET_URL, manifest, apply: true })).restored).toBe(true);
    expect(await targetRows(storeId, 'account_credit')).toEqual([]);
    expect(await targetRows(storeId, 'account_credit_transaction')).toEqual([]);
    expect(await targetRows(storeId, 'loyalty_ledger')).toEqual([]);
  });

  it('preserves authoritative balance when pending holds exceed it & blocks parity instead of flooring money', async () => {
    await resetSource('rh', 'r' + randomUUID().slice(0, 8));
    const client = await sourcePool.connect();
    try {
      await createCreditSource(client);
      await client.query(`INSERT INTO promotion VALUES (20,'HOLD-CREDIT','[]','[{"code":"account_credit_discount","args":[]}]',NULL,NULL,NULL,NULL,0,true,NULL)`);
      await seedPromotionScope(client, [20]);
      await client.query(`INSERT INTO account_credit (id,"promotionId","emailNormalized","issuanceKey","currencyCode","initialAmount",balance,disabled)
        VALUES (1,20,'over@example.com','over-issuance','USD',300,300,false)`);
      await client.query(`INSERT INTO account_credit_transaction (id,"accountCreditId",kind,status,amount,delta,"balanceAfter","idempotencyKey") VALUES
        (1,1,'ISSUE','POSTED',300,300,300,'issue:over'),(2,1,'RESERVE','PENDING',500,0,NULL,'hold:over')`);
    } finally { client.release(); }
    const storeId = randomUUID();
    const f = await fixtureConfig(storeId, { stripe: { accountId: 'acct_rh', mode: 'live' } });
    const dry = await runMigration({ sourceUrl: SOURCE_URL, targetUrl: TARGET_URL, config: f.config, manifestPath: f.manifestPath });
    expect(dry.parityBlockers.some(row => /pending_holds_exceed_balance/.test(row.detail))).toBe(true);
    await runMigration({ sourceUrl: SOURCE_URL, targetUrl: TARGET_URL, config: f.config, manifestPath: f.applyManifestPath, apply: true, expectedDigest: dry.sourceDigest });
    expect((await targetOne(storeId, 'account_credit')).balance).toBe(300);
    expect((await targetRows(storeId, 'account_credit_transaction')).some(row => row.status === 'PENDING' && row.amount === 500)).toBe(true);
    expect(await targetRows(storeId, 'loyalty_ledger')).toEqual([]);
  });

  it('imports monetary balances without configuring loyalty & resolves full-source redemption allocations', async () => {
    await resetSource('rh', 'r' + randomUUID().slice(0, 8));
    const client = await sourcePool.connect();
    try {
      await createCreditSource(client);
      await client.query(`INSERT INTO promotion VALUES (20,'MONETARY-CREDIT','[]','[{"code":"account_credit_discount","args":[]}]',NULL,NULL,NULL,NULL,0,true,NULL)`);
      await seedPromotionScope(client, [20]);
      await client.query(`INSERT INTO account_credit (id,"promotionId","emailNormalized","issuanceKey","currencyCode","initialAmount",balance,disabled)
        VALUES (1,20,'buyer@example.com','monetary-issuance','USD',1300,1200,false)`);
      await client.query(`INSERT INTO account_credit_transaction (id,"accountCreditId",kind,status,amount,delta,"balanceAfter","idempotencyKey","orderId",allocation,"relatedTransactionId") VALUES
        (1,1,'ISSUE','POSTED',1300,1300,1300,'issue:monetary',NULL,NULL,NULL),
        (2,1,'REDEEM','POSTED',100,-100,1200,'redeem:monetary',1,'{"1":[100]}'::jsonb,1)`);
    } finally { client.release(); }
    const storeId = randomUUID();
    const f = await fixtureConfig(storeId, { stripe: { accountId: 'acct_rh', mode: 'live' } });
    const dry = await runMigration({ sourceUrl: SOURCE_URL, targetUrl: TARGET_URL, config: f.config, manifestPath: f.manifestPath });
    await runMigration({ sourceUrl: SOURCE_URL, targetUrl: TARGET_URL, config: f.config, manifestPath: f.applyManifestPath, apply: true, expectedDigest: dry.sourceDigest });
    expect((await targetOne(storeId, 'account_credit')).balance).toBe(1200);
    const redemption = (await targetRows(storeId, 'account_credit_transaction')).find(row => row.kind === 'REDEEM');
    expect(redemption).toMatchObject({ amount: 100, delta: -100, allocation: '{"1": [100]}', source_order_id: '1',
      operational_allocation: { [migrationId(storeId, 'vendure:test', 'order-line', 1)]: [100] } });
    expect(await targetRows(storeId, 'loyalty_ledger')).toEqual([]);
    expect(dry.exclusions.some(row => /NOT imported.*points/.test(row.detail))).toBe(false);
  });
});
