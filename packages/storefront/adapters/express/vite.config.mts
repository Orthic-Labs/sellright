import { nodeServerAdapter } from "@qwik.dev/router/adapters/node-server/vite";
import { extendConfig } from "@qwik.dev/router/vite";
import { mkdirSync, existsSync, copyFileSync } from "node:fs";
import baseConfig from "../../vite.config.ts"; // Adjusted path

// SSG (build-time prerendering) assumes a single, anonymous, always-available
// catalog to fetch while building. The isolated demo has neither: every /v1/*
// read requires an authenticated per-visitor cookie that only exists once a
// browser has one (see deploy/demo/interactive-server.mjs), and prerendered
// HTML would otherwise get served to every visitor regardless of whose store
// it is. SELLRIGHT_DISABLE_SSG turns prerendering off so every route is
// rendered live per-request instead — required for that build, a no-op for
// every other one (SSG stays on by default).
//
// WS-C (runtime storefront configuration): the SAME reasoning now applies to
// the generic one-image build (packages/storefront/Dockerfile,
// `pnpm run build:runtime`) — every route's root layout resolves store
// identity/theme per request Host (see routes/layout.tsx
// useStoreIdentityLoader), so a page baked at build time would freeze
// whichever store's branding happened to resolve then (or none) and serve it
// to every visitor of every host that image is later pointed at. Any build
// meant to serve more than one store from the same image MUST set
// SELLRIGHT_DISABLE_SSG=1.
const ssgDisabled = process.env.SELLRIGHT_DISABLE_SSG === '1';
const outDirSuffix = process.env.SELLRIGHT_BUILD_SUFFIX ? `-${process.env.SELLRIGHT_BUILD_SUFFIX}` : '';

// nodeServerAdapter always embeds the client manifest from the literal
// 'dist/q-manifest.json' — it has no idea this package's client build can
// land in 'dist-<suffix>/' instead (see vite.config.ts's own outDirSuffix).
// Without the real manifest, every QRL that needs dynamic chunk-path
// resolution at SSR time throws Code(Q14) ("QRLs can not be dynamically
// resolved, because it does not have a chunk path") — e.g. any page that
// touches the dynamically-imported providers/shop/products/products.ts
// (the shop page, PDP, cart). Copying the just-built suffixed manifest onto
// the path the adapter actually reads fixes it with zero effect on a normal
// (unsuffixed) build, where source and destination are the same file.
if (outDirSuffix) {
  mkdirSync('dist', { recursive: true });
  for (const ext of ['q-manifest.json', 'q-manifest.json.gz', 'q-manifest.json.br']) {
    const src = `dist${outDirSuffix}/${ext}`;
    if (existsSync(src)) copyFileSync(src, `dist/${ext}`);
  }
}

export default extendConfig(baseConfig, () => {
  return {
    build: {
      ssr: true,
      outDir: `server${outDirSuffix}`,
      rollupOptions: {
        input: ["src/entry.express.tsx", "@qwik-router-config"],
        output: {
          entryFileNames: "entry.express.js",
          chunkFileNames: "[name]-[hash].js",
          assetFileNames: "[name]-[hash][extname]",
        },
      },
    },
    plugins: [
      nodeServerAdapter({
        name: "express",
        ssg: ssgDisabled ? { include: [] } : {
          include: ["/*"],
          // /checkout is excluded on its own merits, independent of WS-C: it
          // reflects live cart contents, live stock, and live payment-method
          // configuration — a statically prerendered checkout page would be
          // stale the moment it's built, regardless of which store's identity
          // it carries. (Observed as the trigger for a build-time SSG crash —
          // see routes/checkout — but it should never have been a static
          // candidate either way.)
          exclude: ["/account/*", "/search/*", "/blog", "/blog/*", "/affiliate", "/affiliate/*", "/checkout", "/checkout/*"],
        },
      }),
    ],
  };
});