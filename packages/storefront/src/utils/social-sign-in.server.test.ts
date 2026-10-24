// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearSocialSignInCache, idsFromShopConfig, MAX_ENTRIES, socialSignInIdsForHost, TTL_MS } from './social-sign-in.server';

describe('idsFromShopConfig', () => {
	it('reads the public ids and treats anything else as off', () => {
		expect(idsFromShopConfig({ auth: { googleClientId: ' g.apps ', appleServicesId: 'com.x.web' } })).toEqual({ google: 'g.apps', apple: 'com.x.web' });
		expect(idsFromShopConfig({ auth: { googleClientId: null, appleServicesId: null } })).toEqual({ google: '', apple: '' });
		expect(idsFromShopConfig(null)).toEqual({ google: '', apple: '' });
	});
});

describe('socialSignInIdsForHost', () => {
	beforeEach(() => clearSocialSignInCache());

	it('asks the API for this host (or the pinned store) and returns the store ids', async () => {
		const fetcher = vi.fn().mockResolvedValue({ auth: { googleClientId: 'g1', appleServicesId: 'a1' } });
		expect(await socialSignInIdsForHost('Shop.Example', { storePin: '', fetcher, now: 1 })).toEqual({ google: 'g1', apple: 'a1' });
		expect(fetcher).toHaveBeenCalledWith({ 'x-forwarded-host': 'shop.example' });
		const pinned = vi.fn().mockResolvedValue({ auth: { googleClientId: 'g2', appleServicesId: null } });
		expect(await socialSignInIdsForHost('any.host', { storePin: 'rottenhand', fetcher: pinned, now: 1 })).toEqual({ google: 'g2', apple: '' });
		expect(pinned).toHaveBeenCalledWith({ 'x-store-slug': 'rottenhand' });
	});

	it('keeps an answer for the TTL, then asks again', async () => {
		const fetcher = vi.fn().mockResolvedValueOnce({ auth: { googleClientId: 'old' } }).mockResolvedValueOnce({ auth: { googleClientId: 'new' } });
		expect((await socialSignInIdsForHost('h', { storePin: '', fetcher, now: 0 })).google).toBe('old');
		expect((await socialSignInIdsForHost('h', { storePin: '', fetcher, now: TTL_MS - 1 })).google).toBe('old');
		expect((await socialSignInIdsForHost('h', { storePin: '', fetcher, now: TTL_MS })).google).toBe('new');
		expect(fetcher).toHaveBeenCalledTimes(2);
	});

	it('fails closed when the API is unreachable', async () => {
		const fetcher = vi.fn().mockRejectedValue(new Error('down'));
		expect(await socialSignInIdsForHost('h', { storePin: '', fetcher, now: 0 })).toEqual({ google: '', apple: '' });
	});

	it('shares one config read between concurrent misses for the same host', async () => {
		let release!: (v: unknown) => void;
		const fetcher = vi.fn().mockReturnValue(new Promise((r) => { release = r; }));
		const all = Promise.all([1, 2, 3].map(() => socialSignInIdsForHost('h', { storePin: '', fetcher, now: 0 })));
		release({ auth: { googleClientId: 'g' } });
		expect((await all).map((ids) => ids.google)).toEqual(['g', 'g', 'g']);
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	it('keeps at most MAX_ENTRIES hosts, dropping the oldest', async () => {
		const fetcher = vi.fn().mockResolvedValue({ auth: { googleClientId: 'g' } });
		for (let i = 0; i <= MAX_ENTRIES; i++) await socialSignInIdsForHost(`h${i}`, { storePin: '', fetcher, now: 0 });
		expect(fetcher).toHaveBeenCalledTimes(MAX_ENTRIES + 1);
		await socialSignInIdsForHost(`h${MAX_ENTRIES}`, { storePin: '', fetcher, now: 0 }); // newest: still cached
		expect(fetcher).toHaveBeenCalledTimes(MAX_ENTRIES + 1);
		await socialSignInIdsForHost('h0', { storePin: '', fetcher, now: 0 }); // oldest: evicted, read again
		expect(fetcher).toHaveBeenCalledTimes(MAX_ENTRIES + 2);
	});
});
