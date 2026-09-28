import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** `~/sellright/client`'s `boundedFetch` calls `fetch(request)` with a single
 *  `Request` object (server-side) rather than `fetch(url, init)` — both valid
 *  real-`fetch` call shapes, but a mock needs to handle the one actually used. */
async function capturedUrl(mockedFetch: ReturnType<typeof vi.fn>): Promise<string> {
	const [input] = mockedFetch.mock.calls[0];
	return input instanceof Request ? input.url : String(input);
}

describe('checkCustomerEmail turnstile/honeypot passthrough', () => {
	beforeEach(() => {
		vi.resetModules();
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('forwards turnstileToken and honeypot as query params, not discarded', async () => {
		const mockedFetch = vi.fn(async () => new Response(JSON.stringify({ exists: true }), { status: 200 }));
		vi.stubGlobal('fetch', mockedFetch);

		const { checkCustomerEmail } = await import('./check-email');
		const exists = await checkCustomerEmail('shopper@example.com', 'tok_abc123', 'hp-value');

		expect(exists).toBe(true);
		const url = await capturedUrl(mockedFetch);
		expect(url).toContain('/v1/shop/auth/check-email');
		expect(url).toContain('email=shopper%40example.com');
		expect(url).toContain('turnstileToken=tok_abc123');
		expect(url).toContain('honeypot=hp-value');
	});

	it('omits turnstileToken/honeypot from the query when not provided', async () => {
		const mockedFetch = vi.fn(async () => new Response(JSON.stringify({ exists: false }), { status: 200 }));
		vi.stubGlobal('fetch', mockedFetch);

		const { checkCustomerEmail } = await import('./check-email');
		await checkCustomerEmail('nobody@example.com');

		const url = await capturedUrl(mockedFetch);
		expect(url).not.toContain('turnstileToken');
		expect(url).not.toContain('honeypot');
	});

	it('resolves false (not throw) on a transport failure', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => {
			throw new Error('network down');
		}));

		const { checkCustomerEmail } = await import('./check-email');
		await expect(checkCustomerEmail('x@example.com')).resolves.toBe(false);
	});

	it('resolves false on a 429 (rate limited) rather than throwing', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'rate limited' }), { status: 429 })));

		const { checkCustomerEmail } = await import('./check-email');
		await expect(checkCustomerEmail('x@example.com')).resolves.toBe(false);
	});
});
