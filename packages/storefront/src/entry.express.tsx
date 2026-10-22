// Must stay the first import: removes Node 26's server-side Web Storage globals before any app module evaluates.
import './utils/no-server-web-storage.server';
import {
 createQwikRouter,
 type PlatformNode,
} from"@qwik.dev/router/middleware/node";
import"dotenv/config";
import express from"express";
import { randomBytes } from"node:crypto";
import { join, dirname, basename, posix } from"node:path";
import { fileURLToPath } from"node:url";
import render from"./entry.ssr";
import { sellrightRequestCookie } from"./utils/sellright-request-context.server";
import { sellrightRequestHost } from"./utils/sellright-request-host.server";
import { assertProdApiConfigured } from"./constants";
import { NO_STORE_CACHE_CONTROL } from"./config/route-cache-policy";
import { snapshotGuard } from"./utils/snapshot-guard";
import { appleClientId, appleIdentityCsp, appleSignInClientIdForHost, appleSignInHosts, appleSignInRefusedForMissingPin } from "./config/apple-signin";
import { googleClientId, googleIdentityCsp, googleSignInClientIdForHost, googleSignInHosts, googleSignInRefusedForMissingPin } from"./config/google-signin";
import { createCanonicalUrlMiddleware, parseCanonicalSections } from"./utils/canonical-url";
import { buildCsp } from"./utils/csp";
import { theme } from"./theme/theme.config";
import { analyticsCsp } from"./platform/head-analytics";
import { BRAND_HEAD } from"./platform/brand-data";
import { getRouterOrigin, validatedRequestHost } from"./utils/trusted-request.server";

declare global {
 interface QwikRouterPlatform extends PlatformNode {}
}

// Directories where the static assets are located. Derived from THIS file's
// own directory name rather than a literal 'dist', so an alternate build
// (SELLRIGHT_BUILD_SUFFIX=demo -> outDir 'dist-demo'/'server-demo', see
// vite.config.ts + adapters/express/vite.config.mts) finds its own sibling
// dist-<suffix> at runtime instead of accidentally reading a leftover plain
// 'dist' from a different build sitting next to it. A stray 'dist' with
// mismatched asset hashes silently 404s every image/script it references.
const selfDir = dirname(fileURLToPath(import.meta.url));
const distDirName = basename(selfDir).replace(/^server/, 'dist');
const distDir = join(selfDir, "..", distDirName);
const buildDir = join(distDir,"build");
const assetsDir = join(distDir,"assets");

// Allow for dynamic port and host
const PORT = parseInt(process.env.PORT ?? '4100', 10);
const HOST = process.env.HOST ?? 'localhost';

// Create the Qwik Router Node middleware
// getOrigin: behind an HTTPS-terminating proxy the socket is plain http, so the framework's own origin never matches a
// browser form POST's Origin header (newsletter confirm/unsubscribe) and it answers 403. Derive it from the trusted
// boundary only (utils/trusted-request.server.ts); undefined keeps the framework default.
const { router, notFound } = createQwikRouter({
 render,
 getOrigin: getRouterOrigin,
});

// Create the express server
const app = express();
// No framework banner header (the license-flow buy pages never sent one; nothing reads it).
app.disable('x-powered-by');

// API / payment-provider origins the storefront legitimately talks to.
// Pulled from env so dev (127.0.0.1:3300) and prod (the real API host) both
// work without editing this file. 'self' always covers same-origin SSR calls.
const apiOrigin = (process.env.VITE_SELLRIGHT_API_URL || '')
	.replace(/\/(shop-api)?\/?$/, '')
	.trim();
// Google Identity origins join the CSP only for a request whose validated host belongs to the pinned store with
// Google sign-in on (config/google-signin.ts, the same decision the sign-in page makes): per request, never per process.
if (googleSignInRefusedForMissingPin()) {
	console.error('[google-signin] VITE_GOOGLE_CLIENT_ID is set but VITE_SELLRIGHT_STORE_SLUG is not: Google sign-in is disabled (it is only supported for a deployment pinned to a single store).');
}
else if (googleClientId() && googleSignInHosts().length === 0) {
	console.error('[google-signin] VITE_GOOGLE_CLIENT_ID is set but SELLRIGHT_GOOGLE_SIGNIN_HOSTS is empty: Google sign-in is disabled on every host (list the pinned store\'s public hosts, comma-separated).');
}

// Sign in with Apple: same per-host gating and the same startup diagnostics as Google.
if (appleSignInRefusedForMissingPin()) {
	console.error('[apple-signin] VITE_APPLE_CLIENT_ID is set but VITE_SELLRIGHT_STORE_SLUG is not: Apple sign-in is disabled (it is only supported for a deployment pinned to a single store).');
}
else if (appleClientId() && appleSignInHosts().length === 0) {
	console.error('[apple-signin] VITE_APPLE_CLIENT_ID is set but SELLRIGHT_APPLE_SIGNIN_HOSTS is empty: Apple sign-in is disabled on every host (list the pinned store\'s public hosts, comma-separated).');
}

// Set security headers
app.use((req, res, next) => {
	// Per-request CSP nonce. Threaded to Qwik's SSR render via a custom
	// x-qwik-nonce request header -> entry.ssr.tsx reads it back off
	// opts.serverData.requestHeaders -> <Root nonce> + serverData.nonce ->
	// the inline <script nonce=...> tags (this app's own, and the framework's
	// own bootstrap-loader script). Must match the nonce declared in
	// script-src below, or every inline script — including Qwik's own
	// bootstrap loader, meaning NO client-side interactivity at all — gets
	// silently dropped by the browser's CSP.
	//
	// NOT res.locals, NOT a plain `req.customProp`: neither survives the trip
	// through @qwik.dev/router's node-server middleware into this app's
	// render() call (see entry.ssr.tsx for the full trace) — only headers on
	// the request do, via opts.serverData.requestHeaders.
	const nonce = randomBytes(16).toString('base64');
	req.headers['x-qwik-nonce'] = nonce;

	// Security Headers - PCI DSS Compliance
	// XSS Protection
	res.setHeader('X-XSS-Protection', '0');

	// Prevent clickjacking
	res.setHeader('X-Frame-Options', 'SAMEORIGIN');

	// Prevent MIME type sniffing
	res.setHeader('X-Content-Type-Options', 'nosniff');

	// Referrer Policy - protect sensitive information in URLs
	res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

	// Permissions Policy - disable unnecessary browser features
	res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

	// Content Security Policy — tightened (FE-6). Per-directive allowlist
	// instead of the previous `default-src 'self' 'unsafe-inline' data:
	// https: blob:` catch-all, which was effectively no CSP at all (any
	// HTTPS origin + any inline script/style was allowed).
	//
	// Final policy:
	//   default-src 'self'                                    — safe fallback
	//   script-src  'self' 'nonce-<per-request>' https://js.stripe.com
	//               https://sandbox.nmi.com https://secure.nmi.com
	//                                                          — Qwik's inline
	//               bootstrap + this app's inline scripts use the SSR nonce;
	//               Stripe.js (loadStripe) is loaded from js.stripe.com;
	//               NMI Collect.js (loadCollectJs) is loaded from
	//               sandbox.nmi.com (test) / secure.nmi.com (live) — see
	//               services/NmiCollect.ts's collectJsSrc; Turnstile's api.js is
	//               injected without a nonce, hence its origin (when configured)
	//   style-src   'self' 'unsafe-inline'                    — Qwik/Tailwind
	//               emit inline <style> tags per-component with no nonce
	//               support today; unsafe-inline is scoped to STYLE only
	//   img-src     'self' data: https:                       — product/CDN images
	//   font-src    'self'                                    — self-hosted webfonts only
	//   connect-src 'self' https://api.stripe.com
	//               https://sandbox.nmi.com https://secure.nmi.com <api origin>
	//               [+ https://ipapi.co when the browser country fallback is on]
	//                                                          — SellRight API,
	//               Stripe, and NMI Collect.js's own tokenization XHR calls
	//   frame-src   https://js.stripe.com https://hooks.stripe.com
	//               https://sandbox.nmi.com https://secure.nmi.com
	//                                                          — Stripe Payment
	//               Element / 3DS iframes, NMI Collect.js's hosted card
	//               number/expiry/cvv iframes (never this app's own PAN input)
	//               [+ https://challenges.cloudflare.com when a Turnstile site key is set]
	//   object-src  'none'
	//   base-uri    'self'
	//   form-action 'self'
	//   frame-ancestors 'none'
	//   upgrade-insecure-requests
	// The directive list lives in utils/csp.ts (pure, unit-tested). Conditional origins include Cloudflare Turnstile
	// (script-src + frame-src) when a site key is configured, and ipapi.co (connect-src) when the browser country fallback
	// is enabled; SheerID (script-src + frame-src) uses the same built theme flag as its homepage offer.
	// Google Identity origins (script/style/connect/frame) join only when Google sign-in is on.
	const cspDirectives = buildCsp({
		nonce,
		apiOrigin,
		turnstileSiteKey: process.env.VITE_TURNSTILE_SITE_KEY,
		ipCountryFallback: process.env.VITE_IP_COUNTRY_FALLBACK,
		sheerIdEnabled: theme.sheerIdEnabled,
		// Per request: this host's own Google decision (same function as the sign-in page), never a process-wide one.
		google: googleIdentityCsp(googleSignInClientIdForHost(validatedRequestHost(req.headers))),
		apple: appleIdentityCsp(appleSignInClientIdForHost(validatedRequestHost(req.headers))),
		// Brand views: GTM origins only when head.json declares analytics (undefined = the policy is unchanged).
		analytics: analyticsCsp(BRAND_HEAD.analytics),
		youtubeEmbed: BRAND_HEAD.embeds?.youtube === true,
	});

	res.setHeader('Content-Security-Policy', cspDirectives);

	// Strict Transport Security - enforce HTTPS (only in production)
	if (process.env.NODE_ENV === 'production') {
		res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
	}

	next();
});

// Per-request context: thread the incoming cookie header through to every
// sr() fetch this request triggers (SSR data loads need the caller's own
// session/visitor cookie, not an anonymous server-to-server call — see
// utils/sellright-request-context.server.ts). Must wrap the router itself,
// not just start before it, so the AsyncLocalStorage context is live for the
// whole async render.
app.use((req, _res, next) => {
	sellrightRequestCookie.run(req.headers.cookie, next);
});

// WS-C: thread the incoming Host (X-Forwarded-Host preferred only behind a declared trusted proxy — same precedence
// the API's resolveStoreForRequest applies) through to every sr() fetch this
// request triggers, so SSR data loads resolve the SAME store a browser
// request to this host would get. Nested inside the cookie ALS.run above is
// fine — both are independent AsyncLocalStorage instances.
app.use((req, _res, next) => {
	// Same trusted boundary as the Google decision and the form-POST origin: the connection's Host, or X-Forwarded-Host
	// only when SELLRIGHT_TRUST_FORWARDED_HOST=1 (utils/trusted-request.server.ts). A forged header is never forwarded.
	const host = validatedRequestHost(req.headers) || undefined;
	sellrightRequestHost.run(host, next);
});

// Snapshot guard (utils/snapshot-guard.ts): a document-shaped path is a plain no-store 404, answered before the static
// handlers and the canonical redirect, so neither a stale prerendered file nor a cacheable 301 can answer it.
app.use(snapshotGuard);

// Static asset handlers
app.use(`/build`, express.static(buildDir, { immutable: true, maxAge:"1y" }));
app.use(`/assets`, express.static(assetsDir, { immutable: true, maxAge:"1y" }));
// Add specific handler for fonts
app.use('/fonts', express.static(join(distDir, 'fonts'), { immutable: true, maxAge:"1y" }));
// Root static assets with custom cache control. Documents and route data are never served from disk: an .html file
// or a loader/route-data JSON left in dist (for example by an older build that prerendered pages) would bypass the
// router and the no-store policy and carry build-time availability, so those requests skip the static handler.
// The check runs on the DECODED path (the static handler decodes before it reads the file, so `index%2ehtml` would
// otherwise slip through) and covers precompressed copies. An undecodable path is not a static file either.
const NEVER_STATIC = /\.html?(\.(gz|br))?$|(^|\/)q-(data|loader)[^/]*\.json(\.(gz|br))?$/i;
export const neverServedFromDisk = (rawPath: string): boolean => {
  let decoded: string;
  try { decoded = decodeURIComponent(rawPath); } catch { return true; }
  // Normalise the way the static handler does before it opens a file (dot segments, repeated and trailing slashes),
  // so `index.html/.` or `x/../index.html` is judged as the file it would resolve to.
  const normalized = posix.normalize(decoded.replace(/\\/g, '/')).replace(/\/+$/, '');
  return NEVER_STATIC.test(normalized);
};
const rootStatic = express.static(distDir, {
  index: false, // Pages need fresh loaders and the per-request CSP nonce.
  redirect: false,
  dotfiles: 'allow',
  setHeaders: (res, path) => {
    const fileName = path.split('/').pop() || '';
    // For q-manifest.json and service workers, never cache.
    if (fileName === 'q-manifest.json' || (fileName.endsWith('.js') && !path.includes('/build/'))) {
      res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    }
  },
});
app.use((req, res, next) => (neverServedFromDisk(req.path) ? next() : rootStatic(req, res, next)));

// Fail-closed default for everything past the static handlers (documents, loader/action data, 404s): the value comes
// from the one policy file. Routes that are provably stock-free (sitemaps, robots) and the layout's own header
// override it; Qwik's 404 handler and any route that sets nothing inherit it, so an unknown path is never stored.
app.use((_req, res, next) => {
  res.setHeader('Cache-Control', NO_STORE_CACHE_CONTROL);
  next();
});

// URL canonicalisation for public sections (STOREFRONT_CANONICAL_SECTIONS, default OFF). It sits after the snapshot guard
// (documents and route data skip the static handlers above and are never redirected: they carry a file extension) and after
// every asset handler, and it inherits the no-store default above. Only page GET/HEAD requests are ever redirected.
app.use(createCanonicalUrlMiddleware(parseCanonicalSections(process.env.STOREFRONT_CANONICAL_SECTIONS)));

// Use Qwik Router's page and endpoint request handler
app.use(router);

// Use Qwik Router's 404 handler
app.use(notFound);

// Fail loud rather than silently serving a dev API URL: VITE_SELLRIGHT_PROD_URL
// is inlined at build time, so if a production build was produced without it,
// this Node process (NODE_ENV=production) refuses to start rather than serve
// checkout/catalog traffic against a dev-port default nothing is listening on
// in prod. Checked here — at actual server startup — not at build time (see
// constants.ts assertProdApiConfigured for why the build itself must not throw).
assertProdApiConfigured(process.env.NODE_ENV, process.env.SELLRIGHT_API_URL);

// Start the express server
app.listen(PORT, HOST, () => {
 console.log(`Server started: http://${HOST}:${PORT}/`);
 // pm2 `wait_ready`: tell the process manager the listener is up (no-op when not forked with an IPC channel). A20/D6.
 process.send?.('ready');
});
