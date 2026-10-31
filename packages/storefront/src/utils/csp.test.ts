import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appleIdentityCsp, appleSignInClientIdForHost } from '../config/apple-signin';
import { googleIdentityCsp, googleSignInClientIdForHost } from '../config/google-signin';
import { buildCsp, IP_LOOKUP_ORIGIN, SHEERID_ORIGIN, TURNSTILE_ORIGIN } from './csp';
import { YOUTUBE_EMBED_ORIGIN } from '../platform/youtube';

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

describe('buildCsp — explicit SheerID opt-in', () => {
	it('adds only the exact SDK origin to script-src and frame-src, preserving every other directive', () => {
		const base = buildCsp({ nonce: 'n' });
		const enabled = buildCsp({ nonce: 'n', sheerIdEnabled: true });
		expect(SHEERID_ORIGIN).toBe('https://services.sheerid.com');
		expect(enabled.split('; ')).toEqual(base.split('; ').map((line) => (
			['script-src', 'frame-src'].includes(line.split(' ')[0]) ? `${line} ${SHEERID_ORIGIN}` : line
		)));
		expect(enabled).not.toContain('*.sheerid.com');
		expect(enabled).not.toContain('unsafe-eval');
		expect(directive(enabled, 'script-src')).toContain("'nonce-n'");
		expect(directive(enabled, 'script-src')).not.toContain("'unsafe-inline'");
	});

	it('keeps the original policy byte-identical without opt-in', () => {
		const base = buildCsp({ nonce: 'n' });
		expect(base).not.toContain(SHEERID_ORIGIN);
		for (const sheerIdEnabled of [undefined, false]) {
			expect(buildCsp({ nonce: 'n', sheerIdEnabled })).toBe(base);
		}
	});

	it('preserves existing provider options without adding arbitrary brand origins', () => {
		const options = {
			nonce: 'n', apiOrigin: 'https://api.example.test', turnstileSiteKey: 'k', ipCountryFallback: '0',
			google: googleIdentityCsp('x.apps.googleusercontent.com'),
			analytics: { script: ['https://analytics.example.test'], connect: ['https://analytics.example.test'] },
			youtubeEmbed: true,
		};
		const base = buildCsp(options);
		const enabled = buildCsp({ ...options, sheerIdEnabled: true });
		expect(enabled.split(` ${SHEERID_ORIGIN}`).join('')).toBe(base);
		expect(enabled.split('; ').filter((line) => line.includes(SHEERID_ORIGIN)).map((line) => line.split(' ')[0])).toEqual(['script-src', 'frame-src']);
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
		expect(directive(csp, 'style-src')).toBe("style-src 'self' 'unsafe-inline' https://sandbox.nmi.com https://secure.nmi.com https://g.test/gsi/style");
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
		expect(directive(buildCsp({ nonce: 'n' }), 'style-src')).toBe("style-src 'self' 'unsafe-inline' https://sandbox.nmi.com https://secure.nmi.com");
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

	it('uses the canonical SheerID enablement config shared with the homepage', () => {
		expect(src).toMatch(/import\s*\{\s*theme\s*\}\s*from["']\.\/theme\/theme\.config["']/);
		expect(src).toContain('sheerIdEnabled: theme.sheerIdEnabled');
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


describe('buildCsp — explicit YouTube privacy embed opt-in', () => {
	it('adds only the exact privacy origin to frame-src, preserving every other directive', () => {
		const base = buildCsp({ nonce: 'n' });
		const enabled = buildCsp({ nonce: 'n', youtubeEmbed: true });
		expect(directive(enabled, 'frame-src')).toBe(`${directive(base, 'frame-src')} ${YOUTUBE_EMBED_ORIGIN}`);
		for (const line of base.split('; ').filter((line) => !line.startsWith('frame-src '))) expect(enabled.split('; ')).toContain(line);
		expect(enabled).not.toContain('https://www.youtube.com');
		expect(enabled).not.toContain('https://i.ytimg.com');
	});
	it('keeps the original policy without opt-in & reads the same opt-in in Express', () => {
		expect(buildCsp({ nonce: 'n', youtubeEmbed: false })).toBe(buildCsp({ nonce: 'n' }));
		expect(buildCsp({ nonce: 'n' })).not.toContain(YOUTUBE_EMBED_ORIGIN);
		expect(readFileSync(join(process.cwd(), 'src/entry.express.tsx'), 'utf8')).toContain('youtubeEmbed: BRAND_HEAD.embeds?.youtube === true');
	});
});

describe('buildCsp — Sign in with Apple sources join only when supplied, per directive', () => {
	it('puts each real Apple source in its own directives and in no other', () => {
		const apple = appleIdentityCsp('com.example.web');
		const csp = buildCsp({ nonce: 'n', apple });
		const lists = { 'script-src': apple.script, 'connect-src': apple.connect, 'frame-src': apple.frame };
		const sources = [...new Set(Object.values(lists).flat())];
		expect(sources.length).toBeGreaterThan(0);
		for (const d of csp.split('; ')) {
			const name = d.split(' ')[0];
			const tokens = d.split(' ').slice(1);
			const allowed: string[] = lists[name as keyof typeof lists] ?? [];
			for (const sc of sources) expect(tokens.includes(sc), `${sc} in ${name}`).toBe(allowed.includes(sc));
		}
	});

	it('adds nothing without apple or with empty lists, and coexists with Google', () => {
		expect(buildCsp({ nonce: 'n', apple: { script: [], connect: [], frame: [], style: [] } })).toBe(buildCsp({ nonce: 'n' }));
		const both = buildCsp({ nonce: 'n', google: googleIdentityCsp('x.apps.googleusercontent.com'), apple: appleIdentityCsp('com.example.web') });
		expect(directive(both, 'script-src')).toContain('https://accounts.google.com/gsi/client');
		expect(directive(both, 'script-src')).toContain('https://appleid.cdn-apple.com/');
		expect(directive(both, 'frame-src')).toContain('https://accounts.google.com/gsi/');
		expect(directive(both, 'frame-src')).toContain('https://appleid.apple.com');
	});

	it('is decided per request host: the pinned store host gets Apple origins, another host gets none', () => {
		const cspFor = (host: string) => buildCsp({ nonce: 'n', apple: appleIdentityCsp(appleSignInClientIdForHost(host, 'com.example.web', 'store-a', 'a.example')) });
		expect(cspFor('a.example')).toContain('https://appleid.apple.com');
		expect(cspFor('b.example')).toBe(buildCsp({ nonce: 'n' }));
	});
});

describe('buildCsp — #400 Damned checkout violations', () => {
	it('allows the Apple Pay font origin', () => {
		expect(directive(buildCsp({ nonce: 'n' }), 'font-src')).toBe("font-src 'self' https://applepay.cdn-apple.com");
	});
	it('allows data: in connect-src only with Turnstile configured', () => {
		expect(directive(buildCsp({ nonce: 'n', turnstileSiteKey: 'site-key' }), 'connect-src').split(' ')).toContain('data:');
		expect(directive(buildCsp({ nonce: 'n' }), 'connect-src').split(' ')).not.toContain('data:');
	});
});

describe('ADR-0001 hash CSP for shell renders', async () => {
	const { createHash } = await import('node:crypto');
	const { executableInlineScripts, inlineScriptHashSources, withScriptHashes } = await import('./csp');
	const sha = (t: string) => createHash('sha256').update(t, 'utf8').digest('base64');

	it('buildCsp without a nonce has no nonce source and never unsafe-inline for scripts; with one it is unchanged', () => {
		const none = directive(buildCsp({ nonce: undefined }), 'script-src');
		expect(none).toBe("script-src 'self' https://static.cloudflareinsights.com https://js.stripe.com https://sandbox.nmi.com https://secure.nmi.com https://applepay.cdn-apple.com");
		expect(directive(buildCsp({ nonce: 'abc' }), 'script-src')).toBe("script-src 'self' 'nonce-abc' https://js.stripe.com https://sandbox.nmi.com https://secure.nmi.com https://applepay.cdn-apple.com");
	});

	it('finds exactly the executable inline scripts (not src, JSON-LD or Qwik data)', () => {
		const loader = 'window.qwikevents=1;';
		const gtm = '(function(){var c=document.currentScript;})();';
		const html = `<script nonce="N1">${gtm}</script><script type="application/ld+json">{}</script><script src="/build/q-1.js"></script>`
			+ `<script type="qwik/json">{}</script><script type="qwik/vnode">x</script><script id="qwikloader" type="module" async>${loader}</script><script type='module'>${loader}</script>`;
		expect(executableInlineScripts(html)).toEqual([gtm, loader, loader]);
		expect(inlineScriptHashSources(html, sha)).toEqual([`'sha256-${sha(gtm)}'`, `'sha256-${sha(loader)}'`]);
	});

	it('withScriptHashes drops any nonce, inserts hashes after self, and refuses unsafe-inline or a missing script-src', () => {
		const csp = "default-src 'self'; script-src 'self' 'nonce-x+/=' https://js.stripe.com; style-src 'self' 'unsafe-inline'";
		expect(withScriptHashes(csp, ["'sha256-A'", "'sha256-B'"])).toBe("default-src 'self'; script-src 'self' 'sha256-A' 'sha256-B' https://js.stripe.com; style-src 'self' 'unsafe-inline'");
		expect(withScriptHashes(csp, [])).toBe("default-src 'self'; script-src 'self' https://js.stripe.com; style-src 'self' 'unsafe-inline'");
		expect(() => withScriptHashes("script-src 'self' 'unsafe-inline'", [])).toThrow();
		expect(() => withScriptHashes("default-src 'self'", [])).toThrow();
	});
});
