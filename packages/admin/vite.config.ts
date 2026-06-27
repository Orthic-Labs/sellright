import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The admin SPA talks to the SellRight API. In dev, /v1 is proxied to the API
// (same-origin, no CORS) and /assets to DD's image server (parity with the
// storefront dev proxy). In prod, nginx fronts both on the admin host.
export default defineConfig({
  plugins: [react()],
  build: {
    target: 'es2022',
  },
  // Port 4300 (NOT 4200 — that's the Stunning Strangers prod store on the box).
  server: {
    port: 4300,
    host: '127.0.0.1',
    proxy: {
      '/v1': { target: 'http://127.0.0.1:3301', changeOrigin: true },
      '/assets': { target: 'https://www.damneddesigns.com', changeOrigin: true, secure: true },
    },
  },
  preview: { port: 4300, host: '0.0.0.0' },
});
