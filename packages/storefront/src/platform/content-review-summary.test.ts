// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ selected: true, read: vi.fn() }));
vi.mock('@qwik.dev/router', () => ({ routeLoader$: (callback: unknown) => callback }));
vi.mock('~/platform/brand-data', () => ({ DECLARED_CONTENT: [{ path: '/reviews/', pageKey: 'reviews' }, { path: '/company/reviews/', pageKey: 'company-reviews' }] }));
vi.mock('~/platform/content-view', () => ({ hasContentViewFor: () => state.selected }));
vi.mock('~/platform/review-summary.server', () => ({ readReviewSummary: state.read }));
import { useContentReviewSummary } from './content-review-summary';

const load = useContentReviewSummary as unknown as (event: { url: URL }) => Promise<unknown>;
beforeEach(() => {
	state.selected = true;
	state.read.mockReset();
});

describe('declared content review summary loader', () => {
	it('loads fresh server data for both declared route depths', async () => {
		for (const path of ['/reviews/', '/company/reviews/']) {
			const summary = { score: '4.7', count: '300', reviews: [{ text: path, name: 'Customer' }] };
			state.read.mockResolvedValueOnce(summary);
			expect(await load({ url: new URL(path, 'https://store.example') })).toEqual(summary);
		}
		expect(state.read).toHaveBeenCalledTimes(2);
		expect(state.read).toHaveBeenNthCalledWith(1);
	});

	it('skips built-ins, unknown paths, key files and near matches', async () => {
		for (const path of ['/about/', '/unknown/', '/reviews', '/Reviews/', '/reviews/child/', '/abc.txt', '/shop/']) {
			expect(await load({ url: new URL(path, 'https://store.example') })).toBeNull();
		}
		expect(state.read).not.toHaveBeenCalled();
	});

	it('skips declared paths when content view is absent or unselected', async () => {
		state.selected = false;
		expect(await load({ url: new URL('https://store.example/reviews/') })).toBeNull();
		expect(state.read).not.toHaveBeenCalled();
	});

	it('returns null unchanged for fallback and never forwards request-selected file data', async () => {
		state.read.mockResolvedValueOnce(null);
		expect(await load({ url: new URL('https://store.example/reviews/?file=/private&url=https://attacker.example') })).toBeNull();
		expect(state.read).toHaveBeenCalledExactlyOnceWith();
	});
});
