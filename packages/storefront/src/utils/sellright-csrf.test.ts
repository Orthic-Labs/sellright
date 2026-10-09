/**
 * Browser-side CSRF for the legacy `sr()` helper (still used by srContact):
 * a signed-in customer's mutation must double-submit `sr_cust_csrf`, the
 * isolated demo / admin use `sr_csrf`. isServer is mocked false so the
 * browser path runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@qwik.dev/core/build', () => ({ isServer: false, isBrowser: true, isDev: false }));

import { readCsrfCookie, srContact } from './sellright';

const clearCookies = () => {
	for (const c of document.cookie.split(';')) {
		const name = c.split('=')[0]?.trim();
		if (name) document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
	}
};

let headers: Record<string, string> = {};

beforeEach(() => {
	clearCookies();
	headers = {};
	vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
		headers = { ...(init?.headers as Record<string, string>) };
		return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
	}));
});

afterEach(() => {
	clearCookies();
	vi.unstubAllGlobals();
});

describe('sr() CSRF cookie', () => {
	it('returns undefined with no cookie', () => {
		expect(readCsrfCookie()).toBeUndefined();
	});

	it('reads sr_csrf when it is the only cookie (demo / admin)', () => {
		document.cookie = 'sr_csrf=demo-token; path=/';
		expect(readCsrfCookie()).toBe('demo-token');
	});

	it('prefers sr_cust_csrf for a signed-in customer', () => {
		document.cookie = 'sr_csrf=other; path=/';
		document.cookie = 'sr_cust_csrf=cust%2Ftoken; path=/';
		expect(readCsrfCookie()).toBe('cust/token');
	});

	it('does not match a cookie whose name merely ends in sr_csrf', () => {
		document.cookie = 'x_sr_csrf=nope; path=/';
		expect(readCsrfCookie()).toBeUndefined();
	});

	it('sends x-csrf-token from sr_cust_csrf on a mutating call', async () => {
		document.cookie = 'sr_cust_csrf=cust-token; path=/';
		await srContact({ name: 'A', email: 'a@example.test', subject: 's', message: 'm' });
		expect(headers['x-csrf-token']).toBe('cust-token');
	});

	it('omits x-csrf-token when no CSRF cookie exists (anonymous guest)', async () => {
		await srContact({ name: 'A', email: 'a@example.test', subject: 's', message: 'm' });
		expect(headers['x-csrf-token']).toBeUndefined();
	});
});
