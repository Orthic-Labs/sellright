/**
 * Minimal, idempotent catalog fixture for the storefront's Playwright e2e
 * suite (packages/storefront/e2e/*.spec.ts) — run once after `bootstrap.ts`
 * has created the store. Never touches an existing product with the same
 * slug (re-running is a no-op), and only runs against a store whose slug is
 * given by E2E_STORE_SLUG (defaults to BOOTSTRAP_STORE_SLUG, matching the
 * same store bootstrap.ts creates in CI).
 *
 * Seeds exactly two physical variants, one in stock and one out of stock —
 * the pair the e2e suite's OOS-at-shop / OOS-at-PDP assertions need. No
 * payment gateway is configured here (that needs encrypted store_secret
 * rows via the real admin API, out of scope for a fixture script) — the
 * checkout e2e spec tolerates "no payment method configured" as a valid
 * reached state for the payment step assertion; it proves the order reaches
 * PendingPayment and the payment step renders/gates correctly, not a real
 * charge.
 */
import { eq, and } from 'drizzle-orm';
import { unsafeUnscopedDb as db, pool } from '../db/client.js';
import * as s from '../db/schema.js';

const slug = (process.env.E2E_STORE_SLUG ?? process.env.BOOTSTRAP_STORE_SLUG ?? '').trim().toLowerCase();
if (!slug) throw new Error('Set E2E_STORE_SLUG (or BOOTSTRAP_STORE_SLUG) to the store to seed');

const FIXTURES = [
	{ slug: 'e2e-in-stock-tee', name: 'E2E In-Stock Tee', sku: 'E2E-INSTOCK-1', price: 2500, onHand: 25 },
	{ slug: 'e2e-out-of-stock-tee', name: 'E2E Out-of-Stock Tee', sku: 'E2E-OOS-1', price: 2500, onHand: 0 },
];

async function main() {
	const [store] = await db.select().from(s.store).where(eq(s.store.slug, slug)).limit(1);
	if (!store) throw new Error(`No store with slug ${slug} — run bootstrap.ts first`);

	for (const fixture of FIXTURES) {
		const [existing] = await db
			.select({ id: s.product.id })
			.from(s.product)
			.where(and(eq(s.product.storeId, store.id), eq(s.product.slug, fixture.slug)))
			.limit(1);
		if (existing) {
			console.log(`[seed-e2e-catalog] ${fixture.slug} already exists — skipping`);
			continue;
		}
		const [product] = await db
			.insert(s.product)
			.values({ storeId: store.id, slug: fixture.slug, name: fixture.name, status: 'active' })
			.returning({ id: s.product.id });
		const [variant] = await db
			.insert(s.productVariant)
			.values({ storeId: store.id, productId: product!.id, sku: fixture.sku, name: fixture.name, price: fixture.price, fulfillmentType: 'physical' })
			.returning({ id: s.productVariant.id });
		await db.insert(s.stock).values({ storeId: store.id, variantId: variant!.id, onHand: fixture.onHand });
		console.log(`[seed-e2e-catalog] created ${fixture.slug} (onHand=${fixture.onHand})`);
	}
}

main()
	.catch((error) => {
		console.error('[seed-e2e-catalog] failed', error);
		process.exitCode = 1;
	})
	.finally(async () => {
		await pool.end().catch(() => undefined);
	});
