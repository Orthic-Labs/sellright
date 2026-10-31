#!/usr/bin/env node
// ADR-0001 conformance check (read-only GETs). Walks one sample URL per route class against a base URL and reports the origin's
// Cache-Control, Cloudflare's cf-cache-status and the CSP shape against what the class allows:
//   shell   -> when the switch is on: `public, max-age=0, s-maxage=<n>` (no stale-while-revalidate), nonce-free hash CSP,
//              no Set-Cookie; when off (or any I-6 failure): `private, no-store`.
//   dynamic -> `private, no-store` always.
//   data    -> `private, no-store` always (or a non-2xx with no-store).
// Usage: node deploy/edge-conformance.mjs <baseUrl> [--expect-shell on|off] [--product /products/<slug>/] [--collection /collections/<slug>/]
//        [--blog-post /blog/<slug>/] [--json]
// Exit 1 when any row fails. Sends no cookies; a second shell pass sends a fake signed-in cookie to prove it does not change the body.
import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
const flag = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const base = (args.find((a) => /^https?:\/\//.test(a)) ?? '').replace(/\/+$/, '');
if (!base) { console.error('usage: edge-conformance.mjs <baseUrl> [--expect-shell on|off] [--product PATH] [--collection PATH] [--blog-post PATH] [--json]'); process.exit(2); }
const expectShell = flag('--expect-shell', 'off');
const json = args.includes('--json');

const ROWS = [
	['shell', '/'], ['shell', '/shop/'], ['shell', flag('--product', null)], ['shell', flag('--collection', null)],
	['shell', '/blog/'], ['shell', flag('--blog-post', null)], ['shell', '/about/'], ['shell', '/contact/'],
	['shell', '/privacy/'], ['shell', '/terms/'], ['shell', '/returns/'], ['shell', '/checkout/'],
	['dynamic', '/checkout/payment/'], ['dynamic', '/checkout/cart-link/'], ['dynamic', '/account/'], ['dynamic', '/sign-in/'],
	['dynamic', '/search/?q=a'], ['dynamic', '/track-order/'], ['dynamic', '/verify/'], ['dynamic', '/forgot-password/'],
	['dynamic', '/?preview_token=conformance'], ['dynamic', '/collections/x/?page=2'], ['dynamic', '/edge-conformance-unknown/'],
	['data', '/v1/shop/me'],
].filter(([, p]) => p);

const isNoStore = (cc) => /\bno-store\b/.test(cc) && !/\bpublic\b|s-maxage/.test(cc);
const isShellPublic = (cc) => /^public, max-age=0, s-maxage=\d+$/.test(cc);

// K-1: Qwik stamps a random per-render container id (q:instance, also inside the qFuncs_/_qwikEv inline scripts). Two renders of
// the same anonymous shell differ only there; compare bodies with it replaced.
const withoutInstance = (body) => { const id = /q:instance="([^"]+)"/.exec(body)?.[1]; return id ? body.replaceAll(id, 'QINSTANCE') : body; };

async function get(path, headers = {}) {
	const r = await fetch(`${base}${path}`, { headers: { 'user-agent': 'sellright-edge-conformance/1', ...headers }, redirect: 'manual' });
	const body = await r.text();
	return { status: r.status, cc: r.headers.get('cache-control') ?? '', cf: r.headers.get('cf-cache-status') ?? '-', csp: r.headers.get('content-security-policy') ?? '',
		setCookie: r.headers.get('set-cookie'), diag: r.headers.get('x-sr-edge') ?? '', hash: createHash('sha256').update(withoutInstance(body)).digest('hex').slice(0, 12) };
}

const results = [];
for (const [cls, path] of ROWS) {
	const res = await get(path);
	const problems = [];
	if (cls === 'shell' && expectShell === 'on' && res.status === 200) {
		if (!isShellPublic(res.cc)) problems.push(`cache-control ${res.cc || '(none)'} (diag ${res.diag || '-'})`);
		if (res.setCookie) problems.push('set-cookie on a cacheable response');
		const scriptSrc = res.csp.split(/;\s*/).find((d) => d.startsWith('script-src ')) ?? '';
		if (/nonce-|unsafe-inline/.test(scriptSrc)) problems.push('script-src has a nonce or unsafe-inline');
		const signed = await get(path, { cookie: 'sr_cust=conformance; countryCode=DE', authorization: 'Bearer conformance' });
		if (signed.hash !== res.hash) problems.push(`signed-in body differs (${signed.hash} vs ${res.hash})`);
	} else if (!isNoStore(res.cc)) {
		problems.push(`expected private no-store, got ${res.cc || '(none)'}`);
	}
	results.push({ class: cls, path, status: res.status, cacheControl: res.cc, cfCacheStatus: res.cf, diag: res.diag, ok: problems.length === 0, problems });
}

if (json) console.log(JSON.stringify({ base, expectShell, results }, null, 2));
else for (const r of results) console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.class.padEnd(7)} ${String(r.status).padEnd(3)} cf=${r.cfCacheStatus.padEnd(8)} ${r.path}  [${r.cacheControl}]${r.problems.length ? `  <- ${r.problems.join('; ')}` : ''}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
