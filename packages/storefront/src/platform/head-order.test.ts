import { describe, expect, it } from 'vitest';
import { headOrderWriter, reorderHead } from './head-order';

// The live damneddesigns.com /shop/ head as Qwik 2.0.0-rc.3 writes it (2026-10-31), middle trimmed. `nonce` adds the per-request
// nonce the way server.mjs writes it on a non-shell render.
const BOOT = (n: string) =>
	`<script type="module" async crossorigin="anonymous"${n}>window.addEventListener('load',f=>{f=_=>{let b=fetch("/build/bundle-graph-B.json");import("/build/q-PRE.js").then(({l})=>l("/build/",b))};requestAnimationFrame(_=>requestAnimationFrame(_=>{typeof requestIdleCallback==='function'?requestIdleCallback(f,{timeout:1000}):requestAnimationFrame(_=>setTimeout(f))}))})</script>`;
const liveHead = (nonce?: string) => {
	const n = nonce ? ` nonce="${nonce}"` : '';
	return (
		`<head :="4z_9">` +
		`<link rel="modulepreload" href="/build/q-QL.js"${n} :><script async type="module" src="/build/q-QL.js"${n}></script>` +
		`<link rel="modulepreload" href="/build/q-PRE.js"${n} :>` +
		`<link rel="preload" href="/build/bundle-graph-B.json" as="fetch" crossorigin="anonymous" :>` +
		BOOT(n) +
		`<link rel="modulepreload" href="/build/q-CORE.js"${n} :>` +
		`<meta : charSet="utf-8"><meta : name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">` +
		`<meta : name="theme-color" content="#1a1a1a"><style :>html{background:#1a1a1a}</style><title :>Shop<!--t=1-->x</title>` +
		`<link href="/favicon/favicon.svg" :="4z_3" rel="icon" type="image/svg+xml">` +
		`<link as="font" crossOrigin="anonymous" fetchPriority="high" href="/fonts/c-700.woff2" rel="preload" type="font/woff2" :="font:/fonts/c-700.woff2">` +
		`<script :="gtm" q:container="html"${n}>(function(){})()</script>` +
		`<link : rel="stylesheet" href="/build/style-D.css">` +
		`</head>`
	);
};

/** Tags of the `:`-marked elements (the ones Qwik's resume counts), in document order. */
const marked = (html: string) => [...html.matchAll(/<([a-z]+)\b[^>]*\s:(?=[=\s>])[^>]*>/g)].map((m) => m[1]);
/** Resume safety: same count of marked elements; the head's top run (head + Qwik's 4 links + charset + viewport = 7) holds the
 *  same elements in another order; from the first element with content (<style>) on, the same tag at every index. */
const sameRuns = (after: string, before: string) => {
	const a = marked(after), b = marked(before);
	expect(a).toHaveLength(b.length);
	expect(a.slice(0, 7).sort()).toEqual(b.slice(0, 7).sort());
	expect(a.slice(7)).toEqual(b.slice(7));
};
/** Each resource tag reduced to rel + href, in document order. */
const resources = (html: string) =>
	[...html.matchAll(/<(link|meta|script)\b[^>]*>/g)].map((m) => {
		const t = m[0];
		const a = (k: string) => new RegExp(`\\s${k}="([^"]*)"`).exec(t)?.[1];
		if (m[1] === 'meta') return a('charSet') ? 'meta:charset' : `meta:${a('name')}`;
		if (m[1] === 'script') return a('src') ? `script:${a('src')}` : 'script';
		return `${a('rel')}:${a('href')}`;
	});

describe('reorderHead (F2)', () => {
	for (const nonce of [undefined, 'Qrw77BAULlN+6Itr1HxYOQ==']) {
		it(`puts the stylesheet first after charset/viewport, then core + qwikloader; defers the preloader hints (${nonce ? 'nonce' : 'shell'})`, () => {
			const before = liveHead(nonce);
			const after = reorderHead(before);
			expect(resources(after).slice(0, 9)).toEqual([
				'meta:charset',
				'meta:viewport',
				'stylesheet:/build/style-D.css',
				'modulepreload:/build/q-CORE.js',
				'modulepreload:/build/q-QL.js',
				'script:/build/q-QL.js',
				'prefetch:/build/q-PRE.js',
				'script',
				'meta:theme-color',
			]);
			// The bundle graph takes the stylesheet's old place at the end, as an idle prefetch.
			expect(after).toMatch(/<link rel="prefetch" href="\/build\/bundle-graph-B\.json" as="fetch" crossorigin="anonymous" :><\/head>$/);
			// Only one modulepreload before any font preload: core + qwikloader, nothing else as preload/modulepreload ahead of the CSS.
			const firstSheet = after.indexOf('rel="stylesheet"');
			expect(after.slice(0, firstSheet)).not.toMatch(/rel="(?:modulepreload|preload)"/);
			expect(after.match(/rel="modulepreload"/g)).toHaveLength(2);
			expect(after).not.toMatch(/rel="preload"[^>]*as="fetch"/);
			sameRuns(after, before);
			expect([...after].sort().join('')).toBe([...before.replace(/rel="preload" href="\/build\/bundle/, 'rel="prefetch" href="/build/bundle').replace(/rel="modulepreload" href="\/build\/q-PRE/, 'rel="prefetch" href="/build/q-PRE')].sort().join(''));
			// Inline scripts (ADR-0001 hashes them at response end) are byte-identical.
			const scripts = (h: string) => [...h.matchAll(/<script\b[^>]*>[\s\S]*?<\/script>/g)].map((m) => m[0]).sort();
			expect(scripts(after)).toEqual(scripts(before));
		});
	}

	it('passes through anything that is not the expected shape', () => {
		const noSheet = liveHead().replace('<link : rel="stylesheet" href="/build/style-D.css">', '');
		expect(reorderHead(noSheet)).toBe(noSheet);
		const extraTop = liveHead().replace('<meta : charSet', '<link rel="dns-prefetch" href="https://x.example" :><meta : charSet');
		expect(reorderHead(extraTop)).toBe(extraTop);
		const noCharset = liveHead().replace(' charSet="utf-8"', ' name="x"');
		expect(reorderHead(noCharset)).toBe(noCharset);
		const styleLast = liveHead().replace('</head>', '<style q:style="a">.a{}</style></head>');
		expect(reorderHead(styleLast)).toBe(styleLast);
		expect(reorderHead('<head></head>')).toBe('<head></head>');
	});

	it('handles two stylesheets by displacing the graph and the preloader hints', () => {
		const two = liveHead().replace('</head>', '<link : rel="stylesheet" href="/build/style-E.css"></head>');
		const after = reorderHead(two);
		expect(resources(after).slice(0, 6)).toEqual(['meta:charset', 'meta:viewport', 'stylesheet:/build/style-D.css', 'stylesheet:/build/style-E.css', 'modulepreload:/build/q-CORE.js', 'modulepreload:/build/q-QL.js']);
		sameRuns(after, two);
		expect(after).toMatch(/<link rel="prefetch" href="\/build\/bundle-graph-B\.json"[^>]*><link rel="prefetch" href="\/build\/q-PRE\.js" :><\/head>$/);
	});
});

describe('headOrderWriter (F2)', () => {
	const doc = (head: string) => `<!DOCTYPE html><html q:container="paused" lang="en">${head}<body :><header :>h</header><main :>m</main></body></html>`;

	it('writes the same document as reorderHead whatever the chunking, and passes the body through', () => {
		const html = doc(liveHead('n0nce'));
		const expected = doc(reorderHead(liveHead('n0nce')));
		for (const size of [1, 7, 64, 1000, html.length]) {
			const out: string[] = [];
			const w = headOrderWriter({ write: (c) => void out.push(c) });
			for (let i = 0; i < html.length; i += size) w.write(html.slice(i, i + size));
			w.flush();
			expect(out.join('')).toBe(expected);
		}
	});

	it('returns the underlying write result once released, and flushes an unclosed head unchanged', () => {
		const out: string[] = [];
		const ack = Promise.resolve();
		const w = headOrderWriter({ write: (c) => (out.push(c), ack) });
		expect(w.write('<html><head>')).toBeUndefined();
		expect(w.flush()).toBe(ack);
		expect(out.join('')).toBe('<html><head>');
		expect(w.write('x')).toBe(ack);
		expect(w.flush()).toBeUndefined();
	});

	it('does not mistake <header> for <head>', () => {
		const out: string[] = [];
		const w = headOrderWriter({ write: (c) => void out.push(c) });
		w.write('<div><header>a</header></div><head></head>');
		expect(out.join('')).toBe('<div><header>a</header></div><head></head>');
	});
});
