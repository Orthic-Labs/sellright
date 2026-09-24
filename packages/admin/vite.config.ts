import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { CSP_PROD, cspFor } from './src/lib/csp';

// The admin SPA talks to the configured SellRight service. In production, the
// reverse proxy fronts both API and asset paths on the admin host.
//
// Content Security Policy for the admin SPA lives in src/lib/csp.ts
// (DISPATCH FE-7) — dev/prod variants + the cspFor(mode) helper. nginx
// mirrors CSP_PROD verbatim — see src/lib/csp-headers.test.ts.
export default defineConfig(({ mode }) => {
  // Empty prefix pulls in the full merged env (.env files + the actual shell
  // environment), not just VITE_-prefixed vars — this file has no `node`
  // types configured (tsconfig.json), so reading `process.env` directly here
  // would fail typecheck; loadEnv sidesteps that.
  const env = loadEnv(mode, '.', '');
  const apiOrigin = env.SELLRIGHT_API_ORIGIN || 'http://127.0.0.1:3300';
  // Sub-path mount for the isolated demo (see src/main.tsx VITE_ADMIN_BASE_PATH
  // / deploy/demo/interactive-server.mjs) — outDir suffix keeps that build in
  // its own directory so it never overwrites a normal root-mounted build.
  const basePath = env.SELLRIGHT_ADMIN_BASE_PATH ? `${env.SELLRIGHT_ADMIN_BASE_PATH.replace(/\/+$/, '')}/` : '/';
  const outDirSuffix = env.SELLRIGHT_BUILD_SUFFIX ? `-${env.SELLRIGHT_BUILD_SUFFIX}` : '';
  return {
  base: basePath,
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
    outDir: `dist${outDirSuffix}`,
    // Product/media assets are served under /assets. Keep Vite's own immutable
    // JS/CSS chunks in a distinct namespace so a single static/admin origin can
    // never shadow merchant media or vice versa.
    assetsDir: 'admin-static',
  },
  // The port may be overridden by Vite's CLI for each installation.
  server: {
    port: 4300,
    host: '127.0.0.1',
    proxy: {
      '/v1': { target: apiOrigin, changeOrigin: true },
      '/assets': { target: apiOrigin, changeOrigin: true },
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
  };
});
