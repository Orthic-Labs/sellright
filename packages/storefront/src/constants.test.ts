import { describe, expect, it } from 'vitest';
import { AUTH_TOKEN } from './constants';

describe('AUTH_TOKEN', () => {
	// The server-side guards (account layout, auth loader) can only see a signed-in shopper through the API's own
	// HttpOnly session cookie (CUST_COOKIE in packages/api/src/auth/cookies.ts). A different name here made every full
	// page load of /account/* redirect to /sign-in.
	it('is the API customer-session cookie name', () => {
		expect(AUTH_TOKEN).toBe('sr_cust');
	});
});
