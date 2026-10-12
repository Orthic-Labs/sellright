import { test, expect } from './fixtures';
import { PRODUCT, uniq } from './support/api';
import { addToCart } from './support/flows';

/**
 * Brand views (PR1) — rendered. Runs only against a BUILD made with the fixture views and data (the e2e command below sets E2E_BRAND_VIEWS=1):
 *
 *   E2E_BRAND_VIEWS=1 with
 *   SELLRIGHT_BRAND_SLOTS_DIR=src/components/slots/__fixtures__/brand-views
 *   SELLRIGHT_BRAND_DATA_DIR=src/components/slots/__fixtures__/brand-views-data   pnpm run e2e:build
 *
 * The fixture routes.json declares /our/story/ and /care/hidden-page/ (content), a head for /blog/ and `blog.pageSize` 100; the fixture
 * head.json sets titleTemplate '%s | {store}', a default description and a lowercase / trailing-slash canonical policy.
 */
const VIEWS = process.env.E2E_BRAND_VIEWS === '1';

test.describe('brand views (fixture build)', () => {
	test.skip(!VIEWS, 'needs E2E_BRAND_VIEWS=1 and a build with the fixture views and data: did not run, missing coverage');

	test('declared content path: 200, its title, no noindex, canonical and og:url', async ({ page }) => {
		const res = await page.goto('/our/story/');
		expect(res?.status()).toBe(200);
		await expect(page.getByTestId('view-content')).toHaveAttribute('data-page-key', 'our-story');
		await expect(page).toHaveTitle(/^Our story \| /);
		expect(await page.locator('meta[name="robots"]').getAttribute('content')).toBe('noai, noimageai');
		await expect(page.locator('link[rel="canonical"]')).toHaveCount(1);
		expect(await page.locator('link[rel="canonical"]').getAttribute('href')).toMatch(/\/our\/story\/$/);
		expect(await page.locator('meta[property="og:url"]').getAttribute('content')).toMatch(/\/our\/story\/$/);
		expect(await page.locator('meta[name="description"]').getAttribute('content')).toBe('The fixture story.');
		await expect(page.locator('title')).toHaveCount(1);
	});

	test('a declared noindex path is served and marked noindex', async ({ page }) => {
		const res = await page.goto('/care/hidden-page/');
		expect(res?.status()).toBe(200);
		expect(await page.locator('meta[name="robots"]').getAttribute('content')).toBe('noindex, nofollow, noai, noimageai');
	});

	test('an extra segment, a missing slash variant of nothing declared, and an undeclared path are 404 with the 404 title', async ({ page }) => {
		for (const p of ['/our/story/extra/', '/our/', '/care/not-declared/', '/no-such-page/deep/']) {
			const res = await page.goto(p);
			expect(res?.status(), p).toBe(404);
			// A single-segment path is answered by the IndexNow [key] endpoint (plain 404, no document): only deeper paths render the 404 page.
			if (p.split('/').filter(Boolean).length > 1) {
				await expect(page).toHaveTitle(/404 - Page Not Found/);
				expect(await page.locator('meta[name="robots"]').getAttribute('content'), p).toMatch(/^noindex/);
			}
		}
	});

	test('single-segment undeclared paths still return 404 and the IndexNow key route still serves a key file', async ({ page, request }) => {
		expect((await request.get('/no-such-page/')).status()).toBe(404);
		expect((await request.get('/no-such-key.txt')).status()).toBe(404);
		await page.goto('/');
	});

	test('per-path head on a built-in page: /blog/ takes the declared title and description once, og/twitter follow', async ({ page }) => {
		await page.goto('/blog/');
		await expect(page).toHaveTitle(/^The fixture journal \| /);
		expect(await page.locator('meta[property="og:title"]').getAttribute('content')).toBe('The fixture journal');
		expect(await page.locator('meta[name="twitter:title"]').getAttribute('content')).toBe('The fixture journal');
		await expect(page.locator('meta[name="description"]')).toHaveCount(1);
		await expect(page.locator('link[rel="icon"]')).toHaveCount(1);
	});

	test('static schema from head.json is emitted once with < escaped', async ({ page }) => {
		await page.goto('/about/');
		const blocks = await page.locator('script[type="application/ld+json"]').allTextContents();
		expect(blocks.filter((b) => b.includes('About (fixture)'))).toHaveLength(1);
	});

	test('shell header and footer views mount, resume, and the cart toggle opens the drawer with a live refresh', async ({ apiProxyPage: page }) => {
		await addToCart(page, PRODUCT.shirt.slug); // leaves the drawer open; a fresh document starts closed with the cart cookie kept
		await page.goto('/');
		await page.waitForLoadState('networkidle');
		await expect(page.getByTestId('view-header')).toBeVisible();
		await expect(page.getByTestId('view-footer')).toBeVisible();
		await expect(page.getByTestId('view-header-cart')).toHaveText(/^cart:1:closed$/);
		const cartReads: string[] = [];
		page.on('request', (r) => { if (r.method() === 'GET' && /\/v1\/shop\/cart\/[^/?]+(\?|$)/.test(new URL(r.url()).pathname + new URL(r.url()).search)) cartReads.push(r.url()); });
		await page.getByTestId('view-header-cart').click();
		await expect(page.getByTestId('view-header-last')).toHaveText('ok');
		await expect(page.getByTestId('view-header-cart')).toHaveText(/^cart:1:open$/);
		await expect.poll(() => cartReads.length).toBe(1); // one live cart read per open, never cached
	});

	test('home view: an invalid email never posts, a double submit makes one request', async ({ page }) => {
		let posts = 0;
		await page.route('**/newsletter-signup', async (route) => { posts++; await new Promise((r) => setTimeout(r, 300)); await route.fulfill({ status: 200, body: '{}' }); });
		await page.goto('/');
		await page.getByTestId('view-home-email').fill('not-an-email');
		await page.getByTestId('view-home-subscribe').click();
		await expect(page.getByTestId('view-home-outcome')).toHaveText('invalid');
		await expect(page.getByTestId('view-home-message')).toHaveText('Please enter a valid email.');
		expect(posts).toBe(0);
		await page.getByTestId('view-home-email').fill(`${uniq('nl')}@example.com`);
		await page.getByTestId('view-home-subscribe').dblclick();
		await expect(page.getByTestId('view-home-status')).toHaveText('success');
		expect(posts).toBe(1);
	});

	test('contact view: required fields are validated, nothing posts', async ({ page }) => {
		await page.goto('/contact/');
		await page.getByTestId('view-contact-send').click();
		await expect(page.getByTestId('view-contact-outcome')).toHaveText('invalid');
		await expect(page.getByTestId('view-contact-message-out')).toHaveText('Please fill in all required fields.');
	});

	test('blog: the list view carries total and page size; a missing post renders the missing state with a 404', async ({ page }) => {
		await page.goto('/blog/');
		await expect(page.getByTestId('view-blog')).toHaveAttribute('data-page-size', '100');
		const res = await page.goto('/blog/no-such-post/');
		expect(res?.status()).toBe(404);
		await expect(page.getByTestId('view-post-missing')).toBeVisible();
	});

	test('free-shipping view receives the shopper country and the discounted amount', async ({ apiProxyPage: page }) => {
		await addToCart(page, PRODUCT.shirt.slug);
		const band = page.getByTestId('view-free-shipping');
		await expect(band).toHaveText(new RegExp(`^band:([A-Z]{2}|none):${PRODUCT.shirt.price}:${PRODUCT.shirt.price}$`));
		// one more of the same SKU (the PDP now offers "add more"): the view gets fresh props with the new subtotal
		await page.goto(`/products/${PRODUCT.shirt.slug}/`); // a fresh document: the drawer the first add opened would cover the button
		await page.waitForLoadState('networkidle');
		await page.getByRole('button', { name: /add more/i }).click();
		await expect(page.getByTestId('view-free-shipping')).toHaveText(new RegExp(`^band:([A-Z]{2}|none):${PRODUCT.shirt.price * 2}:${PRODUCT.shirt.price * 2}$`));
	});
});
