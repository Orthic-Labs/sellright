/**
 * Source-schema preflight (SR-08). The migration reads a live Vendure database
 * whose column set varies per store: Vendure custom fields compile down to
 * `customFields<Field>` columns that exist only where the store config declares
 * them (DD declares the SheerID verification fields, RH does not — see the
 * store vendure-config.ts files). Selecting a column that does not exist used
 * to surface as a bare SQL error mid-import; this preflight turns that into a
 * classified, reviewable failure before any phase runs.
 *
 * Classification:
 *   - required: core Vendure columns the importer maps unconditionally. Missing
 *     means the source is not the schema this importer understands — fail.
 *   - optional: per-store columns. `customFields*` by convention, plus a short
 *     explicit list (order_line.orderPlacedQuantity is a later Vendure column
 *     older snapshots lack). Absent optional columns import as NULL.
 *   - optional tables: plugin-owned record sets (blog, affiliate, waitlist).
 *     Absent tables are recorded on the manifest exclusion list, never
 *     silently skipped; a PRESENT but incomplete table is a required-field
 *     failure because the plugin's shape is unknown to this importer.
 */
import type { QueryResultRow } from 'pg';

export type SourceColumns = ReadonlyMap<string, ReadonlySet<string>>;

/** Core columns the importer selects, per source table. Anything listed here is
 * required for a faithful import; customFields* columns are intentionally not
 * listed (they are per-store optional by definition). */
export const REQUIRED_SOURCE_COLUMNS: Record<string, readonly string[]> = {
  channel: ['id', 'defaultCurrencyCode', 'pricesIncludeTax', 'defaultTaxZoneId'],
  customer: ['id', 'emailAddress', 'firstName', 'lastName', 'phoneNumber', 'userId', 'deletedAt', 'createdAt', 'updatedAt'],
  user: ['id', 'verified'],
  authentication_method: ['userId', 'type', 'passwordHash'],
  address: ['id', 'customerId', 'fullName', 'streetLine1', 'streetLine2', 'city', 'province', 'postalCode', 'phoneNumber', 'defaultShippingAddress', 'defaultBillingAddress', 'countryId'],
  region: ['id', 'code'],
  order: ['id', 'code', 'state', 'currencyCode', 'orderPlacedAt', 'subTotal', 'subTotalWithTax', 'shipping', 'shippingWithTax', 'shippingAddress', 'billingAddress', 'couponCodes', 'customerId', 'createdAt', 'updatedAt'],
  // orderPlacedQuantity is optional: older Vendure snapshots lack it and the
  // importer falls back to quantity.
  order_line: ['id', 'productVariantId', 'orderId', 'quantity', 'listPrice', 'listPriceIncludesTax', 'adjustments', 'taxLines'],
  product: ['id', 'enabled', 'featuredAssetId', 'deletedAt'],
  product_translation: ['baseId', 'languageCode', 'name', 'slug', 'description'],
  product_variant: ['id', 'productId', 'sku', 'enabled', 'trackInventory', 'useGlobalOutOfStockThreshold', 'outOfStockThreshold', 'deletedAt', 'taxCategoryId'],
  product_variant_translation: ['baseId', 'languageCode', 'name'],
  product_variant_price: ['variantId', 'channelId', 'currencyCode', 'price'],
  product_option_group: ['id', 'deletedAt'],
  product_option_groups_product_option_group: ['productOptionGroupId', 'productId'],
  product_option_group_translation: ['baseId', 'languageCode', 'name'],
  product_option: ['id', 'groupId', 'deletedAt'],
  product_option_translation: ['baseId', 'languageCode', 'name'],
  product_variant_options_product_option: ['productVariantId', 'productOptionId'],
  product_variant_facet_values_facet_value: ['productVariantId', 'facetValueId'],
  product_facet_values_facet_value: ['productId', 'facetValueId'],
  global_settings: ['trackInventory', 'outOfStockThreshold'],
  stock_level: ['id', 'productVariantId', 'stockLocationId', 'stockOnHand', 'stockAllocated'],
  stock_location: ['id', 'name'],
  promotion: ['id', 'couponCode', 'conditions', 'actions', 'startsAt', 'endsAt', 'usageLimit', 'perCustomerUsageLimit', 'priorityScore', 'enabled', 'deletedAt'],
  collection: ['id', 'parentId', 'position', 'isPrivate', 'isRoot', 'featuredAssetId'],
  collection_translation: ['baseId', 'languageCode', 'name', 'slug', 'description'],
  collection_product_variants_product_variant: ['collectionId', 'productVariantId'],
  product_asset: ['productId', 'assetId', 'position'],
  product_variant_asset: ['productVariantId', 'assetId', 'position'],
  asset: ['id', 'type', 'source', 'preview', 'width', 'height'],
  payment: ['id', 'createdAt', 'orderId', 'method', 'state', 'amount', 'transactionId', 'metadata', 'errorMessage'],
  // SR-03: the source payment_method handler args carry the original gateway
  // mode (testMode), the provenance an imported payment's mode is checked
  // against. Never inferred from the target store's current config.
  payment_method: ['code', 'handler'],
  order_line_reference: ['id', 'discriminator', 'fulfillmentId', 'refundId', 'orderLineId', 'quantity'],
  fulfillment: ['id', 'state', 'trackingCode', 'method', 'handlerCode', 'createdAt', 'updatedAt'],
  refund: ['id', 'paymentId', 'total', 'items', 'shipping', 'adjustment', 'state', 'transactionId', 'reason', 'metadata', 'createdAt'],
  order_promotions_promotion: ['orderId', 'promotionId'],
  shipping_method: ['id', 'code', 'checker', 'calculator', 'deletedAt'],
  shipping_method_translation: ['baseId', 'languageCode', 'name'],
  tax_rate: ['id', 'enabled', 'zoneId', 'categoryId', 'value', 'customerGroupId'],
};

/** Plugin tables that exist only where the source store enabled the plugin.
 * Absent => exclusion-list entry. Present => every listed column is required. */
export const OPTIONAL_SOURCE_TABLES: Record<string, readonly string[]> = {
  blog_post: ['id', 'title', 'slug', 'excerpt', 'body', 'bodyHtml', 'authorName', 'readingTime', 'featuredAssetId', 'tags', 'isPublished', 'publishDate', 'seoTitle', 'seoDescription'],
  affiliate: ['id', 'promotionId', 'email', 'accessToken', 'onboardedAt'],
  affiliate_settle: ['id', 'promotionId', 'amountCents', 'periodStartAt', 'periodEndAt', 'settledAt', 'txRef', 'notes'],
  waitlist_signup: ['id', 'productId', 'productSlug', 'productName', 'variantId', 'email', 'status', 'notifiedAt', 'createdAt', 'updatedAt'],
};

/** Non-customFields source columns that are optional per source vintage. */
const EXTRA_OPTIONAL_COLUMNS: Record<string, readonly string[]> = {
  order_line: ['orderPlacedQuantity'],
};

/** Per-store convention: Vendure compiles declared custom fields into
 * customFields<Field> columns, so any such column is optional by definition. */
export function isOptionalSourceColumn(table: string, column: string): boolean {
  return column.toLowerCase().startsWith('customfields')
    || (EXTRA_OPTIONAL_COLUMNS[table]?.includes(column) ?? false);
}

/** customFields* columns the importer knows how to map, per source table, to
 * the SellRight field they land on. Any other customFields* column on an
 * imported table is recorded on the manifest exclusion list. */
export const KNOWN_CUSTOM_FIELDS: Record<string, Readonly<Record<string, string>>> = {
  customer: {
    customFieldsSheeridverifications: 'sheeridVerifications',
    customFieldsActiveverifications: 'activeVerifications',
    customFieldsVerificationmetadata: 'verificationMetadata',
    customFieldsListmonksubscribedat: 'listmonkSubscribedAt',
    customFieldsStripecustomerid: 'stripeCustomerId',
  },
  order: { customFieldsIspreorder: 'isPreOrder' },
  product_variant: {
    customFieldsSaleprice: 'salePrice',
    customFieldsPreorderprice: 'preOrderPrice',
    customFieldsIspreorder: 'isPreOrder',
    customFieldsShipdate: 'shipDate',
  },
};

/** Recorded through ctx.q so the schema read participates in the reviewed
 * source digest: a source schema change between dry-run and apply invalidates
 * the digest and stops apply. */
export async function introspectSource(
  q: (sql: string, values?: unknown[]) => Promise<QueryResultRow[]>,
): Promise<SourceColumns> {
  const rows = await q(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = current_schema() ORDER BY table_name, column_name`,
  );
  const map = new Map<string, Set<string>>();
  for (const row of rows) {
    const table = String(row.table_name);
    let set = map.get(table);
    if (!set) map.set(table, (set = new Set()));
    set.add(String(row.column_name));
  }
  return map;
}

/** Fail before any import phase runs when required source fields are missing.
 * Optional plugin tables that ARE present must still be complete — a partial
 * blog/affiliate/waitlist table is a plugin version this importer does not
 * understand, not a store that lacks the plugin. */
export function assertSourceSchema(cols: SourceColumns): void {
  const missing: string[] = [];
  for (const [table, columns] of Object.entries(REQUIRED_SOURCE_COLUMNS)) {
    const have = cols.get(table);
    if (!have) { missing.push(`table "${table}"`); continue; }
    for (const column of columns) {
      if (!have.has(column)) missing.push(`"${table}"."${column}"`);
    }
  }
  for (const [table, columns] of Object.entries(OPTIONAL_SOURCE_TABLES)) {
    const have = cols.get(table);
    if (!have) continue;
    for (const column of columns) {
      if (!have.has(column)) missing.push(`"${table}"."${column}" (extension table present but incomplete)`);
    }
  }
  if (missing.length) {
    throw new Error('Source schema preflight failed — missing required source fields: ' + missing.join(', '));
  }
}

/** customFields* columns on imported tables with no target mapping. These are
 * recorded on the manifest exclusion list so a retired field is a reviewed
 * decision, not a silent drop. */
export function unmappedCustomFields(cols: SourceColumns): Array<{ table: string; column: string }> {
  const out: Array<{ table: string; column: string }> = [];
  for (const table of [...Object.keys(REQUIRED_SOURCE_COLUMNS), ...Object.keys(OPTIONAL_SOURCE_TABLES)]) {
    const set = cols.get(table);
    if (!set) continue;
    for (const column of [...set].sort()) {
      if (!column.toLowerCase().startsWith('customfields')) continue;
      if (KNOWN_CUSTOM_FIELDS[table]?.[column]) continue;
      out.push({ table, column });
    }
  }
  return out;
}

/** Build a SELECT fragment for a per-store column: the quoted source column
 * when present, NULL otherwise, so every mapped row shape stays constant. */
export function optionalColumn(
  cols: SourceColumns, table: string, column: string, ref: string, alias: string,
): string {
  return (cols.get(table)?.has(column) ? `${ref}."${column}"` : 'NULL') + ` AS ${alias}`;
}
