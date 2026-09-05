import { Pool } from 'pg';
import { env } from '../env.js';

/**
 * Read-only Vendure migration preflight. This is intentionally stricter than
 * the importers: it reports source features that SellRight does not yet migrate
 * or operate faithfully and exits non-zero on any hard blocker.
 *
 * Run before taking a source snapshot or invoking any truncating importer:
 *   SOURCE_DATABASE_URL=... pnpm import:preflight
 */

type Severity = 'blocker' | 'warning' | 'info';
type Finding = {
  code: string;
  severity: Severity;
  message: string;
  count?: number;
  details?: unknown;
};

const SOURCE_URL = env.SOURCE_DATABASE_URL;
if (!SOURCE_URL) throw new Error('SOURCE_DATABASE_URL is required');

const src = new Pool({
  connectionString: SOURCE_URL,
  application_name: 'sellright-vendure-preflight',
  max: 2,
  connectionTimeoutMillis: 5_000,
});

const q = async <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> =>
  (await src.query(sql, params)).rows as T[];

const KNOWN_ORDER_STATES = new Set([
  'AddingItems',
  'ArrangingPayment',
  'PaymentAuthorized',
  'PaymentSettled',
  'PartiallyShipped',
  'Shipped',
  'PartiallyDelivered',
  'Delivered',
  'PartiallyRefunded',
  'Refunded',
  'Cancelled',
]);

// Methods SellRight can currently reverse through the order-level refund path.
// Stripe is gateway-backed; gift_card is credited internally; manual/cod are
// ledger/offline methods. Historical NMI/Sezzle payments are intentionally NOT
// included until their original provider identifiers + credentials are proven.
const REFUND_OPERABLE_METHODS = new Set(['stripe', 'gift_card', 'manual', 'cod']);

async function tableExists(name: string): Promise<boolean> {
  const [row] = await q<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = current_schema() AND table_name = $1
     ) AS exists`,
    [name],
  );
  return row?.exists === true;
}

async function columnExists(table: string, column: string): Promise<boolean> {
  const [row] = await q<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2
     ) AS exists`,
    [table, column],
  );
  return row?.exists === true;
}

async function countTable(table: string): Promise<number> {
  // Callers pass only hard-coded table names after tableExists().
  const rows = await q<{ n: number }>(`SELECT count(*)::int AS n FROM "${table}"`);
  return Number(rows[0]?.n ?? 0);
}

async function main(): Promise<void> {
  const findings: Finding[] = [];
  const add = (finding: Finding) => findings.push(finding);

  // Source identity / basic reachability.
  const [db] = await q<{ db: string; version: string }>(`SELECT current_database() AS db, version() AS version`);
  add({ code: 'source.connected', severity: 'info', message: `Connected to Vendure source database ${db?.db ?? '(unknown)'}` });

  if (!(await tableExists('order')) || !(await tableExists('order_line')) || !(await tableExists('payment'))) {
    add({ code: 'source.schema', severity: 'blocker', message: 'Source does not look like a compatible Vendure database (order/order_line/payment tables required).' });
  } else {
    const states = await q<{ state: string; n: number }>(
      `SELECT state, count(*)::int AS n FROM "order" GROUP BY state ORDER BY state`,
    );
    const unknown = states.filter((row) => !KNOWN_ORDER_STATES.has(row.state));
    if (unknown.length) {
      add({
        code: 'orders.custom_states',
        severity: 'blocker',
        message: 'Vendure contains custom/unknown order states. SellRight intentionally maps unknown states to PendingPayment; define an explicit migration mapping before cutover.',
        count: unknown.reduce((sum, row) => sum + Number(row.n), 0),
        details: unknown,
      });
    }

    const settledMethods = await q<{ method: string; n: number }>(
      `SELECT method, count(*)::int AS n FROM payment WHERE state = 'Settled' GROUP BY method ORDER BY method`,
    );
    const unsupported = settledMethods.filter((row) => !REFUND_OPERABLE_METHODS.has(String(row.method).toLowerCase()));
    if (unsupported.length) {
      add({
        code: 'payments.refund_unsupported',
        severity: 'blocker',
        message: 'Historical settled payments use methods SellRight cannot safely reverse yet. Keep the legacy gateway/refund path available or implement and validate these provider adapters before migration.',
        count: unsupported.reduce((sum, row) => sum + Number(row.n), 0),
        details: unsupported,
      });
    }

    const multiSettled = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM (
         SELECT "orderId" FROM payment WHERE state = 'Settled'
         GROUP BY "orderId" HAVING count(*) > 1
       ) x`,
    );
    if (Number(multiSettled[0]?.n ?? 0) > 0) {
      add({
        code: 'payments.multi_settled_orders',
        severity: 'blocker',
        message: 'Orders with multiple settled payments require explicit tender allocation for refunds. SellRight currently rejects those refunds rather than guessing a tender.',
        count: Number(multiSettled[0]?.n ?? 0),
      });
    }

    for (const required of ['listPriceIncludesTax', 'adjustments', 'taxLines']) {
      if (!(await columnExists('order_line', required))) {
        add({
          code: `orders.missing_${required}`,
          severity: 'blocker',
          message: `order_line.${required} is required to reconstruct and reconcile historical Vendure line/refund economics.`,
        });
      }
    }
  }

  if (await tableExists('product_variant_price')) {
    const hasChannel = await columnExists('product_variant_price', 'channelId');
    const hasCurrency = await columnExists('product_variant_price', 'currencyCode');
    if (hasChannel && hasCurrency) {
      const ambiguous = await q<{ n: number }>(
        `SELECT count(*)::int AS n FROM (
           SELECT "variantId", "currencyCode"
           FROM product_variant_price
           GROUP BY "variantId", "currencyCode"
           HAVING count(DISTINCT "channelId") > 1
         ) x`,
      ).catch(async () => {
        // Some Vendure versions use productVariantId instead of variantId.
        if (!(await columnExists('product_variant_price', 'productVariantId'))) return [{ n: 0 }];
        return q<{ n: number }>(
          `SELECT count(*)::int AS n FROM (
             SELECT "productVariantId", "currencyCode"
             FROM product_variant_price
             GROUP BY "productVariantId", "currencyCode"
             HAVING count(DISTINCT "channelId") > 1
           ) x`,
        );
      });
      if (Number(ambiguous[0]?.n ?? 0) > 0) {
        add({
          code: 'catalog.multi_channel_prices',
          severity: 'blocker',
          message: 'Variants have multiple channel-specific prices in the same currency. The current catalog importer is not channel-scoped and must not choose a price implicitly.',
          count: Number(ambiguous[0]?.n ?? 0),
        });
      }
    }
  }

  // Known importer omissions. These are source-feature counts, not guesses: if
  // the source uses them, migration is incomplete until a dedicated slice exists.
  for (const [table, code, label] of [
    ['fulfillment', 'fulfillment.not_migrated', 'fulfillment records'],
    ['shipping_method', 'shipping.not_migrated', 'shipping methods'],
    ['tax_rate', 'tax.not_migrated', 'tax rates'],
  ] as const) {
    if (await tableExists(table)) {
      const n = await countTable(table);
      if (n > 0) add({ code, severity: 'blocker', message: `Source contains ${label}, but the current Vendure importer does not migrate them.`, count: n });
    }
  }

  if (await tableExists('asset')) {
    const n = await countTable('asset');
    if (n > 0) {
      add({
        code: 'assets.bytes_not_copied',
        severity: 'blocker',
        message: 'Source assets exist. The catalog importer currently imports asset references/paths but does not copy or verify the underlying bytes.',
        count: n,
      });
    }
  }

  if (await tableExists('promotion') && await columnExists('promotion', 'couponCode')) {
    const [row] = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM promotion WHERE "couponCode" IS NULL AND enabled = true`,
    );
    if (Number(row?.n ?? 0) > 0) {
      add({
        code: 'promotions.automatic_not_migrated',
        severity: 'blocker',
        message: 'Enabled automatic promotions exist. The current catalog importer only migrates coupon-code promotions.',
        count: Number(row?.n ?? 0),
      });
    }
  }

  // Vendure native-auth table names vary by version. Flag whichever standard
  // table is present; the current customer importer deliberately imports no
  // password hashes/authentication methods.
  for (const authTable of ['native_authentication_method', 'authentication_method'] as const) {
    if (await tableExists(authTable)) {
      const n = await countTable(authTable);
      if (n > 0) {
        add({
          code: 'customers.auth_not_migrated',
          severity: 'blocker',
          message: `Source contains ${n} rows in ${authTable}; current customer import does not migrate password/authentication credentials. Define password-hash compatibility or a forced reset/magic-link cutover.`,
          count: n,
        });
        break;
      }
    }
  }

  const blockerCount = findings.filter((f) => f.severity === 'blocker').length;
  const report = {
    ok: blockerCount === 0,
    blockerCount,
    generatedAt: new Date().toISOString(),
    findings,
  };
  // Machine-readable stdout: CI/cutover tooling can gate on both exit code and
  // this JSON without scraping human prose.
  console.log(JSON.stringify(report, null, 2));
  if (blockerCount > 0) process.exitCode = 2;
}

main()
  .catch((error) => {
    console.error('[import:preflight] failed', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await src.end().catch(() => undefined);
  });
