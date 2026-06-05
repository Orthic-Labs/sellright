import {
 createQwikRouter,
 type PlatformNode,
} from"@qwik.dev/router/middleware/node";
import"dotenv/config";
import express from"express";
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

// Set security headers
app.use((req, res, next) => {
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

	// Content Security Policy - More permissive for functionality
	const cspDirectives = [
		`default-src 'self' 'unsafe-inline' data: https: blob:`,
		`img-src 'self' data: https: blob:`,
		`font-src 'self' data: https:`,
		`style-src 'self' 'unsafe-inline' https:`,
		`script-src 'self' 'unsafe-inline' https:`,
		`connect-src 'self' https: wss: ws:`,
		`frame-src 'self' https:`,
		`object-src 'none'`,
		`base-uri 'self'`,
		`worker-src 'self' blob: https:`,
		`form-action 'self'`,
		`frame-ancestors 'self'`,
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