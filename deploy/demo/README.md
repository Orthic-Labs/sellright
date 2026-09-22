# Isolated Demo

## Interactive Visitor Stores (September 2026)

The default runner now serves a connected storefront and the real SellRight
admin. Each browser receives its own disposable tenant, catalog, variants,
inventory, collections, customers, promotions and sample orders. The original
single-store read-only implementation remains available with `run.mjs --read-only`
for rollback; its legacy contract and setup instructions are retained below.

Start at `/shop`. Browse collections and product detail, choose a variant,
edit the cart, select delivery, apply `WELCOME10` and place a demo order. Checkout
uses the real server-pricing, stock-reservation and checkout transaction. The
demo process alone authorizes a deterministic synthetic manual settlement through
`applyPaymentResult`; it does not enable shopper manual payments or change the
generic provider registry. The confirmation links to that actual admin order.

The admin can edit product details/prices/availability, create/archive products
and variants, adjust stock, manage discounts, fulfill/cancel/refund orders and
inspect the synthetic customers and reports. New variant SKUs must start with
`DEMO-` and use uppercase letters/hyphens. Media uploads, option editing, staff,
settings, gateway configuration, exports and external integrations are disabled.
This is a product evaluation environment, not gateway acceptance evidence.

### Isolation and Limits

- Only the dedicated `sellright_demo` database is accepted. The runtime role
  must remain non-superuser/non-BYPASSRLS. Never use a merchant/development clone.
- An HttpOnly random visitor token resolves to a server-owned tenant and expiry.
  Client tenant headers, authorization headers and admin cookies cannot select
  another visitor's store. CSRF plus same-origin checks protect all writes.
- Every new tenant and generated admin account expires after one hour. At most
  40 retained visitor tenants are allowed. Per-visitor caps bound orders, carts,
  products, variants, discounts and audit activity; the edge also has a request cap.
- Reset removes only the authenticated visitor's generated store, sessions,
  account and tenant rows, transactionally in foreign-key dependency order.
  Cleanup runs every minute and removes expired visitors. The baseline `demo`
  tenant cannot be reset. Cleanup failure fails readiness closed.
- All customer identity/address data is server-generated synthetic data. The
  checkout never accepts card details or user contact information.
- Stripe/NMI/Sezzle credentials and gateway accounts are rejected; no scheduler
  starts; SMTP is disabled and outbound `fetch` is denied. Core commerce may
  enqueue synthetic outbox records, but no dispatcher runs and reset removes them.
- No database migration or extra runtime dependency is required. The provisioner
  uses the existing runtime DML grants, never the owner connection.

### Verification and Rollout

Run `node --test deploy/demo/*.test.mjs` and syntax-check the interactive JS files.
Before rollout, use an isolated copy of the synthetic baseline, non-owner role,
and a different loopback port. Verify two independent browsers, checkout to admin
refund, product/stock/discount mutations, forged tenant headers, blocked gateway
and settings routes, CSRF rejection, reset and expiration cleanup, desktop/mobile.

The public entry point stays `https://demo.sellright.cc/shop`; nginx/TLS do not
change. Restart only `sellright-demo` after publication. Readiness now reports
`synthetic:true`, `interactiveAdmin:true`, `isolatedVisitors:true`.
For rollback, stop the demo, back up its private database, remove only marked
visitor tenants using the guarded `removeVisitor` routine, and start the legacy
runner with `--read-only`. Do not restore a merchant database or change RLS.

## Legacy Read-Only Deployment Reference

This is a real SellRight deployment with a small reference shop, the existing admin and synthetic catalog/order rows. It is not merchant acceptance evidence. No real payments, shipments or customer information belong here.

The reference deployment uses a separate PostgreSQL 17 cluster, private Unix socket and non-owner runtime role. Nothing connects to an existing merchant or development-clone database. The service defaults to localhost:4310. The only alternate binding is the designated private nginx Docker bridge, `172.22.0.1`; public and wildcard bindings are rejected.

## Safety Contract

- Only the database named `sellright_demo` and a single marked `demo` store are accepted.
- One dedicated visitor account has `read_only` membership. Its password is generated into a private mode-0600 runtime file, never published.
- The public wrapper permits only selected read endpoints and bounded synthetic cart operations. Settings, exports, uploads, identity capture, checkout and payment endpoints are blocked independently of the admin UI.
- Before exposing API data, the wrapper verifies the seed shape, zero customers/addresses/payments, no personal information on carts/orders, and no enabled payment methods.
- Real gateway/SMTP/push credentials are rejected. The job scheduler is not started.
- Sessions expire after one hour and are capped at 100; existing authenticated sessions are reused. Carts are capped at 1,000 retained rows and expire after one day. Capacity is measured from the database, not reset by a process restart.
- Cleanup runs every minute with a statement timeout. Cleanup failure makes readiness fail. The demo sends noindex and restrictive security headers.
- Generated product imagery is synthetic, not a claim about goods offered for sale.

## Local Deployment

This example assumes PostgreSQL 17 binaries at `/usr/lib/postgresql/17/bin`, Node/pnpm matching the repository, and PM2 already provisioned. Use the existing workspace setup rather than installing a second toolchain.

1. Install the root and admin workspaces with frozen lockfiles; build API/shared and admin.
2. Create `~/.local/state/sellright-demo` with mode 0700.
3. Initialize a **new** cluster:

```sh
/usr/lib/postgresql/17/bin/initdb \
  -D "$HOME/.local/state/sellright-demo/postgres" \
  --auth-local=trust --auth-host=reject --username=sr_demo_owner --no-locale --encoding=UTF8
pm2 start deploy/demo/ecosystem.config.cjs --only sellright-demo-db
/usr/lib/postgresql/17/bin/createdb \
  -h "$HOME/.local/state/sellright-demo" -p 5545 -U sr_demo_owner \
  -E UTF8 -T template0 sellright_demo
node deploy/demo/configure.mjs
node deploy/demo/run.mjs --migrate
node deploy/demo/run.mjs --seed
```

The first seed is a transaction that rolls back and prints only synthetic row counts. Review those counts, then run `node deploy/demo/run.mjs --seed --apply`. The seed refuses non-demo stores and never overwrites an existing seed or password.

4. As `sr_demo_owner`, provision the runtime role in this new database:

```sql
CREATE ROLE sellright_demo_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
GRANT CONNECT ON DATABASE sellright_demo TO sellright_demo_app;
GRANT USAGE ON SCHEMA public TO sellright_demo_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO sellright_demo_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO sellright_demo_app;
ALTER DEFAULT PRIVILEGES FOR ROLE sr_demo_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO sellright_demo_app;
ALTER DEFAULT PRIVILEGES FOR ROLE sr_demo_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO sellright_demo_app;
```

The Unix socket is inside the private mode-0700 directory; there is no TCP database listener. Local trust is restricted by filesystem ownership, not suitable for a shared writable socket directory.

5. Start and verify:

```sh
pm2 start deploy/demo/ecosystem.config.cjs --only sellright-demo
curl --fail http://127.0.0.1:4310/v1/readyz
pm2 save
```

Browse `http://127.0.0.1:4310/shop`; `/enter` creates a short-lived read-only admin session. For remote preview, use an SSH tunnel. The readiness response reports synthetic-data checks, read-only access, cart count and session count.

## Public Edge

Route only `demo.sellright.cc` through an authenticated, TLS-enabled origin proxy. Preserve Host and scheme, use Cloudflare origin locking when Cloudflare fronts it, and keep the backend/database ports off the public network. Do not reuse a merchant vhost, customer database, gateway account or mail configuration.

On the server's Dockerized nginx, add the vhost to the Dockerfile COPY list as well as the configuration directory. Validate the new image/config before switching it. DNS/TLS/proxy setup and a public HTTPS browser check are required before calling the demo public.

`nginx.conf.example` is the dedicated vhost template. Provision its matching
certificate using the existing certificate-management workflow first. Configure
Cloudflare's proxied DNS record and Full (strict) TLS; do not reuse a different
hostname's certificate or weaken TLS verification. The nginx build must include
`COPY sellright-demo.conf /etc/nginx/conf.d/sellright-demo.conf` and retain the
existing origin-lock configuration. Privileged certificate/proxy commands follow
the host's operator access rules.

When the private proxy path is ready, switch only the demo listener:

```sh
DEMO_BIND_HOST=172.22.0.1 pm2 restart sellright-demo --update-env
curl --fail -H 'Host: demo.sellright.cc' http://172.22.0.1:4310/v1/readyz
pm2 save
```

Confirm the listener is on the private bridge only, validate/rebuild the nginx
image, then verify `https://demo.sellright.cc/v1/readyz`, `/shop` and `/enter`
through Cloudflare. Direct-origin requests must remain forbidden. Loopback
rollback is `DEMO_BIND_HOST=127.0.0.1 pm2 restart sellright-demo --update-env`.

The apex product domain is deliberately not accepted by the demo wrapper. Route it explicitly to product documentation or a separately reviewed product page.

## Checks and Maintenance

```sh
node --test deploy/demo/*.test.mjs
node --check deploy/demo/server.mjs
node --check deploy/demo/shop.js
```

Verify desktop/mobile browsing, cart add/update/remove/reload, unchanged order count, read-only admin sign-in, blocked write/payment/export endpoints and successful readiness after a process restart.

No destructive reset endpoint is exposed. A maintenance reset requires stopping this demo, confirming the exact private cluster/database, and explicitly recreating only its synthetic state. Do not adapt these commands to a merchant database.
