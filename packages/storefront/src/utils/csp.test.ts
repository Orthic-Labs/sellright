import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { googleIdentityCsp, googleSignInClientIdForHost } from '../config/google-signin';
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

	it('puts each real Google Identity source in its own directives and in no other', () => {
		const google = googleIdentityCsp('x.apps.googleusercontent.com');
		const csp = buildCsp({ nonce: 'n', google });
		const lists = { 'script-src': google.script, 'connect-src': google.connect, 'frame-src': google.frame, 'style-src': google.style };
		const sources = [...new Set(Object.values(lists).flat())];
		expect(sources.length).toBeGreaterThan(0);
		for (const d of csp.split('; ')) {
			const name = d.split(' ')[0];
			const tokens = d.split(' ').slice(1);
			const allowed: string[] = lists[name as keyof typeof lists] ?? [];
			for (const s of sources) expect(tokens.includes(s), `${s} in ${name}`).toBe(allowed.includes(s));
		}
	});

	it('adds nothing without google or with empty lists', () => {
		const empty = { script: [], connect: [], frame: [], style: [] };
		expect(buildCsp({ nonce: 'n', google: empty })).toBe(buildCsp({ nonce: 'n' }));
		expect(directive(buildCsp({ nonce: 'n' }), 'style-src')).toBe("style-src 'self' 'unsafe-inline'");
	});
});

describe('buildCsp — Google sources are decided per request host (the entry passes the same expression)', () => {
	const cspFor = (host: string) => buildCsp({ nonce: 'n', google: googleIdentityCsp(googleSignInClientIdForHost(host, 'x.apps.googleusercontent.com', 'store-a', 'a.example')) });

	it('the pinned store host gets the Google origins; a second host reaching the same process gets none', () => {
		expect(cspFor('a.example')).toContain('https://accounts.google.com/gsi/client');
		expect(cspFor('b.example')).not.toContain('accounts.google.com');
		expect(cspFor('b.example')).toBe(buildCsp({ nonce: 'n' }));
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

	it('every Turnstile loader in the base (sign-in, login modal, contact controller, shared widget) uses the allowed origin', () => {
		// the contact form's loader moved from routes/contact/index.tsx into the platform controller (brand views)
		for (const f of ['src/routes/sign-in/index.tsx', 'src/components/auth/LoginModal.tsx', 'src/platform/controllers/content.tsx', 'src/utils/turnstile-widget.ts']) {
			expect(readFileSync(join(process.cwd(), f), 'utf8')).toContain(`${TURNSTILE_ORIGIN}/turnstile/`);
		}
	});
});

describe('buildCsp — analytics sources (brand views)', () => {
	const analytics = { script: ['https://*.googletagmanager.com'], connect: ['https://*.google-analytics.com', 'https://*.analytics.google.com', 'https://*.googletagmanager.com'] };

	it('is unchanged without analytics (byte-identical policy)', () => {
		const withUndefined = buildCsp({ nonce: 'n', analytics: undefined });
		expect(withUndefined).toBe(buildCsp({ nonce: 'n' }));
		expect(withUndefined).not.toContain('googletagmanager');
	});

	it('adds the script and connect origins only, keeps the nonce policy, never unsafe-eval', () => {
		const csp = buildCsp({ nonce: 'abc', analytics });
		expect(directive(csp, 'script-src')).toContain('https://*.googletagmanager.com');
		expect(directive(csp, 'connect-src')).toContain('https://*.google-analytics.com');
		expect(directive(csp, 'connect-src')).toContain('https://*.analytics.google.com');
		expect(directive(csp, 'connect-src')).toContain('https://*.googletagmanager.com');
		expect(directive(csp, 'script-src')).toContain("'nonce-abc'");
		expect(csp).not.toContain('unsafe-eval');
		expect(directive(csp, 'script-src')).not.toContain("'unsafe-inline'");
		expect(directive(csp, 'frame-src')).not.toContain('googletagmanager');
		expect(directive(csp, 'style-src')).not.toContain('googletagmanager');
	});

	it('merges with Google Identity and keeps every other origin', () => {
		const csp = buildCsp({ nonce: 'n', turnstileSiteKey: 'k', google: { script: ['https://g.test/c'], connect: ['https://g.test/'], frame: [], style: [] }, analytics });
		expect(directive(csp, 'script-src')).toContain('https://g.test/c');
		expect(directive(csp, 'script-src')).toContain('https://*.googletagmanager.com');
		expect(directive(csp, 'script-src')).toContain(TURNSTILE_ORIGIN);
		expect(directive(csp, 'connect-src')).toContain('https://g.test/');
	});
});
