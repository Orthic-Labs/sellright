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
          exclude: ["/account/*", "/search/*", "/blog", "/blog/*", "/affiliate", "/affiliate/*"],
        },
      }),
    ],
  };
});