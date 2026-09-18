/**
 * Content Security Policy for the admin SPA (DISPATCH FE-7).
 *
 * The admin is a built React SPA — no inline scripts, no eval, no remote
 * fonts. Vite dev injects an HMR client + a small inline theme-bootstrap
 * script in index.html, so dev relaxes `script-src` with 'unsafe-inline'
 * to avoid dev-only console errors. The PROD bundle ships neither.
 *
 * `nginx.conf.template` mirrors CSP_PROD verbatim — see csp-headers.test.ts.
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

/**
 * Modes served by the Vite DEV server (`vite`, `vite --mode qa`) get CSP_DEV:
 * the dev server always injects @vitejs/plugin-react's inline refresh preamble
 * and the HMR client over ws://, both of which CSP_PROD forbids — serving the
 * prod CSP under `--mode qa` blanked the page (SR-13). Unknown modes stay on
 * CSP_PROD (fail-closed). The strict CSP is exercised against the built bundle
 * via `vite preview` + nginx instead.
 */
const DEV_SERVER_MODES = new Set(['development', 'qa']);

export const cspFor = (mode: string): string =>
  DEV_SERVER_MODES.has(mode) ? CSP_DEV : CSP_PROD;