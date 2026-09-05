# syntax=docker/dockerfile:1

FROM node:24.20.0-bookworm-slim AS build
RUN npm install --global pnpm@11.25.0
WORKDIR /src

# The admin is a standalone pnpm workspace. Its workspace file contains the
# supply-chain/build policy and overrides captured by pnpm-lock.yaml, so frozen
# installs must see all three files.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

FROM nginx:1.27-alpine AS runtime

ENV API_UPSTREAM=http://api:3300

COPY --from=build /src/dist /usr/share/nginx/html
COPY nginx.conf.template /etc/nginx/templates/default.conf.template

# nginx's master process can bind 8080 without root; make all runtime-writable
# paths owned by the unprivileged nginx account before dropping privileges.
RUN chown -R nginx:nginx /usr/share/nginx/html /var/cache/nginx /var/run /etc/nginx/conf.d

USER nginx
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/ >/dev/null || exit 1
