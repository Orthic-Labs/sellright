import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appleClientId, appleIdentityCsp, appleSignInClientId, appleSignInClientIdForHost, appleSignInHosts, appleSignInRefusedForMissingPin } from '~/config/apple-signin';

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');
const ID = 'com.example.web';
const HOSTS = 'a.example, A2.example:8443';
const EMPTY = { script: [], connect: [], frame: [], style: [] };

describe('Apple sign-in switch', () => {
	it('is off with no client id: no CSP origins', () => {
		expect(appleClientId('')).toBe('');
		expect(appleClientId(undefined)).toBe('');
		expect(appleIdentityCsp('')).toEqual(EMPTY);
	});

	it('is on with a client id: exactly the origins Sign in with Apple needs', () => {
		expect(appleIdentityCsp(appleClientId(` ${ID} `))).toEqual({
			script: ['https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js'],
			connect: ['https://appleid.apple.com'],
			frame: ['https://appleid.apple.com'],
			style: [],
		});
	});
});

describe('Apple sign-in: pinned to one store', () => {
	it('is off without a store pin even when a client id is set', () => {
		for (const pin of ['', undefined, '  ']) expect(appleSignInClientId(ID, pin)).toBe('');
		expect(appleSignInRefusedForMissingPin(ID, '')).toBe(true);
		expect(appleIdentityCsp(appleSignInClientId(ID, ''))).toEqual(EMPTY);
	});

	it('is on with a client id and a pin, off with no client id', () => {
		expect(appleSignInClientId(` ${ID} `, 'store-a')).toBe(ID);
		expect(appleSignInRefusedForMissingPin(ID, 'store-a')).toBe(false);
		expect(appleSignInClientId('', 'store-a')).toBe('');
		expect(appleSignInRefusedForMissingPin('', '')).toBe(false);
	});
});

describe('Apple sign-in: resolved per validated request host', () => {
	it('only a listed host gets the client id (and so the CSP origins)', () => {
		expect(appleSignInClientIdForHost('a.example', ID, 'store-a', HOSTS)).toBe(ID);
		expect(appleSignInClientIdForHost('a2.example', ID, 'store-a', HOSTS)).toBe(ID);
		expect(appleSignInClientIdForHost('b.example', ID, 'store-a', HOSTS)).toBe('');
		expect(appleIdentityCsp(appleSignInClientIdForHost('b.example', ID, 'store-a', HOSTS))).toEqual(EMPTY);
	});

	it('fails closed: no host list, no pin, no client id or no host means no Apple sign-in', () => {
		expect(appleSignInClientIdForHost('a.example', ID, 'store-a', '')).toBe('');
		expect(appleSignInClientIdForHost('a.example', ID, 'store-a', undefined)).toBe('');
		expect(appleSignInClientIdForHost('a.example', ID, '', HOSTS)).toBe('');
		expect(appleSignInClientIdForHost('a.example', '', 'store-a', HOSTS)).toBe('');
		expect(appleSignInClientIdForHost('', ID, 'store-a', HOSTS)).toBe('');
		expect(appleSignInHosts(' , ')).toEqual([]);
	});

	it('a forged X-Forwarded-Host cannot turn Apple on', async () => {
		const { validatedRequestHost } = await import('~/utils/trusted-request.server');
		expect(appleSignInClientIdForHost(validatedRequestHost({ host: 'b.example', 'x-forwarded-host': 'a.example' }, {}), ID, 'store-a', HOSTS)).toBe('');
	});

	it('the entry builds the CSP from the same per-request expression the page uses', () => {
		const entry = read('src/entry.express.tsx');
		const page = read('src/routes/sign-in/index.tsx');
		expect(entry).toContain('const socialIds = await socialSignInIdsForHost(validatedRequestHost(req.headers))');
		expect(entry).toContain('apple: appleIdentityCsp(socialIds.apple)');
		expect(entry).not.toContain('appleid.apple.com');
		expect(page).toMatch(/useAppleClientId = routeLoader\$[\s\S]*?socialSignInIdsForHost\(/);
	});
});
