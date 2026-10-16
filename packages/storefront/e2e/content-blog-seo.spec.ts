import { test, expect, skipExternal } from './fixtures';
import { eventually, uniq } from './support/api';
import { STORE_URL } from './support/env.mjs';
import { mock } from './support/mock';

/**
 * Plan 1.3 P2 #20 — publishing content: a blog post published through the admin API reaches /blog, its own page and
 * sitemap-blog.xml (drafts and future-dated posts do not), and an IndexNow submission for it reaches the mock endpoint
 * (the API process reroutes api.indexnow.org to support/mock-gateways.mjs and refuses every other host, so no search
 * engine is ever contacted).
 */
skipExternal();
test.beforeEach(() => mock.reset());

const INDEXNOW_KEY = 'e2e0123456789abcdef0123456789abcdef';
const sitemap = async () => (await fetch(`${STORE_URL}/sitemap-blog.xml`)).text();

test.describe.serial('#20 blog publish -> /blog, sitemap, IndexNow', () => {
	let slug = ''; // minted by the first test of each run, so --repeat-each never collides with an earlier post
	let title = '';
	let id = '';

	test('a draft is invisible everywhere; publishing it shows it on /blog, its own page and the blog sitemap', async ({ apiProxyPage: page, api }) => {
		slug = uniq('e2e-post');
		title = `E2E journal entry ${slug}`;
		const created = await api.post<{ id: string; slug: string }>('/blog', {
			title, slug, excerpt: 'A short excerpt for the e2e post.', body: '<h2>First heading</h2><p>Body paragraph for the e2e post.</p><script>window.__xss = 1</script>',
			authorName: 'E2E Author', tags: ['e2e'], isPublished: false,
		});
		id = created.id;
		expect(created.slug).toBe(slug);

		// Draft: not listed, not served, not in the sitemap.
		await page.goto('/blog');
		await expect(page.getByText(title)).toHaveCount(0);
		expect((await page.request.get(`/blog/${slug}/`)).status()).toBe(404);
		expect(await sitemap()).not.toContain(`/blog/${slug}/`);

		// Publish.
		await api.patch(`/blog/${id}`, { isPublished: true });
		await page.goto('/blog');
		await expect(page.getByRole('link', { name: new RegExp(title) })).toBeVisible({ timeout: 15_000 });
		await page.getByRole('link', { name: new RegExp(title) }).click();
		await page.waitForURL(`**/blog/${slug}**`);
		await expect(page.getByRole('heading', { name: 'First heading' })).toBeVisible();
		await expect(page.getByText('Body paragraph for the e2e post.')).toBeVisible();
		expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined(); // the API sanitised the body

		const xml = await sitemap();
		expect(xml).toContain(`<loc>${STORE_URL}/blog/${slug}/</loc>`);
	});

	test('a future-dated post and an unpublished one drop out of the list and the sitemap again', async ({ apiProxyPage: page, api }) => {
		await api.patch(`/blog/${id}`, { publishDate: new Date(Date.now() + 7 * 86_400_000).toISOString() });
		await page.goto('/blog');
		await expect(page.getByText(title)).toHaveCount(0);
		expect(await sitemap()).not.toContain(`/blog/${slug}/`);

		await api.patch(`/blog/${id}`, { publishDate: new Date(Date.now() - 60_000).toISOString() });
		await expect.poll(async () => (await sitemap()).includes(`/blog/${slug}/`), { timeout: 15_000 }).toBe(true);

		await api.patch(`/blog/${id}`, { isPublished: false });
		await expect.poll(async () => (await sitemap()).includes(`/blog/${slug}/`), { timeout: 15_000 }).toBe(false);
		await api.patch(`/blog/${id}`, { isPublished: true }); // leave it published for the IndexNow test
	});

	test('IndexNow: refused until a key is configured; then the submission for the post lands at the mock (and only there)', async ({ api }) => {
		const url = `${STORE_URL}/blog/${slug}/`;
		await api.patch('/seo/config', { indexNowKey: null }); // a clean start, whatever an earlier run left behind
		const unconfigured = await api.raw('POST', '/seo/indexnow/submit', { urls: [url] });
		expect(unconfigured.status).toBe(409);
		expect(await mock.indexNow()).toHaveLength(0);

		await api.patch('/seo/config', { indexNowKey: INDEXNOW_KEY });
		// The storefront serves the verification file for that key (what a search engine would fetch).
		const keyFile = await eventually(async () => { const r = await fetch(`${STORE_URL}/${INDEXNOW_KEY}.txt`); return r.ok ? r.text() : null; }, 'IndexNow key file on the storefront');
		expect(keyFile.trim()).toBe(INDEXNOW_KEY);

		const res = await api.post('/seo/indexnow/submit', { urls: [url] });
		expect(res).toMatchObject({ ok: true, status: 200 });
		const seen = await mock.indexNow();
		expect(seen).toHaveLength(1);
		expect(seen[0]!.method).toBe('POST');
		expect(seen[0]!.body).toEqual({ host: new URL(STORE_URL).host, key: INDEXNOW_KEY, keyLocation: `${STORE_URL}/${INDEXNOW_KEY}.txt`, urlList: [url] });

		// "Refresh sitemaps + notify" submits every sitemap URL, the new post among them.
		await mock.reset();
		const refresh = await api.post<{ indexNow: { attempted: boolean; ok: boolean | null; submitted: number } }>('/seo/sitemaps/refresh', { indexNow: true });
		expect(refresh.indexNow).toMatchObject({ attempted: true, ok: true });
		const all = await mock.indexNow();
		expect(all).toHaveLength(1);
		expect(all[0]!.body!.urlList).toContain(url);
		expect(refresh.indexNow.submitted).toBe(all[0]!.body!.urlList.length);

		await api.patch('/seo/config', { indexNowKey: null }); // leave the store as found
	});
});
