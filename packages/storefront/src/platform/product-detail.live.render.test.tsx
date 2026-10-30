import { describe, expect, it } from 'vitest';
import { modelsFromLive } from './product-detail';

const set = [{ key: 'main', slug: 'main-tee' }, { key: 'other', slug: 'other-tee' }];
const noReviews = async () => null;

describe('modelsFromLive: a failing API is not a missing product (#408)', () => {
	it('rethrows when the page product read fails, so the loader answers 503 instead of 404', async () => {
		const detail = async () => { throw Object.assign(new Error('Request failed with status 429'), { status: 429 }); };
		await expect(modelsFromLive(set, detail as never, noReviews as never)).rejects.toThrow('429');
	});

	it('a real 404 (null) stays null, and a failing sibling read only drops that sibling', async () => {
		const detail = async (slug: string) => { if (slug === 'other-tee') throw new Error('upstream'); return null; };
		await expect(modelsFromLive(set, detail as never, noReviews as never)).resolves.toEqual([null, null]);
	});
});
