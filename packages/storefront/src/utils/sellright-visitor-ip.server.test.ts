import { describe, expect, it } from 'vitest';
import { cleanIp, resolveVisitorIp, sellrightVisitorIp, VISITOR_IP_HEADER, withVisitorIp } from './sellright-visitor-ip.server';

const headers = (h: Record<string, string>) => ({ get: (k: string) => h[k.toLowerCase()] ?? null });

describe('visitor IP forwarded to the API', () => {
	it('uses the socket peer when no trusted proxy is declared and ignores a forged x-real-ip', () => {
		const req = { headers: headers({ [VISITOR_IP_HEADER]: '203.0.113.9' }), socketIp: '198.51.100.7' };
		expect(resolveVisitorIp(req, {})).toBe('198.51.100.7');
	});

	it('uses the proxy-set x-real-ip only when SELLRIGHT_TRUST_FORWARDED_HOST=1', () => {
		const req = { headers: headers({ [VISITOR_IP_HEADER]: '203.0.113.9' }), socketIp: '127.0.0.1' };
		expect(resolveVisitorIp(req, { SELLRIGHT_TRUST_FORWARDED_HOST: '1' })).toBe('203.0.113.9');
	});

	it('never reads x-forwarded-for, and falls back to the socket when the trusted header is junk', () => {
		const req = { headers: headers({ 'x-forwarded-for': '203.0.113.9', [VISITOR_IP_HEADER]: 'evil, 1.1.1.1' }), socketIp: '::ffff:10.0.0.2' };
		expect(resolveVisitorIp(req, { SELLRIGHT_TRUST_FORWARDED_HOST: '1' })).toBe('10.0.0.2');
	});

	it('accepts only bare IP literals', () => {
		expect(cleanIp('2001:db8::1')).toBe('2001:db8::1');
		expect(cleanIp('256.1.1.1')).toBeUndefined();
		expect(cleanIp('1.2.3.4:80')).toBeUndefined();
		expect(cleanIp('not-an-ip')).toBeUndefined();
		expect(cleanIp(undefined)).toBeUndefined();
	});

	it('makes the IP available to sr() for the duration of the wrapped call', async () => {
		const seen = await withVisitorIp({ request: { headers: headers({}) }, clientConn: { ip: '192.0.2.5' } }, async () => sellrightVisitorIp.getStore());
		expect(seen).toBe('192.0.2.5');
		expect(sellrightVisitorIp.getStore()).toBeUndefined();
	});
});
