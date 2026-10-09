# SellRight Architecture

This document describes the current product structure. Historical design and audit documents under `docs/plans/` are snapshots, not deployment status or release certification. See the [changelog](../CHANGELOG.md) and the checks attached to the revision being evaluated.

## Core Shape

| Layer | Choice |
|---|---|
| API | Hono + `@hono/zod-openapi`; versioned REST under `/v1`; OpenAPI at `/v1/openapi.json` |
| Runtime | Node.js, TypeScript, pnpm workspace |
| Data | Postgres + Drizzle, integer cents for money |
| Tenancy | `store` root entity, store-scoped tables, Postgres RLS via `app.current_store` |
| Admin | React + Vite + Tailwind/shadcn-style components |
| Storefront | Reference Qwik storefront in `packages/storefront` over the typed REST client in `packages/storefront-client`; static catalog manifest plus merchant feeds for downstream consumers (RightSites) |
| Payments | `PaymentProvider` interface; Stripe, NMI, and Sezzle implemented; per-store gateway accounts with persisted mode/test provenance |
| Email | Nodemailer SMTP; all transactional mail goes through the durable `email_outbox` with dedupe keys, retries, and dead-letter |
| Jobs | Leader-locked in-process scheduler (advisory lock) for sweeps: outbox, restock, SheerID expiry, cart maintenance, Listmonk sync |

## Repository Layout

```text
packages/
  api/         Hono API, Drizzle schema, migrations, jobs, imports, OpenAPI
  admin/       React admin SPA
  storefront/  reference Qwik storefront
  storefront-client/  typed REST client generated from /v1/openapi.json
  shared/      shared money primitives and types
docs/          product documentation
```

## Request Model

Every store-scoped request resolves a store, then runs database work through `withStore(storeId, fn)`.

`withStore` opens a transaction and sets `app.current_store` with `SET LOCAL`. RLS policies use that session value to confine reads and writes to one store. Route code must not import the unscoped database client for store-scoped tenant queries; the unscoped export is named `unsafeUnscopedDb`. An ESLint `no-restricted-imports` rule in `eslint.config.mjs` blocks it from route files. The legitimate unscoped callsites are: the global admin/ACL/Session tables, which are deliberately NOT store-scoped (they gate access TO stores). Those reads live in `packages/api/src/auth/admin-staff.ts` so route files stay as thin shells that import only `withStore` and helper functions. Pre-context tenant lookup for payment webhooks (which must find the owning store from a provider reference *before* any store context exists) goes through the `resolve_store_for_gateway_event` SECURITY DEFINER function (`payments/tenant-resolution.ts`, migrations `0053`/`0060`), which returns only a validated `store_id` — the runtime role never receives BYPASSRLS. Resolution is strict: the distinct store set across all matching refs must be a singleton, and caller-supplied account/mode bind the match — ambiguity returns NULL rather than picking a winner.

This gives SellRight two layers of tenant isolation:

1. Route-level store resolution.
2. Database-level RLS enforcement.

The verification gate includes `db:assert-rls`, `db:assert-hand-written`, and `assert:shop-isolation` so new store-scoped tables, drift on hand-written migrations, and public shop routes cannot silently bypass the model.

## API Surface

SellRight is REST-first, not GraphQL-first.

Main route groups:

| Area | Examples |
|---|---|
| Health and contract | `/v1/health`, `/v1/openapi.json` |
| Catalog | products, collections, search, stock, static manifest generation |
| Cart and checkout | cart rows, server-priced checkout, shipping/tax/promo validation |
| Payments | payment intents, `/pay`, Stripe webhook receiver |
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
- Operator tools: blog posts, webhooks, affiliates, reports, staff invites, activity.
- Customer-facing flows: contact submissions, restock requests/events, SheerID verifications, disputes, email-change tokens, durable email outbox.
- Order editing (migration 0084): `order_edit` (one row per committed edit: before/after snapshot, `balance`, `settlement`, idempotency key + payload fingerprint), `order_adjustment` (labelled +/- cents applied to the grand total, replaced as a set per edit) and `order.shipping_override` (shipping amount set by hand). Both tables cascade with the order. Migration 0086 adds `order.shipping_method_code` / `shipping_method_name`.
- Amount due: `amountDueForOrder` (`payments/settle.ts`) is grand total minus net settled tender. When positive on a Paid/PartiallyRefunded order, payment status reads `balance_due`; `/pay`, NMI, Sezzle and Stripe charge only that amount, and balance attempts are namespaced by settled-tender count so a later edit cannot replay an earlier intent.
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
once per minute under a store-scoped database leader lock. For a one-shot publication, run
`pnpm --filter @sellright/api exec tsx src/manifest/generate.ts` with the same
store/directory settings and the unprivileged runtime database role.

Each publication writes a complete `generations/<uuid>/` tree, then atomically
swaps the `current` symlink. Consumers must resolve `current` once, validate
`marker.json` (`format: 1`, `source: sellright`, matching store and generation,
fresh `generatedAt`), and read files from that pinned directory. RightSites
rejects snapshots older than five minutes and fetches REST data during SSR.
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

`packages/admin/e2e` (Playwright, 13 specs) and `packages/storefront/e2e` (10 specs) run against production builds (`dist-e2e`; the storefront with SSG off). Each `start-api.mjs` drops and recreates a dedicated database (`sellright_admin_e2e` on :3399, `sellright_storefront_e2e` on :3398), migrates, bootstraps a store and owner, then serves the API from `packages/api/dist` on a non-superuser role. `assertSafeTargets` refuses any other database or port. One worker, shared database; global setup seeds through the admin API. The storefront suite also starts `mock-gateways.mjs` (NMI, Sezzle, IndexNow, webhook receiver, SMTP sink), so checkout, payment code and outbox workers are real while gateways are mocked; with `PLAYWRIGHT_API_URL` set only the storefront starts and money specs skip. CI jobs: `e2e-admin`, `e2e-storefront`.

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
- Import TRUNCATE guard.
- No raw card handling in the intended payment architecture.

## Deployment Model

SellRight can run as one API process plus one static admin build. The current production-oriented deployment path uses:

- compiled API entrypoint from `packages/api/dist`;
- environment files outside git;
- PM2 or systemd-compatible scripts;
- nginx in front of API/admin;
- Postgres on the native service port for SellRight databases;
- a non-owner runtime DB role (`sellright_app` in `deploy/compose.yaml`, provisioned by the `db-init` one-shot) with migrations/bootstrap on the separate privileged identity;
- backup scripts and restore drills as a launch gate.

Email is configured in `packages/api/.env`; see [Email Delivery](EMAIL.md) for
SMTP, Vendure Gmail aliases, and shared-store per-app sender routing.

## Verification Gate

After API changes, run:

```bash
pnpm verify
```
The gate builds all packages, type-checks, runs API tests, asserts FORCE RLS coverage, asserts hand-written-migration markers, and checks shop-route isolation.

## Migrations

See [runbooks/migrations.md](runbooks/migrations.md) for the rule on
hand-written migrations. The authoritative enforced list lives in
`packages/api/src/db/assert-hand-written-migrations.ts`. The
`db:assert-hand-written` script enforces the rule in CI.

Postgres runtime-role timeouts and per-service `application_name` configuration
are maintained in [runbooks/postgres-app-role.md](runbooks/postgres-app-role.md).
