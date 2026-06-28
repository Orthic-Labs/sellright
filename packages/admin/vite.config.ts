import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The admin SPA talks to the SellRight API. In dev, /v1 is proxied to the API
// (same-origin, no CORS) and /assets to DD's image server (parity with the
// storefront dev proxy). In prod, nginx fronts both on the admin host.
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
  },
  // Port 4300 (NOT 4200 — that's the Stunning Strangers prod store on the box).
  server: {
    port: 4300,
    host: '127.0.0.1',
    proxy: {
      '/v1': { target: 'http://127.0.0.1:3300', changeOrigin: true },
      '/assets': { target: 'https://www.damneddesigns.com', changeOrigin: true, secure: true },
    },
  },
  preview: { port: 4300, host: '0.0.0.0' },
}));
