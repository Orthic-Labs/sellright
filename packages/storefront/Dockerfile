# syntax=docker/dockerfile:1
#
# WS-C (runtime storefront configuration): one generic image, any store. This
# build does NOT bake a store's identity/theme/API URL in — the running
# container resolves them at request time (routes/layout.tsx
# useStoreIdentityLoader calls GET /v1/shop/identity per the incoming
# request's Host; SELLRIGHT_API_URL below points it at an API instance
# without a rebuild). VITE_* build args remain only as an offline/dev
# fallback (see README.md "Configuring a store").
#
# `build:runtime` (package.json) sets SELLRIGHT_DISABLE_SSG=1 — required: a
# statically prerendered page would freeze whichever store resolved at build
# time (there is no real request Host yet) and serve it to every visitor of
# every host this image is later pointed at, see adapters/express/vite.config.mts.

FROM node:24.20.0-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN npm install --global pnpm@11.25.0

WORKDIR /workspace

# Same cacheable-manifests-first pattern as packages/api/Dockerfile.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/storefront/package.json packages/storefront/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/storefront-client/package.json packages/storefront-client/package.json
RUN pnpm install --frozen-lockfile

COPY packages/storefront packages/storefront
COPY packages/shared packages/shared
COPY packages/storefront-client packages/storefront-client

# storefront-client must build (incl. copying its hand-authored
# generated/schema.d.ts into dist/ — tsc doesn't emit non-.ts inputs, see
# that package's package.json build.copy-generated script) before the
# storefront, which imports it as a workspace dependency.
RUN pnpm --filter @sellright/shared build \
 && pnpm --filter @sellright/storefront-client build \
 && pnpm --filter @sellright/storefront run build:runtime

# Portable deployment directory (pnpm 11 requires --legacy without
# inject-workspace-packages — see packages/api/Dockerfile for the same note).
RUN pnpm --filter @sellright/storefront deploy --legacy --prod /runtime

FROM node:24.20.0-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV PORT=4100
ENV HOST=0.0.0.0
WORKDIR /app

# `pnpm deploy` supplies the package manifest + production node_modules.
# dist/server are gitignored build output, so copy them explicitly.
COPY --from=build --chown=node:node /runtime/ ./
COPY --from=build --chown=node:node /workspace/packages/storefront/dist ./dist
COPY --from=build --chown=node:node /workspace/packages/storefront/server ./server

USER node
EXPOSE 4100

HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4100)+'/').then(r=>{if(!r.ok&&r.status!==404)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "server/entry.express.js"]
