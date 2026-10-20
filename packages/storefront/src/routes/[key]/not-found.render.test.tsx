import { describe, expect, it, vi } from 'vitest';

vi.mock('~/platform/controllers/content', () => ({ BrandContentMount: () => null }));
vi.mock('../[...catchall]/index', () => ({ head: {}, notFoundMarkup: () => null }));
vi.mock('~/routes/layout', () => ({ useStoreIdentityLoader: {} }));
vi.mock('~/platform/content-view', () => ({ hasContentViewFor: () => false }));
vi.mock('~/platform/head-resolve', () => ({ contentHead: () => ({}) }));
vi.mock('~/platform/content-review-summary', () => ({ useContentReviewSummary: () => ({ value: null }) }));
vi.mock('~/services/sellright-seo', () => ({ indexNowKeyFile: vi.fn(async () => null) }));

describe('[key] route miss', () => {
	it('sets 404 and sends no body so the branded page renders', async () => {
		const { onGet, onHead } = await import('./index');
		for (const handler of [onGet, onHead]) {
			const status = vi.fn();
			const send = vi.fn();
			await (handler as unknown as (ev: unknown) => Promise<void>)({
				params: { key: 'cart' },
				url: new URL('https://x.test/cart/'),
				headers: new Headers(),
				status,
				send,
			});
			expect(status).toHaveBeenCalledWith(404);
			expect(send).not.toHaveBeenCalled();
		}
	});
});
