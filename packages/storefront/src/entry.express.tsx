import {
 createQwikRouter,
 type PlatformNode,
} from"@qwik.dev/router/middleware/node";
import"dotenv/config";
import express from"express";
import { randomBytes } from"node:crypto";
import { join } from"node:path";
import { fileURLToPath } from"node:url";
import render from"./entry.ssr";

declare global {
 interface QwikRouterPlatform extends PlatformNode {}
}

// Directories where the static assets are located
const distDir = join(fileURLToPath(import.meta.url),"..","..","dist");
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
const apiOrigin = (process.env.VITE_SELLRIGHT_API_URL || process.env.VENDURE_API_URL || '')
	.replace(/\/(shop-api)?\/?$/, '')
	.trim();
const connectSrcExtra = apiOrigin ? ` ${apiOrigin}` : '';

// Set security headers
app.use((req, res, next) => {
	// Per-request CSP nonce. Threaded to Qwik's SSR render via
	// res.locals.nonce -> entry.ssr.tsx -> <Root nonce> -> <Head nonce> ->
	// the inline <script nonce=...> tags Qwik/this app emit. Must match the
	// nonce declared in script-src below, or Qwik's inline bootstrap script
	// (and the iOS service-worker registration script in head.tsx) will be
	// blocked by the browser.
	const nonce = randomBytes(16).toString('base64');
	res.locals.nonce = nonce;

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

// Static asset handlers
app.use(`/build`, express.static(buildDir, { immutable: true, maxAge:"1y" }));
app.use(`/assets`, express.static(assetsDir, { immutable: true, maxAge:"1y" }));
// Add specific handler for fonts
app.use('/fonts', express.static(join(distDir, 'fonts'), { immutable: true, maxAge:"1y" }));
// Root static assets with custom cache control
app.use(express.static(distDir, {
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

// Start the express server
app.listen(PORT, HOST, () => {
 console.log(`Server started: http://${HOST}:${PORT}/`);
});