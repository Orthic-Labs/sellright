import { nodeServerAdapter } from "@qwik.dev/router/adapters/node-server/vite";
import { extendConfig } from "@qwik.dev/router/vite";
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