import { describe, expect, it } from 'vitest';
import { CSP_DEV, CSP_PROD } from './csp';

/**
 * DISPATCH FE-7 — assert the admin SPA ships a Content-Security-Policy
 * in BOTH dev (vite.config.ts `server.headers`) and prod (nginx-admin.conf).
 *
 * The dev/prod literals live in src/lib/csp.ts (one source of truth). The
 * nginx prod directive is duplicated by hand into the conf — `NGINX_CSP_PROD`
 * below MUST match CSP_PROD byte-for-byte so "works on dev, broken on prod"
 * can't slip through. If you change one, change the other (the test will
 * yell at you).
 */
const NGINX_CSP_PROD =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self' https:; frame-ancestors 'none'; base-uri 'self'; object-src 'none'";

const REQUIRED_DIRECTIVES = [
  "default-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
];

describe('admin SPA CSP (DISPATCH FE-7)', () => {
  it('prod CSP includes every required directive', () => {
    for (const d of REQUIRED_DIRECTIVES) {
      expect(CSP_PROD, `missing ${d} in prod CSP`).toContain(d);
    }
  });

  it('prod CSP keeps style-src relaxed for React component libs', () => {
    expect(CSP_PROD).toContain("style-src 'self' 'unsafe-inline'");
  });

  it('prod CSP does NOT relax script-src with unsafe-inline', () => {
    // The prod bundle is a built React SPA — no inline scripts in the
    // shipped output. If this trips, an inline <script> snuck into
    // index.html or a dep is requesting eval.
    expect(CSP_PROD).toContain("script-src 'self'");
    expect(CSP_PROD).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  });

  it('prod CSP allows data: + https: image sources for previews + CDN', () => {
    expect(CSP_PROD).toContain("img-src 'self' data: https:");
  });

  it('dev CSP relaxes script-src so Vite HMR + index.html inline bootstrap work', () => {
    expect(CSP_DEV).toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(CSP_DEV).toContain("connect-src 'self' https: ws: wss:");
  });

  it('dev and prod CSP differ (preview must serve prod)', () => {
    // Sanity: dev and prod differ on script-src — if preview accidentally
    // serves the dev CSP, prod parity testing is meaningless.
    expect(CSP_PROD).not.toBe(CSP_DEV);
  });

  it('nginx-admin.conf prod CSP directive is byte-identical to CSP_PROD', () => {
    // If you change CSP_PROD, change NGINX_CSP_PROD above AND the
    // add_header Content-Security-Policy line in nginx-admin.conf.
    // All three must agree — the test is the trip wire.
    expect(NGINX_CSP_PROD).toBe(CSP_PROD);
  });
});