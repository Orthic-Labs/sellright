import { qwikRouter } from '@qwik.dev/router/vite';
import { qwikVite } from '@qwik.dev/core/optimizer';
import { defineConfig } from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';
import { imagetools } from 'vite-imagetools';
import viteCompression from 'vite-plugin-compression';

export default defineConfig((config) => {
  const isDev = config.mode === 'development';

  return {
    logLevel: 'info', // Show build progress and info logs
    base: '/', // Ensure root-relative URLs

    build: {
      sourcemap: false, // Explicitly disable for production to save memory
      minify: !isDev ? 'terser' : false, // Enhanced: Switch to Terser for better compression
      outDir: 'dist', // Ensure output goes to dist/
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
          pure_getters: true, // Assume getters have no side effects
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

      // manualChunks removed — Qwik beta.30 manages its own chunking.
      // Custom manualChunks breaks manifest generation → "Qwik core bundle not found" → QRL failures at SSR.
      // experimentalMinChunkSize merges tiny chunks (<4KB) to reduce HTTP request count.
      rollupOptions: {
        output: {
          experimentalMinChunkSize: 4000,
          // Keep images at root level (not /assets/) because nginx proxies /assets → port 3100 (Vendure admin).
          // Qwik's default assets/ dir conflicts with Vendure's product asset route.
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
      qwikRouter({
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
      allowedHosts: ['damneddesigns.com', 'www.damneddesigns.com', 'localhost'],
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
          "connect-src 'self' https://damneddesigns.com https://widget.sezzle.com",
          "frame-ancestors 'none'",
        ].join('; '),
      },
    },
    server: isDev
      ? {
          watch: {
            ignored: ['node_modules/**', '.git/**'],
          },
          fs: {
            allow: ['..'], // Allow serving files from one level up
          },
        }
      : undefined,
  };
});