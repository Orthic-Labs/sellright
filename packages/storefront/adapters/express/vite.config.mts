import { nodeServerAdapter } from "@qwik.dev/router/adapters/node-server/vite";
import { extendConfig } from "@qwik.dev/router/vite";
import baseConfig from "../../vite.config.ts"; // Adjusted path

export default extendConfig(baseConfig, () => {
  return {
    build: {
      ssr: true,
      outDir: "server",
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
        ssg: {
          include: ["/*"],
          exclude: ["/account/*", "/search/*", "/blog", "/blog/*", "/affiliate", "/affiliate/*"],
        },
      }),
    ],
  };
});