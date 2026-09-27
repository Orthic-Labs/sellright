# syntax=docker/dockerfile:1
#
# Builds the generic Qwik storefront image. TODO(WS-C): storefront settings
# (identity, theme, URLs, payment public keys) are still baked in at build
# time via VITE_* args below. WS-C moves this to a runtime per-store fetch so
# one image serves every store; until then this image is built per-deployment
# with SELLRIGHT_API_URL pointed at the API this compose stack runs.

FROM node:24.20.0-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN npm install --global pnpm@11.25.0

WORKDIR /workspace

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/storefront/package.json packages/storefront/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN pnpm install --frozen-lockfile

COPY packages/storefront packages/storefront
COPY packages/shared packages/shared

ARG SELLRIGHT_API_URL=http://172.22.0.1:3300
ENV VITE_SELLRIGHT_API_URL=${SELLRIGHT_API_URL}
ENV VITE_SELLRIGHT_PROD_URL=${SELLRIGHT_API_URL}

RUN pnpm --filter @sellright/shared build \
 && pnpm --filter @sellright/storefront build

# NOTE: express/@qwik.dev/router/dotenv are devDependencies in this package
# (the SSR server entry only runs today via the full monorepo install), so a
# --prod deploy omits them and the runtime container fails to boot. Deploy
# without --prod until that's reclassified upstream; this bloats the image
# but the runtime actually starts.
RUN pnpm --filter @sellright/storefront deploy --legacy /runtime

FROM node:24.20.0-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV PORT=4100
ENV HOST=0.0.0.0
WORKDIR /app

COPY --from=build --chown=node:node /runtime/ ./
COPY --from=build --chown=node:node /workspace/packages/storefront/dist ./dist
COPY --from=build --chown=node:node /workspace/packages/storefront/server ./server

USER node
EXPOSE 4100

HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4100)+'/').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "server/entry.express.js"]
