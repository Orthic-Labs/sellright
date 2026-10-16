# syntax=docker/dockerfile:1
# Composed engine image (plan 2.3). Consumes the PACKED artifacts produced by
# scripts/build-sdk-artifacts.sh (artifacts/sdk/*.tgz), never the source tree, so the image
# runs exactly what the packed-artifact gate (pnpm test:sdk-packed) tested.
#
# Build (from repo root, after scripts/build-sdk-artifacts.sh):
#   docker build -f deploy/sdk/Dockerfile -t sellright-composed:<tag> .
FROM node:24.20.0-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV PORT=3300
WORKDIR /app

COPY artifacts/sdk/sellright-api-*.tgz artifacts/sdk/sellright-sample-plugin-*.tgz ./artifacts/
COPY deploy/sdk/composed/package.json deploy/sdk/composed/migrate.mjs deploy/sdk/composed/server.mjs ./
# Exact-version peer pin: the plugin requires @sellright/api 0.1.0 (see packages/sample-plugin/package.json).
RUN npm install --omit=dev --no-audit --no-fund \
 && npm cache clean --force

RUN mkdir -p /app/var && chown -R node:node /app
USER node
EXPOSE 3300

HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3300)+'/v1/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

# Migrate (owner credential via MIGRATE_DATABASE_URL, engine track then plugin track), then serve.
CMD ["sh", "-c", "node migrate.mjs && exec node server.mjs"]
