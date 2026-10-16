import { test, expect, skipExternal } from './fixtures';
import { registerAndVerify, signInWithPassword } from './support/account';
import { readRows, uniq } from './support/api';
import { addToCart, fillShipping, goToCheckout, payAndConfirm, placeOrder } from './support/flows';
import { mock } from './support/mock';

/**
 * Rewards and reviews, as the shopper and the merchant each see them:
 *  - a signed-in customer pays an order -> /account/rewards shows the balance and the ledger entry for that order;
 *  - the same buyer reviews the product -> the review waits for moderation, is invisible on the PDP, then the admin
 *    approves it -> it shows on the PDP (verified buyer, rating summary, AggregateRating JSON-LD) and the review bonus
 *    points land on the same rewards page.
 * Review text below is a TEST FIXTURE living only in this suite's throwaway database; nothing here is real customer content.
 */
skipExternal();
test.beforeEach(() => mock.reset());

const PROGRAM = {
	enabled: true, earnRatePerDollar: 2, pointsPerDollarOff: 10, minRedeemPoints: 0, maxRedeemPercentOfSubtotal: null, expiryDays: null,
	reviewBonusPoints: 40, reviewBonusVerifiedOnly: true, signupBonusPoints: 0, signupBonusSince: null, firstOrderBonusPoints: 0, birthdayBonusPoints: 0, productMultipliers: [],
};

test.describe.serial('rewards + reviews', () => {
	let email = '';
	let earned = 0;
	let orderCode = '';
	// Reviews belong to a product and outlive a run, so each run reviews a product of its own (a $25 one, like the shirt).
	let slug = '';

	test.beforeAll(async ({ api }) => {
		await api.put('/loyalty/settings', PROGRAM);
		const tag = uniq('rv');
		slug = `e2e-reviewable-${tag}`;
		const { id } = await api.post<{ id: string }>('/products', { name: `E2E Reviewable ${tag}`, slug, status: 'active' });
		await api.post(`/products/${id}/variants`, { sku: `E2E-RV-${tag}`.toUpperCase(), name: `E2E Reviewable ${tag}`, price: 2500, onHand: 50 });
	});
	test.afterAll(async ({ api }) => { await api.put('/loyalty/settings', { ...PROGRAM, enabled: false }); });

	test('a paid order shows up on /account/rewards: points balance and its ledger entry', async ({ apiProxyPage: page, api }) => {
		email = `${uniq('rev')}@example.net`;
		await registerAndVerify(page, email, { first: 'Katherine', last: 'Johnson' });
		await signInWithPassword(page, email);

		await addToCart(page, slug);
		await goToCheckout(page);
		await fillShipping(page, email, { first: 'Katherine', last: 'Johnson' });
		const placed = await placeOrder(page);
		orderCode = placed.code;
		await payAndConfirm(page, placed.code);
		expect((await api.order(placed.code)).state).toBe('Paid');

		// The ledger row the API posted for that order (2 points per merchandise dollar of a $25 product).
		const rows = await readRows<{ points: number; kind: string }>(api, `SELECT l.points, l.kind FROM loyalty_ledger l JOIN "order" o ON o.id = l.order_id WHERE o.code = $1`, [placed.code]);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ kind: 'earn' });
		earned = rows[0]!.points;
		expect(earned).toBe(50);

		await page.goto('/account/rewards');
		await expect(page.getByTestId('rewards-available')).toHaveText(String(earned), { timeout: 15_000 });
		await expect(page.getByTestId('rewards-value')).toContainText('$5'); // 50 points at 10 points per $1
		await expect(page.getByTestId('rewards-activity')).toContainText(`order ${placed.code}`);
		await expect(page.getByTestId('rewards-activity')).toContainText(`+${earned}`);
	});

	test('review: signed-in buyer submits -> pending (not public) -> admin approves -> visible on the PDP with JSON-LD, bonus points posted', async ({ apiProxyPage: page, api }) => {
		await signInWithPassword(page, email);
		await page.goto(`/products/${slug}/`);
		const reviews = page.getByTestId('product-reviews');
		await expect(reviews).toBeVisible({ timeout: 15_000 });
		await expect(reviews).toContainText(/no reviews yet/i);

		await reviews.getByRole('button', { name: /write a review/i }).click();
		await reviews.getByRole('radio', { name: '5 stars' }).click();
		await reviews.getByLabel(/title \(optional\)/i).fill('E2E fixture title');
		await reviews.getByLabel(/your review/i).fill('E2E fixture review text: written by the test suite, not a customer.');
		await reviews.getByLabel(/display name/i).fill('E2E Reviewer');
		await reviews.getByRole('button', { name: /submit review/i }).click();
		await expect(page.getByTestId('review-ack')).toContainText(/approved/i, { timeout: 15_000 });
		await expect(page.getByTestId('review-ack')).toContainText('40 points');

		// Pending: in the merchant's queue, verified-buyer flagged, NOT on the page, no points yet.
		const queue = await api.get<{ items: Array<{ id: string; status: string; verifiedBuyer: boolean; rating: number; authorName: string; productSlug: string }> }>('/reviews?status=pending');
		const mine = queue.items.find((r) => r.authorName === 'E2E Reviewer' && r.productSlug === slug)!;
		expect(mine).toMatchObject({ status: 'pending', verifiedBuyer: true, rating: 5 });
		await page.reload();
		await expect(page.getByTestId('product-reviews')).toContainText(/no reviews yet/i, { timeout: 15_000 });
		await expect(page.getByTestId('review-item')).toHaveCount(0);
		expect(await jsonLdAggregate(page)).toBeNull(); // unreviewed: never an empty/zero rating
		expect(await readRows(api, `SELECT 1 FROM loyalty_ledger l JOIN customer c ON c.id = l.customer_id WHERE c.email = $1 AND l.kind = 'bonus'`, [email])).toHaveLength(0);

		// Approve: the response reports the bonus; the review is public and the aggregate is exposed to search engines.
		const approved = await api.post<{ ok: boolean; bonusPoints: number }>(`/reviews/${mine.id}/approve`);
		expect(approved).toEqual({ ok: true, bonusPoints: 40 });
		await page.reload();
		const item = page.getByTestId('review-item');
		await expect(item).toHaveCount(1, { timeout: 15_000 });
		await expect(item).toContainText('E2E fixture title');
		await expect(item).toContainText('E2E Reviewer');
		await expect(item).toContainText(/verified buyer/i);
		await expect(page.getByTestId('reviews-summary')).toContainText('5.0');
		await expect(page.getByTestId('reviews-summary')).toContainText('1 review');
		expect(await jsonLdAggregate(page)).toMatchObject({ '@type': 'AggregateRating', ratingValue: expect.anything(), reviewCount: expect.anything() });
		const agg = (await jsonLdAggregate(page))!;
		expect(Number(agg.ratingValue)).toBe(5);
		expect(Number(agg.reviewCount)).toBe(1);

		// Bonus points on the ledger and on the rewards page (earn + review bonus), approving twice never pays twice.
		await api.post(`/reviews/${mine.id}/approve`);
		await page.goto('/account/rewards');
		await expect(page.getByTestId('rewards-available')).toHaveText(String(earned + 40), { timeout: 15_000 });
		await expect(page.getByTestId('rewards-activity')).toContainText('+40');
		expect(orderCode).not.toBe('');
	});

	test('a second review of the same product by the same buyer is refused; a signed-out visitor is sent to sign in', async ({ apiProxyPage: page }) => {
		await page.goto(`/products/${slug}/`);
		await expect(page.getByTestId('product-reviews')).toContainText(/sign in/i, { timeout: 15_000 });
		await expect(page.getByRole('button', { name: /write a review/i })).toHaveCount(0);

		await signInWithPassword(page, email);
		await page.goto(`/products/${slug}/`);
		const reviews = page.getByTestId('product-reviews');
		await reviews.getByRole('button', { name: /write a review/i }).click();
		await reviews.getByRole('radio', { name: '4 stars' }).click();
		await reviews.getByLabel(/your review/i).fill('E2E fixture second review text, which must be refused.');
		await reviews.getByRole('button', { name: /submit review/i }).click();
		await expect(reviews.getByRole('alert')).toContainText(/already reviewed/i, { timeout: 15_000 });
	});
});

/** The AggregateRating node of the page's Product JSON-LD (null when there is none). */
async function jsonLdAggregate(page: import('@playwright/test').Page): Promise<Record<string, unknown> | null> {
	const blocks = await page.locator('script[type="application/ld+json"]').allTextContents();
	for (const raw of blocks) {
		try {
			const data = JSON.parse(raw);
			const nodes = Array.isArray(data) ? data : (data['@graph'] ?? [data]);
			for (const n of nodes) if (n?.aggregateRating) return n.aggregateRating as Record<string, unknown>;
		} catch { /* not JSON */ }
	}
	return null;
}
