/**
 * Content Security Policy for the admin SPA (DISPATCH FE-7).
 *
 * The admin is a built React SPA — no inline scripts, no eval, no remote
 * fonts. Vite dev injects an HMR client + a small inline theme-bootstrap
 * script in index.html, so dev relaxes `script-src` with 'unsafe-inline'
 * to avoid dev-only console errors. The PROD bundle ships neither.
 *
 * `nginx-admin.conf` mirrors CSP_PROD verbatim — see csp-headers.test.ts.
 */

export const CSP_PROD = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'", // React component libs commonly inject inline styles
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  "connect-src 'self' https:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
].join('; ');

export const CSP_DEV = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'", // Vite HMR client + index.html inline bootstrap
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  "connect-src 'self' https: ws: wss:", // Vite HMR uses ws://
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
].join('; ');

export const cspFor = (mode: string): string =>
  mode === 'development' ? CSP_DEV : CSP_PROD;