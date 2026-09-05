# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN npm install --global pnpm@11.24.0

WORKDIR /workspace

# Copy dependency manifests first so dependency installation remains cacheable
# while application source changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/api/package.json packages/api/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN pnpm install --frozen-lockfile

COPY packages/api packages/api
COPY packages/shared packages/shared

RUN pnpm --filter @sellright/shared build \
 && pnpm --filter @sellright/api build

# Build an isolated production dependency tree. `--legacy` is intentional: this
# workspace does not use inject-workspace-packages, and pnpm 11 requires either
# that setting or legacy deploy mode for a portable deployment directory.
RUN pnpm --filter @sellright/api deploy --legacy --prod /runtime

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV PORT=3300
WORKDIR /app

# `pnpm deploy` supplies the package manifest + production node_modules. dist/
# is gitignored and therefore may be omitted by deploy, so copy the compiler
# output and migration journal explicitly rather than relying on package-file
# inclusion heuristics.
COPY --from=build --chown=node:node /runtime/ ./
COPY --from=build --chown=node:node /workspace/packages/api/dist ./dist
COPY --from=build --chown=node:node /workspace/packages/api/drizzle ./drizzle

RUN mkdir -p /app/var/assets /app/var/downloads \
 && chown -R node:node /app/var

USER node
EXPOSE 3300

HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3300)+'/v1/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

# Single-instance/default deployment: migrate to the exact image schema, run
# create-only first-store bootstrap when BOOTSTRAP_STORE_SLUG is configured,
# then exec the compiled server so signals reach Node. At multi-instance scale,
# run migrate/bootstrap once as a release job and override this CMD with
# `node dist/index.js` for application replicas.
CMD ["sh", "-c", "node dist/scripts/migrate.js && node dist/scripts/bootstrap.js && exec node dist/index.js"]
