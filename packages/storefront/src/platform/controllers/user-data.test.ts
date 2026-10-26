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

	it('the GTM loader pushes the stored user data before gtm.js', async () => {
		const { GTM_LOADER_SOURCE } = await import('~/platform/head-analytics');
		localStorage.setItem('sr-user-data', JSON.stringify({ sha256_email_address: sha('a@b.co') }));
		const w = { localStorage, dataLayer: [] as Record<string, unknown>[] } as unknown as Window & { dataLayer: Record<string, unknown>[] };
		const script = { getAttribute: () => 'GTM-TEST', nonce: '' };
		const d = { currentScript: script, getElementsByTagName: () => [{ parentNode: { insertBefore: () => undefined } }], createElement: () => ({ setAttribute: () => undefined }) };
		new Function('window', 'document', GTM_LOADER_SOURCE.replace('(window,document,', '(arguments[0],arguments[1],'))(w, d);
		expect(w.dataLayer[0]).toEqual({ user_data: { sha256_email_address: sha('a@b.co') } });
		expect(w.dataLayer[1]).toMatchObject({ event: 'gtm.js' });
	});
});
