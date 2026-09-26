import {
 createQwikRouter,
 type PlatformNode,
} from"@qwik.dev/router/middleware/node";
import"dotenv/config";
import express from"express";
import { randomBytes } from"node:crypto";
import { join, dirname, basename } from"node:path";
import { fileURLToPath } from"node:url";
import render from"./entry.ssr";
import { sellrightRequestCookie } from"./utils/sellright-request-context.server";
import { assertProdApiConfigured } from"./constants";

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
const { router, notFound } = createQwikRouter({
 render,
});

// Create the express server
const app = express();

// API / payment-provider origins the storefront legitimately talks to.
// Pulled from env so dev (127.0.0.1:3300) and prod (the real API host) both
// work without editing this file. 'self' always covers same-origin SSR calls.
const apiOrigin = (process.env.VITE_SELLRIGHT_API_URL || '')
	.replace(/\/(shop-api)?\/?$/, '')
	.trim();
const connectSrcExtra = apiOrigin ? ` ${apiOrigin}` : '';

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
	//                                                          — Qwik's inline
	//               bootstrap + this app's inline scripts use the SSR nonce;
	//               Stripe.js (loadStripe) is loaded from js.stripe.com
	//   style-src   'self' 'unsafe-inline'                    — Qwik/Tailwind
	//               emit inline <style> tags per-component with no nonce
	//               support today; unsafe-inline is scoped to STYLE only
	//   img-src     'self' data: https:                       — product/CDN images
	//   font-src    'self'                                    — self-hosted webfonts only
	//   connect-src 'self' https://api.stripe.com <api origin>
	//                                                          — SellRight API + Stripe
	//   frame-src   https://js.stripe.com https://hooks.stripe.com
	//                                                          — Stripe Payment
	//               Element / 3DS iframes
	//   object-src  'none'
	//   base-uri    'self'
	//   form-action 'self'
	//   frame-ancestors 'none'
	//   upgrade-insecure-requests
	const cspDirectives = [
		`default-src 'self'`,
		`script-src 'self' 'nonce-${nonce}' https://js.stripe.com`,
		`style-src 'self' 'unsafe-inline'`,
		`img-src 'self' data: https:`,
		`font-src 'self'`,
		`connect-src 'self' https://api.stripe.com${connectSrcExtra}`,
		`frame-src https://js.stripe.com https://hooks.stripe.com`,
		`object-src 'none'`,
		`base-uri 'self'`,
		`worker-src 'self'`,
		`form-action 'self'`,
		`frame-ancestors 'none'`,
		`upgrade-insecure-requests`
	].join('; ');

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

// Static asset handlers
app.use(`/build`, express.static(buildDir, { immutable: true, maxAge:"1y" }));
app.use(`/assets`, express.static(assetsDir, { immutable: true, maxAge:"1y" }));
// Add specific handler for fonts
app.use('/fonts', express.static(join(distDir, 'fonts'), { immutable: true, maxAge:"1y" }));
// Root static assets with custom cache control
app.use(express.static(distDir, {
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
}));

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
assertProdApiConfigured(process.env.NODE_ENV);

// Start the express server
app.listen(PORT, HOST, () => {
 console.log(`Server started: http://${HOST}:${PORT}/`);
});
