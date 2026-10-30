import { qwikRouter } from '@qwik.dev/router/vite';
import { qwikVite } from '@qwik.dev/core/optimizer';
import { defineConfig, loadEnv } from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';
import { imagetools } from 'vite-imagetools';
import viteCompression from 'vite-plugin-compression';
import { brandSlotsPlugin } from './src/components/slots/vite-plugin';
import { brandDataPlugin } from './src/platform/brand-data/vite-plugin';
import { commerceFlowFrom, routesDirFor } from './src/platform/license/flow';
import { preloadGraphPlugin } from './src/platform/preload-graph';

export default defineConfig((config) => {
  const isDev = config.mode === 'development';
  const env = loadEnv(config.mode, process.cwd(), 'VITE_');
  const api = process.env.VITE_SELLRIGHT_API_URL || env.VITE_SELLRIGHT_API_URL || 'http://127.0.0.1:3300';
  const publicDomain = process.env.VITE_PUBLIC_DOMAIN || env.VITE_PUBLIC_DOMAIN || 'localhost:4100';
  // Escape hatch to build into an alternate output directory (e.g. the
  // isolated demo's dist-demo/server-demo, built with SSG disabled — see
  // adapters/express/vite.config.mts). Unset for every normal deployment:
  // outDir stays 'dist'/'server'. NOTE: this package is always root-mounted
  // (base stays '/') — Vite's `base` only reaches asset URLs and the Qwik
  // router's own matching, not the many hardcoded absolute hrefs/navigate()
  // calls throughout src/ (ProductCard, header, checkout, etc.), so a real
  // sub-path mount would need those fixed too. The demo instead mounts this
  // app at the domain root and relocates the admin SPA to /admin, which
  // React Router's `basename` handles cleanly with no such landmines.
  // The commerce flow picks the route tree (src/platform/license/flow.ts): the license flow builds src/platform/license/routes.
  const commerceFlow = commerceFlowFrom(process.env.VITE_SR_COMMERCE_FLOW || env.VITE_SR_COMMERCE_FLOW);
  const outDirSuffix = process.env.SELLRIGHT_BUILD_SUFFIX ? `-${process.env.SELLRIGHT_BUILD_SUFFIX}` : '';

  return {
    logLevel: 'info', // Show build progress and info logs
    base: '/', // Ensure root-relative URLs
    // Vite 8 / Rolldown (ported from the Rotten Hand and Damned storefronts): the
    // SSR build must bundle tailwindcss so the `@import 'tailwindcss'` in
    // global.css (?inline) resolves instead of being externalised.
    ssr: {
      noExternal: ['tailwindcss'],
    },

    build: {
      sourcemap: false, // Explicitly disable for production to save memory
      minify: !isDev ? 'terser' : false, // Enhanced: Switch to Terser for better compression
      outDir: `dist${outDirSuffix}`, // Ensure output goes to dist/ (or dist-<suffix>/ for an alternate build)
      chunkSizeWarningLimit: 500, // Intentional lazy chunks exceed default 150KB

      // 🚀 ENHANCED TERSER CONFIGURATION - 15-25% better compression than esbuild
      terserOptions: {
        compress: {
          drop_console: false, // Keep console.warn and console.error in production
          drop_debugger: true, // Remove debugger statements
          pure_funcs: ['console.log', 'console.info', 'console.debug', 'console.trace'], // Remove only these specific functions
          passes: 2, // Multiple compression passes for maximum optimization
          dead_code: true, // Remove unreachable code
          conditionals: true, // Optimize if-s and conditional expressions
          evaluate: true, // Evaluate constant expressions
          booleans: true, // Optimize boolean expressions
          loops: true, // Optimize loops
          unused: true, // Remove unused variables and functions
          hoist_funs: true, // Hoist function declarations
          hoist_vars: false, // Don't hoist var declarations (can break scope)
          if_return: true, // Optimize if/return and if/continue
          join_vars: true, // Join consecutive var statements
          reduce_vars: true, // Improve optimization of variables assigned with and used as constant values
          collapse_vars: true, // Collapse single-use variables
          pure_getters: false, // Qwik reactive getters can evaluate nested QRLs & change lexical capture state.
          warnings: false, // Don't show warnings in production
        },
        mangle: {
          safari10: true, // Safari 10 compatibility for proper variable mangling
          properties: false, // Don't mangle property names (can break functionality)
        },
        format: {
          comments: false, // Remove all comments for smaller bundle size
          ascii_only: true, // Ensure ASCII-only output for better compatibility
        },
        // Keep function names for better debugging in production (optional)
        keep_fnames: false, // Set to true if you need function names preserved
        keep_classnames: false, // Set to true if you need class names preserved
      },

      // manualChunks is unsupported (Qwik 2.0.0-beta.40+ requires Vite 8 / Rolldown and
      // manages its own chunking; custom chunking breaks manifest generation → QRL
      // failures at SSR). `rollupOptions` is the deprecated Vite 7 name; Rolldown reads
      // `rolldownOptions`. `experimentalMinChunkSize` (merge chunks <4KB) is dropped:
      // the brand storefronts run without it on Rolldown.
      rolldownOptions: {
        output: {
          // Keep bundled images separate from SellRight's /assets product route.
          assetFileNames: (assetInfo) => {
            if (/\.(css)$/.test(assetInfo.name ?? '')) {
              return 'build/[name]-[hash][extname]';
            }
            if (/\.(png|jpe?g|gif|svg|webp|avif)$/.test(assetInfo.name ?? '')) {
              return '[name]-[hash][extname]';
            }
            return 'build/[name]-[hash][extname]';
          },
        },
      },
    },
    plugins: [
      // A17: validates src/brand-slots (or SELLRIGHT_BRAND_SLOTS_DIR) and serves virtual:sellright-brand-slots.
      brandSlotsPlugin(),
      // Brand views: validates src/brand/head.json and routes.json and serves virtual:sellright-brand-data (a missing file = defaults).
      brandDataPlugin(),
      qwikRouter({
        routesDir: routesDirFor(commerceFlow),
        // Exclude dynamic sitemap routes from static generation
        exclude: ['/sitemap.xml', '/sitemap-*.xml'],
      }),
      qwikVite({
        devTools: {
          clickToSource: false,
        },
        srcDir: 'src',
        debug: false,
        entryStrategy: {
          type: 'smart',
        },
      }),
      // P7/V30: the rc.3 preloader has no probability cut-off and fetched ~410 bundles per page after load by following
      // lazy-QRL edges of the bundle graph. Keep static imports and route/symbol edges only, plus (L10) one flat edge from
      // each checkout-only bundle to its client-rendered checkout closure (src/platform/preload-graph.ts).
      preloadGraphPlugin(),
      tsconfigPaths(),
      imagetools({
        // Merge defaults INTO the caller's params — never replace them.
        // Replacing drops width=N and quality=N from import URLs, which
        // causes every ?width=480/768/1024 variant to resolve to the
        // same single file (native source width) and forces every image
        // to whatever quality is hardcoded below regardless of caller intent.
        defaultDirectives: (url) => {
          const params = url.searchParams;
          if (params.has('format')) {
            const format = params.get('format');
            if (format === 'avif') {
              if (!params.has('quality')) params.set('quality', '65');
              if (!params.has('effort')) params.set('effort', '6');
              if (!params.has('chromaSubsampling')) params.set('chromaSubsampling', '420');
              if (!params.has('lossless')) params.set('lossless', 'false');
            }
            if (format === 'webp') {
              if (!params.has('quality')) params.set('quality', '70');
              if (!params.has('effort')) params.set('effort', '6');
            }
          }
          return params;
        }
      }),
      // Custom plugin to track image processing progress
      {
        name: 'image-progress',
        load(id) {
          if (id.includes('?format=') && (id.includes('.png') || id.includes('.jpg') || id.includes('.jpeg'))) {
            console.log(`🖼️  Processing image: ${id.split('/').pop()}`);
          }
        }
      },
      // Text compression - addresses GTmetrix "Enable text compression" (577KB savings)
      ...(!isDev ? [
        // Gzip compression (universally supported, built into Nginx)
        viteCompression({
          algorithm: 'gzip',
          ext: '.gz',
          threshold: 1024, // Only compress files > 1KB
          deleteOriginFile: false, // Keep original files
          filter: /\.(js|mjs|json|css|html|svg)$/i, // Compress text-based files
          compressionOptions: {
            level: 9, // Maximum compression for build-time (since it's pre-computed)
          },
        }),
        // 🚀 NEW: Brotli compression (better compression than gzip, supported by modern browsers)
        viteCompression({
          algorithm: 'brotliCompress',
          ext: '.br',
          threshold: 1024, // Only compress files > 1KB
          deleteOriginFile: false, // Keep original files
          filter: /\.(js|mjs|json|css|html|svg)$/i, // Compress text-based files
          compressionOptions: {
            level: 11, // Maximum Brotli compression (0-11, 11 is best compression)
            chunkSize: 32 * 1024, // 32KB chunks for optimal compression
          },
        }),
      ] : []),
    ],
    preview: {
      host: '0.0.0.0',
      port: 4100,
      allowedHosts: [publicDomain, `www.${publicDomain}`, 'localhost'],
      headers: {
        // Caching
        'Cache-Control': 'public, max-age=600',
        // Security Headers
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'X-XSS-Protection': '0',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
        'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
        'Content-Security-Policy': [
          "default-src 'self'",
          "script-src 'self' 'unsafe-inline' https://widget.sezzle.com", // Qwik needs unsafe-inline, allow Sezzle widget
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: https:",
          "font-src 'self' data:",
          `connect-src 'self' https://${publicDomain} https://widget.sezzle.com`,
          "frame-ancestors 'none'",
        ].join('; '),
      },
    },
    server: config.command === 'serve'
      ? {
          watch: {
            ignored: ['node_modules/**', '.git/**'],
          },
          fs: {
            allow: ['..'], // Allow serving files from one level up
          },
          proxy: {
            // Dynamic API -> SellRight backend (browser uses same-origin /v1, no CORS)
            '/v1': { target: api, changeOrigin: true },
            '/assets': { target: api, changeOrigin: true },
          },
        }
      : undefined,
  };
});
