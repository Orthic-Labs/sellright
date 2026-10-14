# SellRight Architecture

This document describes the current product structure. Historical design and audit documents under `docs/plans/` are snapshots, not deployment status or release certification. See the [changelog](../CHANGELOG.md) and the checks attached to the revision being evaluated.

## Core Shape

| Layer | Choice |
|---|---|
| API | Hono + `@hono/zod-openapi`; versioned REST under `/v1`; OpenAPI at `/v1/openapi.json` |
| Runtime | Node.js, TypeScript, pnpm workspace |
| Data | Postgres + Drizzle, integer cents for money |
| Tenancy | `store` root entity, store-scoped tables, Postgres RLS via `app.current_store` |
| Admin | React + Vite + Tailwind CSS 4 |
| Storefront | Reference Qwik storefront in `packages/storefront` over the typed REST client in `packages/storefront-client`; static catalog manifest plus merchant feeds for downstream consumers (RightSites) |
| Payments | `PaymentProvider` interface; Stripe, NMI, and Sezzle implemented; per-store gateway accounts with persisted mode/test provenance |
| Email | Nodemailer SMTP; transactional mail is queued in the durable `email_outbox` with dedupe keys, retries, and dead-letter; staff invites, free-trial keys and the admin SMTP test email are sent inline |
| Jobs | Leader-locked in-process scheduler (advisory lock) for sweeps: outbox, restock, SheerID expiry, cart maintenance, Listmonk sync |

## Repository Layout

```text
packages/
  api/         Hono API, Drizzle schema, migrations, jobs, imports, OpenAPI
  admin/       React admin SPA
  storefront/  reference Qwik storefront
  storefront-client/  typed REST client generated from /v1/openapi.json
  sample-plugin/  reference engine plugin built on the public @sellright/api exports
  shared/      shared money primitives and types
docs/          product documentation
```

## Request Model

Every store-scoped request resolves a store, then runs database work through `withStore(storeId, fn)`.

`withStore` opens a transaction and sets `app.current_store` with `SET LOCAL`. RLS policies use that session value to confine reads and writes to one store. Route code must not import the unscoped database client for store-scoped tenant queries; the unscoped export is named `unsafeUnscopedDb`. An ESLint `no-restricted-imports` rule in `eslint.config.mjs` blocks it from route files. Outside route files, `unsafeUnscopedDb` is used by operator scripts under `packages/api/src/scripts/`, `payments/stripe.ts`, `licensing/storekit-config.ts` and the `auth/` modules `admin-staff.ts`, `admin-session.ts`, `admin-api-token.ts` and `setup-claim.ts`. The global admin/ACL/Session tables are deliberately NOT store-scoped (they gate access TO stores); those reads live in `packages/api/src/auth/admin-staff.ts` so route files stay as thin shells that import only `withStore` and helper functions. Pre-context tenant lookup for payment webhooks (which must find the owning store from a provider reference *before* any store context exists) goes through the `resolve_store_for_gateway_event` SECURITY DEFINER function (`payments/tenant-resolution.ts`, migrations `0053`/`0060`), which returns only a validated `store_id` - the runtime role never receives BYPASSRLS. Resolution is strict: the distinct store set across all matching refs must be a singleton, and caller-supplied account/mode bind the match - ambiguity returns NULL rather than picking a winner.

This gives SellRight two layers of tenant isolation:

1. Route-level store resolution.
2. Database-level RLS enforcement.

The verification gate includes `db:assert-rls`, `db:assert-hand-written`, `assert:shop-isolation`, and `assert:settlement` so new store-scoped tables, drift on hand-written migrations, public shop routes, and direct writes to settlement tables cannot silently bypass the model.

## API Surface

SellRight is REST-first, not GraphQL-first.

Main route groups:

| Area | Examples |
|---|---|
| Health and contract | `/v1/health`, `/v1/openapi.json` |
| Catalog | products, collections, search, stock, static manifest generation |
| Cart and checkout | cart rows, server-priced checkout, shipping/tax/promo validation |
| Payments | payment intents, `/pay`, NMI and Sezzle gateway payments, Stripe, NMI and Sezzle webhook receivers |
| Auth/account | register, login, Google auth, sessions, password reset, email verification, customer profile, addresses |
| Orders | customer orders, admin order operations, draft orders, refunds, returns |
| Admin | catalog, customers, staff, settings, reports, tax, locations, gift cards, webhooks, affiliates, blog, assets |
| App licensing | app license activation, update manifests, licensed downloads |

## Data Model

The schema is a full commerce schema rather than a thin catalog API. It includes:

- Store registry and admin-user-to-store membership.
- Catalog: products, variants, options, collections, assets, inventory, locations.
- Customers: identity, sessions, addresses, customer tokens.
- Orders: order snapshots, lines, payments, refunds, returns, fulfillments.
- Commerce rules: promotions, gift cards, shipping methods, tax zones, currency rates.
- Operator tools: blog posts, webhooks, affiliates, staff invites, activity (`audit_log`).
- Customer-facing flows: contact submissions, restock requests/events, SheerID verifications, disputes, email-change tokens, durable email outbox.
- Order editing (migration 0084): `order_edit` (one row per committed edit: before/after snapshot, `balance`, `settlement`, idempotency key + payload fingerprint), `order_adjustment` (labelled +/- cents applied to the grand total, replaced as a set per edit) and `order.shipping_override` (true when an admin set a custom or removed shipping amount). Both tables cascade with the order. Migration 0086 adds `order.shipping_method_code` / `shipping_method_name`.
- Amount due: `amountDueForOrder` (`payments/settle.ts`) is grand total minus settled non-duplicate tender, plus refunds issued by an order edit. When positive on a Paid/PartiallyRefunded order, payment status reads `balance_due`; `/pay`, NMI, Sezzle and Stripe charge only that amount, and balance attempts are namespaced by settled-tender count so a later edit cannot replay an earlier intent.
- Order status columns: `status` (`open|completed|cancelled|archived`) is a stored generated column; `paymentStatus` and `fulfillmentStatus` are derived at read time from payment/fulfillment rows (`orders/status.ts`, `status-sql.ts`). Only `paymentStatus` can be `balance_due`.
- Loyalty (`store.config.loyalty`, `money/loyalty.ts`): the append-only `loyalty_ledger` is the only writer of balances; kinds are `earn|redeem|reverse|adjust|expire|import|bonus`. Bonus rules (review, sign-up, first order, birthday) post once via a deterministic `source_ref`; a reversal is a normal `reverse` row and never clears the original `source_ref`. `product_review` (migration 0085) is moderated `pending|approved|rejected`, one per product per reviewer email; the rating aggregate is derived from approved rows, never stored.
- Software sales: licenses, activations, app releases, download artifacts.

Most business tables are store-scoped. Shared registry tables that intentionally cross stores are documented and excluded from FORCE RLS only when needed.

## Money Path

The money path follows five rules:

1. Store money as integer cents.
2. Compute totals server-side.
3. Treat client prices, shipping, discounts, and tax as suggestions only.
4. Use idempotency keys around payment-sensitive operations.
5. Record state changes and side effects so retries do not double-charge, double-refund, or double-issue.

Current money modules cover totals, tax, discounts, gift cards, currency rates, order state, invoice generation, and stock reservation.

## Catalog Read Path

Native admin variant creation/detail/edit supports preorder status, nullable
preorder price in cents, and a nullable ISO ship timestamp. Clearing price/date
uses explicit `null`; the editor labels ship timestamps as UTC.

Admin product, variant, gallery, option and stock mutations enqueue
`catalog.product_changed` in the existing transactional webhook outbox.
Its payload is `{ storeId, productId, slug }`, including the original slug after
soft deletion. Endpoints are matched by store and topic; delivery uses the
existing HMAC signature and bounded retries. This generic event contains no
storefront host, IndexNow identity or merchant-specific behavior. Storefronts
can use it to notify their configured search engines. Bulk imports, blog edits
and order-driven stock changes do not emit this admin-catalog event.

The preferred browse path is a static catalog manifest:

- `shop-catalog.json` for listing/search primitives.
- Per-product detail files for product pages.
- Dynamic REST remains available for account, checkout, live stock, and admin.

Publication is opt-in: `JOBS_ENABLED=1`, `CATALOG_MANIFEST_JOBS_ENABLED=1`,
explicit `STORE_SLUG`, and a dedicated `CATALOG_DIR`. The scheduler publishes
once at startup, and every publication runs under a store-scoped database leader lock.
After each commit that calls `onStockChanged` (`manifest/stock-hook.ts`; for example stock
changes and admin product and catalog edits) the manifest is republished with no debounce,
and a two-minute `catalog-manifest-drain` job republishes any regeneration lost to a crash.
For a one-shot publication, run
`pnpm --filter @sellright/api exec tsx src/manifest/generate.ts` with the same
store/directory settings and the unprivileged runtime database role.

Each publication writes a complete `generations/<uuid>/` tree, then atomically
swaps the `current` symlink. Consumers must resolve `current` once, validate
`marker.json` (`format` 1 or 2, `source: sellright`, matching store and
generation, parsable non-future `generatedAt`), and read files from that pinned
directory. The SellRight storefront reader has no age-based expiry (the
publisher regenerates on every stock change); it falls back to REST data during
SSR only when the snapshot is missing or invalid, and fails closed if that also
fails. RightSites reader behavior is not checked here (unverified: RightSites code is
not in this repository).
Never point it at a legacy Vendure directory. Keep the previous generation and
a ten-minute grace period for in-flight readers; only marked, owned generations
are cleaned up. An exclusive `owner.json` claim prevents different stores from
racing to initialize the same destination. Configure a separate destination/publisher per store; a single
API scheduler publishes only its explicit `STORE_SLUG`.

Public Vendure facet labels are imported into native product tags for browse
filters; private source facets are excluded. Original facet IDs remain in
variant metadata for migrated coupon eligibility.

This keeps storefront browsing cheap and fast while preserving a transactional backend for money and account flows.

## Browser E2E Harness

`packages/admin/e2e` (Playwright, 14 specs) and `packages/storefront/e2e` (24 specs) run against production builds (`dist-e2e`; the storefront with SSG off). Each `start-api.mjs` drops and recreates a dedicated database (`sellright_admin_e2e` on :3399, `sellright_storefront_e2e` on :3398), migrates, bootstraps a store and owner, then serves the API from `packages/api/dist` on a non-superuser role. `assertSafeTargets` refuses a database whose name does not end in `_e2e` (or is a named dev or production database) and the dev API port 3300. One worker, shared database; global setup seeds through the admin API. The storefront suite also starts `mock-gateways.mjs` (NMI, Sezzle, IndexNow, webhook receiver, SMTP sink), so checkout, payment code and outbox workers are real while gateways are mocked; with `PLAYWRIGHT_API_URL` set only the storefront starts and money specs skip. CI jobs: `e2e-admin`, `e2e-storefront`.

## Security Model

Built-in controls:

- Postgres RLS with FORCE assertions.
- Dedicated non-owner app role (NOBYPASSRLS) for runtime; `assertRuntimeRoleUnprivileged` fails boot on a privileged role; migrations/bootstrap use a separate privileged identity.
- Admin and shop CSRF guards for cookie-backed mutation requests.
- Rate limiting for sensitive auth and checkout paths.
- Password reset, email verification, and email-change token tables.
- TOTP replay guard.
- Webhook idempotency plus narrow SECURITY DEFINER tenant resolution for pre-context gateway events.
- Durable, deduplicated dispute records with signed provider webhooks and operator alerting.
- Turnstile anti-bot (fail-closed when configured) on contact, register, login, and reset paths.
- Transactional `audit_log` records for sensitive staff/settings/payment mutations.
- Imports run one source snapshot in one target transaction with no table-wide delete or truncate (`packages/api/src/import/run.ts`).
- No raw card handling in the intended payment architecture.

## Deployment Model

SellRight can run as one API process plus one static admin build. The supported single-instance production path is Docker Compose (`deploy/compose.yaml`, `deploy/install.sh`; see [Production Compose operations](runbooks/production-compose.md)). It uses:

- the compiled API entrypoint `dist/index.js`, started by the Compose `command` after `dist/scripts/migrate.js` and `dist/scripts/bootstrap.js` run with `DATABASE_URL_MIGRATE`;
- environment in `deploy/.env`, outside git;
- a Caddy edge in front of the admin container, which serves the static admin build with nginx and proxies `/v1` to the API (`deploy/Caddyfile`, `packages/admin/nginx.conf.template`);
- Postgres 17 in a container on the private Compose network;
- a non-owner runtime DB role (`sellright_app` in `deploy/compose.yaml`, provisioned by the `db-init` one-shot) with migrations/bootstrap on the separate privileged identity;
- the `sellright backup` and `sellright restore` commands (`deploy/sellright.sh`), with an automated restore drill in CI (`docs/runbooks/recovery.md`).

Email is configured through environment variables (`packages/api/.env` in development, `deploy/.env` in Compose) or, when `SMTP_HOST` is unset, per-store SMTP settings saved in the admin; see [Email Delivery](EMAIL.md) for
SMTP, Vendure Gmail aliases, and shared-store per-app sender routing.

## Verification Gate

After API changes, run:

```bash
pnpm verify
```
The gate builds all packages, type-checks, runs API and storefront-client tests, checks that the generated storefront client is current, asserts there is no Vendure or GraphQL coupling, checks the agent deny-set boundary, asserts FORCE RLS coverage, asserts hand-written-migration markers, checks shop-route isolation, and checks the settlement chokepoint.

## Migrations

See [runbooks/migrations.md](runbooks/migrations.md) for the rule on
hand-written migrations. The authoritative enforced list lives in
`packages/api/src/db/assert-hand-written-migrations.ts`. The
`db:assert-hand-written` script enforces the rule in CI.

Postgres runtime-role timeouts and per-service `application_name` configuration
are maintained in [runbooks/postgres-app-role.md](runbooks/postgres-app-role.md).
