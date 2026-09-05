import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { CSP_PROD, cspFor } from './src/lib/csp';

// The admin SPA talks to the SellRight API. In dev, /v1 is proxied to the API
// (same-origin, no CORS) and /assets to DD's image server (parity with the
// storefront dev proxy). In prod, nginx fronts both on the admin host.
//
// Content Security Policy for the admin SPA lives in src/lib/csp.ts
// (DISPATCH FE-7) — dev/prod variants + the cspFor(mode) helper. nginx
// mirrors CSP_PROD verbatim — see src/lib/csp-headers.test.ts.
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  define: mode === 'qa' ? {
    'import.meta.env.VITE_QA_MOCK': JSON.stringify('1'),
  } : undefined,
  // Vite's default dep optimizer target asks esbuild 0.28 to downlevel
  // destructuring in modern ESM deps. The admin app targets modern Chromium.
  optimizeDeps: {
    esbuildOptions: {
      target: 'es2022',
    },
  },
  build: {
    target: 'es2022',
    // Product/media assets are served under /assets. Keep Vite's own immutable
    // JS/CSS chunks in a distinct namespace so a single static/admin origin can
    // never shadow storefront media or vice versa.
    assetsDir: 'admin-static',
  },
  // Port 4300 (NOT 4200 — that's the Stunning Strangers prod store on the box).
  server: {
    port: 4300,
    host: '127.0.0.1',
    proxy: {
      '/v1': { target: 'http://127.0.0.1:3300', changeOrigin: true },
      '/assets': { target: 'https://www.damneddesigns.com', changeOrigin: true, secure: true },
    },
    // Emit CSP in dev so violations surface in the browser console immediately,
    // not only after a prod deploy. See CSP_DEV for why 'unsafe-inline'.
    headers: {
      'Content-Security-Policy': cspFor(mode),
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    },
  },
  // `vite preview` (pnpm preview, used by the QA harness against the built
  // bundle) must serve the prod CSP, not the dev one.
  preview: {
    port: 4300,
    host: '0.0.0.0',
    headers: {
      'Content-Security-Policy': CSP_PROD,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    },
  },
}));
