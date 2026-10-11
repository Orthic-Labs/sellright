import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCsp, IP_LOOKUP_ORIGIN, TURNSTILE_ORIGIN } from './csp';

const directive = (csp: string, name: string) => csp.split('; ').find((d) => d.startsWith(`${name} `)) ?? '';

describe('buildCsp — Turnstile origin only when a site key is configured', () => {
	it('allows the Turnstile origin in script-src and frame-src when a site key is set, keeping the nonce policy', () => {
		const csp = buildCsp({ nonce: 'abc', turnstileSiteKey: '0xKEY' });
		expect(directive(csp, 'script-src')).toContain(TURNSTILE_ORIGIN);
		expect(directive(csp, 'frame-src')).toContain(TURNSTILE_ORIGIN);
		expect(directive(csp, 'script-src')).toContain("'nonce-abc'");
		expect(directive(csp, 'script-src')).not.toContain("'unsafe-inline'");
		expect(directive(csp, 'script-src')).not.toContain('strict-dynamic');
		expect(directive(csp, 'default-src')).toBe("default-src 'self'");
		expect(directive(csp, 'connect-src')).not.toContain(TURNSTILE_ORIGIN);
	});

	it('does not mention the origin when the key is unset or blank', () => {
		for (const key of [undefined, null, '', '   ']) {
			expect(buildCsp({ nonce: 'abc', turnstileSiteKey: key })).not.toContain(TURNSTILE_ORIGIN);
		}
	});

	it('the existing providers stay allowed with and without the key', () => {
		for (const key of [undefined, 'k']) {
			const csp = buildCsp({ nonce: 'n', turnstileSiteKey: key });
			expect(directive(csp, 'script-src')).toContain('https://js.stripe.com');
			expect(directive(csp, 'frame-src')).toContain('https://hooks.stripe.com');
		}
	});
});

describe('buildCsp — ipapi.co in connect-src only where the browser fallback is on', () => {
	it('is allowed by default and when enabled explicitly', () => {
		expect(directive(buildCsp({ nonce: 'n' }), 'connect-src')).toContain(IP_LOOKUP_ORIGIN);
		expect(directive(buildCsp({ nonce: 'n', ipCountryFallback: '1' }), 'connect-src')).toContain(IP_LOOKUP_ORIGIN);
	});

	it('is absent from every directive when the fallback is switched off', () => {
		for (const v of ['0', 'false', 'off']) expect(buildCsp({ nonce: 'n', ipCountryFallback: v })).not.toContain(IP_LOOKUP_ORIGIN);
	});

	it('only connect-src carries it, and the API origin is still appended', () => {
		const csp = buildCsp({ nonce: 'n', apiOrigin: 'https://api.example.test' });
		expect(directive(csp, 'connect-src')).toContain('https://api.example.test');
		expect(directive(csp, 'script-src')).not.toContain(IP_LOOKUP_ORIGIN);
		expect(directive(csp, 'frame-src')).not.toContain(IP_LOOKUP_ORIGIN);
	});
});

describe('buildCsp — Google Identity sources join only when supplied, alongside Turnstile and ipapi', () => {
	it('adds the supplied sources per directive and keeps the other origins', () => {
		const csp = buildCsp({
			nonce: 'n',
			turnstileSiteKey: 'k',
			google: { script: ['https://g.test/client'], connect: ['https://g.test/gsi/'], frame: ['https://g.test/gsi/'], style: ['https://g.test/gsi/style'] },
		});
		expect(directive(csp, 'script-src')).toContain('https://g.test/client');
		expect(directive(csp, 'script-src')).toContain(TURNSTILE_ORIGIN);
		expect(directive(csp, 'connect-src')).toContain('https://g.test/gsi/');
		expect(directive(csp, 'connect-src')).toContain(IP_LOOKUP_ORIGIN);
		expect(directive(csp, 'frame-src')).toContain('https://g.test/gsi/');
		expect(directive(csp, 'frame-src')).toContain(TURNSTILE_ORIGIN);
		expect(directive(csp, 'style-src')).toBe("style-src 'self' 'unsafe-inline' https://g.test/gsi/style");
	});

	it('adds nothing without google or with empty lists', () => {
		const empty = { script: [], connect: [], frame: [], style: [] };
		expect(buildCsp({ nonce: 'n', google: empty })).toBe(buildCsp({ nonce: 'n' }));
		expect(directive(buildCsp({ nonce: 'n' }), 'style-src')).toBe("style-src 'self' 'unsafe-inline'");
	});
});

describe('entry.express.tsx emits the built policy', () => {
	const src = readFileSync(join(process.cwd(), 'src/entry.express.tsx'), 'utf8');

	it('sets the header from buildCsp with the runtime site key and fallback flag', () => {
		expect(src).toContain('buildCsp({');
		expect(src).toContain('turnstileSiteKey: process.env.VITE_TURNSTILE_SITE_KEY');
		expect(src).toContain('ipCountryFallback: process.env.VITE_IP_COUNTRY_FALLBACK');
		expect(src).toContain("res.setHeader('Content-Security-Policy', cspDirectives)");
	});

	it('every Turnstile loader in the base (sign-in, login modal, contact, shared widget) uses the allowed origin', () => {
		for (const f of ['src/routes/sign-in/index.tsx', 'src/components/auth/LoginModal.tsx', 'src/routes/contact/index.tsx', 'src/utils/turnstile-widget.ts']) {
			expect(readFileSync(join(process.cwd(), f), 'utf8')).toContain(`${TURNSTILE_ORIGIN}/turnstile/`);
		}
	});
});
