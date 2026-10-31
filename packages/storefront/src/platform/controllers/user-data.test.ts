// @vitest-environment jsdom
// #375: hashed user data on every page (OpenAI normalisation), stored as hashes only, consent- and brand-gated.
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const head = vi.hoisted(() => ({ analytics: { provider: 'gtm', containerId: 'GTM-TEST', consent: 'implied', adPlatforms: ['openai'] as string[] } }));
vi.mock('~/platform/brand-data', () => ({ BRAND_HEAD: head, BRAND_ROUTES: {} }));

const sha = (v: string) => createHash('sha256').update(v, 'utf8').digest('hex');
type Push = { event?: string; user_data?: Record<string, string> };
const pushes = () => ((window as unknown as { dataLayer?: Push[] }).dataLayer ?? []).filter((p) => p.event === 'user_data');

async function fresh(consent = true) {
	vi.resetModules();
	localStorage.clear();
	document.cookie.split(';').forEach((c) => { document.cookie = c.split('=')[0]!.trim() + '=; Max-Age=0; Path=/'; });
	(window as unknown as { dataLayer?: unknown[] }).dataLayer = [];
	const analytics = await import('~/sellright/analytics');
	analytics.setAnalyticsConsent(consent);
	return { ud: await import('./user-data'), analytics };
}

describe('user data (#375)', () => {
	beforeEach(() => { head.analytics.adPlatforms = ['openai']; });

	it('normalises like OpenAI documents and hashes like the API', async () => {
		const { ud } = await fresh();
		const keys = await ud.userDataKeys({ email: '  Ada@Example.COM ', phone: '+1 (415) 555-2671', fullName: "Mary-Jane O'Neil", country: 'us', city: ' Portland ', region: 'OR', postalCode: '97201', customerId: ' C-1 ' });
		expect(keys).toEqual({
			sha256_email_address: sha('ada@example.com'),
			sha256_phone_number: sha('+14155552671'),
			sha256_phone_number_digits: sha('14155552671'),
			sha256_first_name: sha('maryjane'),
			sha256_last_name: sha('oneil'),
			sha256_external_id: sha('C-1'),
			country: 'US', city: 'Portland', region: 'OR', postal_code: '97201',
		});
	});

	it('publishes on every call, stores only hashes and the plain geo fields, and skips identical pushes', async () => {
		const { ud } = await fresh();
		await ud.publishUserData({ email: 'buyer@example.com', phone: '(503) 227-1234', firstName: 'Ada', lastName: 'Lovelace', country: 'US' });
		await ud.publishUserData({ email: 'buyer@example.com', phone: '(503) 227-1234', firstName: 'Ada', lastName: 'Lovelace', country: 'US' });
		expect(pushes()).toHaveLength(1);
		const stored = localStorage.getItem(ud.USER_DATA_STORAGE_KEY)!;
		for (const raw of ['buyer@example.com', '503', 'Ada', 'Lovelace']) expect(stored).not.toContain(raw);
		const data = pushes()[0]!.user_data!;
		expect(data.sha256_email_address).toBe(sha('buyer@example.com'));
		expect(data.sha256_phone_number_digits).toBe(sha('15032271234'));
		// Guest: the external id is the hashed first-party visitor id, the same string the checkout sends.
		const vid = ud.readCookie(ud.VISITOR_COOKIE)!;
		expect(vid).toMatch(/^[A-Za-z0-9-]{8,64}$/);
		expect(data.sha256_external_id).toBe(sha(vid));
		expect(ud.orderTracking()).toEqual({ visitorId: vid });
	});

	it('a signed-in customer id replaces the visitor id; a later page without it keeps the customer id', async () => {
		const { ud } = await fresh();
		await ud.publishUserData({ email: 'buyer@example.com' });
		await ud.publishUserData({ customerId: 'cust-42' });
		expect(ud.storedUserData().sha256_external_id).toBe(sha('cust-42'));
		await ud.publishUserData({ city: 'Portland' });
		expect(ud.storedUserData().sha256_external_id).toBe(sha('cust-42'));
		expect(ud.storedUserData().sha256_email_address).toBe(sha('buyer@example.com')); // merged, not replaced
	});

	it('does nothing without consent, and revoking consent forgets the stored data', async () => {
		const { ud, analytics } = await fresh(false);
		expect(await ud.publishUserData({ email: 'buyer@example.com' })).toEqual({});
		expect(pushes()).toHaveLength(0);
		expect(ud.readCookie(ud.VISITOR_COOKIE)).toBeNull();
		expect(ud.orderTracking()).toBeNull();
		analytics.setAnalyticsConsent(true);
		await ud.publishUserData({ email: 'buyer@example.com' });
		expect(localStorage.getItem(ud.USER_DATA_STORAGE_KEY)).not.toBeNull();
		analytics.setAnalyticsConsent(false);
		expect(localStorage.getItem(ud.USER_DATA_STORAGE_KEY)).toBeNull();
	});

	it('is enabled only for a brand with the OpenAI pixel', async () => {
		const { ud } = await fresh();
		expect(ud.userDataEnabled()).toBe(true);
		head.analytics.adPlatforms = [];
		expect(ud.userDataEnabled()).toBe(false);
	});

	it('sends the pixel __obref with the order and reads the __oppref fallback', async () => {
		const { ud } = await fresh();
		document.cookie = '__obref=ob.abc123; Path=/';
		document.cookie = '__oppref=opp-9; Path=/';
		expect(ud.orderTracking()).toMatchObject({ obref: 'ob.abc123' });
		expect(ud.pixelOppref()).toBe('opp-9');
	});

	describe('GTM loader (#375)', () => {
		type DL = Record<string, unknown>[];
		const run = (attrs: Record<string, string>, opts: { cookie?: string; crypto?: unknown } = {}) => {
			const { GTM_LOADER_SOURCE } = head_;
			const jar = { value: opts.cookie ?? '' };
			const d = {
				currentScript: { getAttribute: (k: string) => attrs[k] ?? null, nonce: '' },
				getElementsByTagName: () => [{ parentNode: { insertBefore: () => undefined } }],
				createElement: () => ({ setAttribute: () => undefined }),
				get cookie() { return jar.value; },
				set cookie(v: string) { const [pair] = v.split(';'); jar.value = jar.value ? `${jar.value}; ${pair}` : pair!; },
			};
			const w = { localStorage, crypto: opts.crypto ?? globalThis.crypto, location: { protocol: 'https:' }, dataLayer: [] as DL };
			new Function('window', 'document', GTM_LOADER_SOURCE.replace('(window,document,', '(arguments[0],arguments[1],'))(w, d);
			return { w, jar };
		};
		let head_: typeof import('~/platform/head-analytics');
		beforeEach(async () => { localStorage.clear(); head_ = await import('~/platform/head-analytics'); });
		const settle = () => new Promise((r) => setTimeout(r, 20));

		it('#360: gtm.js is inserted on the first interaction or 4000 ms after load; the dataLayer is filled at once', () => {
			const { GTM_LOADER_SOURCE } = head_;
			const inserted: unknown[] = []; const handlers: Record<string, Array<() => void>> = {};
			const d = {
				readyState: 'loading', currentScript: { getAttribute: (k: string) => (k === 'data-gtm-id' ? 'GTM-TEST' : null), nonce: '' },
				getElementsByTagName: () => [{ parentNode: { insertBefore: (j: unknown) => { inserted.push(j); } } }],
				createElement: () => ({ setAttribute: () => undefined }), cookie: '',
			};
			const timers: Array<{ cb: () => void; ms: number }> = [];
			const w = { localStorage, crypto: globalThis.crypto, location: { protocol: 'https:' }, dataLayer: [] as DL,
				addEventListener: (e: string, cb: () => void) => { (handlers[e] ??= []).push(cb); },
				setTimeout: (cb: () => void, ms: number) => { timers.push({ cb, ms }); return 0; } };
			new Function('window', 'document', 'setTimeout', GTM_LOADER_SOURCE.replace('(window,document,', '(arguments[0],arguments[1],'))(w, d, w.setTimeout);
			expect(w.dataLayer[w.dataLayer.length - 1]).toMatchObject({ event: 'gtm.js' });
			expect(inserted).toHaveLength(0);
			handlers.load!.forEach((cb) => cb());
			expect(inserted).toHaveLength(0);
			const t = timers.find((x) => x.ms === 4000);
			expect(t).toBeDefined();
			t!.cb();
			expect(inserted).toHaveLength(1);
			handlers.pointerdown!.forEach((cb) => cb());
			expect(inserted).toHaveLength(1);
		});

		it('#360: the first interaction inserts gtm.js before the 4000 ms delay; the later timer adds nothing', () => {
			const { GTM_LOADER_SOURCE } = head_;
			const inserted: unknown[] = []; const handlers: Record<string, Array<() => void>> = {};
			const d = {
				readyState: 'complete', currentScript: { getAttribute: (k: string) => (k === 'data-gtm-id' ? 'GTM-TEST' : null), nonce: '' },
				getElementsByTagName: () => [{ parentNode: { insertBefore: (j: unknown) => { inserted.push(j); } } }],
				createElement: () => ({ setAttribute: () => undefined }), cookie: '',
			};
			const timers: Array<{ cb: () => void; ms: number }> = [];
			const w = { localStorage, crypto: globalThis.crypto, location: { protocol: 'https:' }, dataLayer: [] as DL,
				addEventListener: (e: string, cb: () => void) => { (handlers[e] ??= []).push(cb); } };
			new Function('window', 'document', 'setTimeout', GTM_LOADER_SOURCE.replace('(window,document,', '(arguments[0],arguments[1],'))(w, d, (cb: () => void, ms: number) => { timers.push({ cb, ms }); return 0; });
			expect(inserted).toHaveLength(0);
			for (const e of ['pointerdown', 'keydown', 'touchstart', 'scroll']) expect(handlers[e]).toHaveLength(1);
			handlers.scroll!.forEach((cb) => cb());
			expect(inserted).toHaveLength(1);
			timers.forEach((x) => x.cb());
			expect(inserted).toHaveLength(1);
		});

		it('pushes the stored user data before gtm.js', async () => {
			localStorage.setItem('sr-user-data', JSON.stringify({ sha256_email_address: sha('a@b.co') }));
			const { w } = run({ 'data-gtm-id': 'GTM-TEST' });
			expect(w.dataLayer[0]).toEqual({ user_data: { sha256_email_address: sha('a@b.co') } });
			expect(w.dataLayer[1]).toMatchObject({ event: 'gtm.js' });
		});

		it('first visit (data-ud): creates sr_vid, hashes it and adds the request country before gtm.js', async () => {
			const { w, jar } = run({ 'data-gtm-id': 'GTM-TEST', 'data-ud': '1', 'data-co': 'GB' });
			expect(w.dataLayer).toEqual([]); // GTM waits for the hash
			await settle();
			const vid = /sr_vid=([A-Za-z0-9-]+)/.exec(jar.value)![1]!;
			expect(w.dataLayer[0]).toEqual({ user_data: { country: 'GB', sha256_external_id: sha(vid) } });
			expect(w.dataLayer[1]).toMatchObject({ event: 'gtm.js' });
			expect(w.dataLayer).toHaveLength(2);
			expect(JSON.parse(localStorage.getItem('sr-user-data')!)).toEqual({ country: 'GB', sha256_external_id: sha(vid) });
		});

		it('an existing sr_vid is reused; stored external id starts GTM at once and wins over the request country', async () => {
			const first = run({ 'data-gtm-id': 'GTM-TEST', 'data-ud': '1' }, { cookie: 'sr_vid=vid-0001-abcd' });
			await settle();
			expect(first.w.dataLayer[0]).toEqual({ user_data: { sha256_external_id: sha('vid-0001-abcd') } });
			localStorage.setItem('sr-user-data', JSON.stringify({ sha256_external_id: sha('cust-1'), country: 'US' }));
			const second = run({ 'data-gtm-id': 'GTM-TEST', 'data-ud': '1', 'data-co': 'GB' }, { cookie: 'sr_vid=vid-0001-abcd' });
			expect(second.w.dataLayer[0]).toEqual({ user_data: { sha256_external_id: sha('cust-1'), country: 'US' } });
			expect(second.w.dataLayer[1]).toMatchObject({ event: 'gtm.js' });
		});

		it('never holds GTM longer than 200 ms', async () => {
			vi.useFakeTimers();
			try {
				const { w } = run({ 'data-gtm-id': 'GTM-TEST', 'data-ud': '1', 'data-co': 'US' }, { crypto: { randomUUID: () => 'vid-hang-0001', subtle: { digest: () => new Promise(() => undefined) } } });
				expect(w.dataLayer).toEqual([]);
				vi.advanceTimersByTime(200);
				expect(w.dataLayer).toEqual([{ user_data: { country: 'US' } }, expect.objectContaining({ event: 'gtm.js' })]);
			} finally { vi.useRealTimers(); }
		});

		it('without data-ud (no OpenAI pixel) it sets no cookie and starts GTM at once', () => {
			const { w, jar } = run({ 'data-gtm-id': 'GTM-TEST', 'data-co': 'US' });
			expect(jar.value).toBe('');
			expect(w.dataLayer).toEqual([expect.objectContaining({ event: 'gtm.js' })]);
		});

		it('reads the Cloudflare country safely', () => {
			expect(head_.ipCountry('gb')).toBe('GB');
			expect(head_.ipCountry('XX')).toBeUndefined();
			expect(head_.ipCountry('T1')).toBeUndefined();
			expect(head_.ipCountry('"><script>')).toBeUndefined();
			expect(head_.ipCountry(undefined)).toBeUndefined();
		});
	});
});
