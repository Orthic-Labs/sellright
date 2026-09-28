import { describe, expect, it } from 'vitest';
import { describeAccountError } from './account';

describe('describeAccountError', () => {
	it('prefers SellRightError.code over status when the API supplies one (login not_verified)', () => {
		const result = describeAccountError({ status: 403, code: 'not_verified', message: 'please verify your email before signing in' });
		expect(result).toEqual({ code: 'not_verified', message: 'Please verify your email before signing in.' });
	});

	it('maps 429 to rate_limited regardless of caller-supplied statusCodes', () => {
		const result = describeAccountError({ status: 429, message: 'HTTP 429' }, { 429: 'invalid_credentials' });
		expect(result.code).toBe('rate_limited');
	});

	it('maps a bare 403 (bot check) without a code to bot_check_failed', () => {
		const result = describeAccountError({ status: 403, message: 'HTTP 403' });
		expect(result.code).toBe('bot_check_failed');
	});

	it('applies the caller-supplied per-endpoint status mapping (401 -> invalid_credentials on login)', () => {
		const result = describeAccountError({ status: 401, message: 'HTTP 401' }, { 401: 'invalid_credentials' });
		expect(result).toEqual({ code: 'invalid_credentials', message: 'Invalid email or password.' });
	});

	it('applies a different mapping for the same 401 on a different endpoint (wrong_password on change-password)', () => {
		const result = describeAccountError({ status: 401, message: 'HTTP 401' }, { 401: 'wrong_password' });
		expect(result.code).toBe('wrong_password');
	});

	it('falls back to unauthenticated for an unmapped 401', () => {
		const result = describeAccountError({ status: 401, message: 'HTTP 401' });
		expect(result.code).toBe('unauthenticated');
	});

	it('falls back to not_found for an unmapped 404', () => {
		const result = describeAccountError({ status: 404, message: 'HTTP 404' });
		expect(result.code).toBe('not_found');
	});

	it('applies a 409 mapping (e.g. email_taken on register, invalid_token on reset-password)', () => {
		expect(describeAccountError({ status: 409, message: 'HTTP 409' }, { 409: 'email_taken' }).code).toBe('email_taken');
		expect(describeAccountError({ status: 409, message: 'HTTP 409' }, { 409: 'invalid_token' }).code).toBe('invalid_token');
	});

	it('falls back to unknown with the thrown message for an unrecognized error', () => {
		const result = describeAccountError(new Error('network down'));
		expect(result).toEqual({ code: 'unknown', message: 'network down' });
	});

	it('never produces a legacy discriminated-union field — only {code, message}', () => {
		const result = describeAccountError({ status: 500, message: 'boom' });
		expect(Object.keys(result).sort()).toEqual(['code', 'message']);
	});
});
