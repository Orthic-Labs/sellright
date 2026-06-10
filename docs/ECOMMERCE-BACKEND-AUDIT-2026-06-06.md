# SellRight Ecommerce Backend Audit

> **SUPERSEDED (2026-06-10):** this audit predates the 27-commit hardening session (migrations 0011–0021) and lists items as gaps that have since shipped (cart CRUD, promotion concurrency, refunds, gift cards, webhooks, smart collections, staff invites, multi-location, per-action permissions, multi-currency — see STATE-AND-ROADMAP-v1.md §2A). Current audit: [docs/fable/APP-AUDIT-2026-06-10.md](fable/APP-AUDIT-2026-06-10.md). Kept for historical context only.

Generated: 2026-06-06
Workspace: `D:\Claude\sellright`
Commit at audit start: `c8d31c7e1cfd1ba4551c3cb0db0cfb269eb6294b`

## Executive Summary

SellRight is a credible self-hosted commerce MVP, not a Shopify replacement yet.
Against Shopify as a 10, SellRight is currently **5.5/10 overall** for core
ecommerce backend capability after the fixes in this audit pass.

The foundation is better than the old root README implied: multi-tenant
Postgres/RLS, products, variants, collections, stock, order snapshots, admin
auth, customer auth, checkout, manual/COD payments, promotions, draft orders,
refund records, affiliate/blog parity, and admin screens exist. The gap to 10 is
mostly product depth and operational maturity: real payments, shipping/tax
engines, cart persistence/recovery, gateway-backed refunds, email/webhooks,
returns/exchanges, media uploads, smart collections, fine-grained permissions,
multi-location inventory, and production hosting/observability.

## Shopify 10 Benchmark

This benchmark is based on current Shopify docs:

- Shopify Admin APIs cover Customers, Discounts, Gift Cards, Inventory, Orders,
  Products, Shipping and Fulfillment, Shopify Payments, store properties, and
  webhooks: <https://shopify.dev/docs/api/admin-rest>
- Shopify product management includes product details, pricing, inventory, and
  variant-specific inventory: <https://help.shopify.com/en/manual/products>
- Shopify collections support manual and smart collection workflows:
  <https://help.shopify.com/en/manual/products/collections>
- Shopify discounts include discount codes, automatic discounts, and sale prices:
  <https://help.shopify.com/en/manual/discounts>
- Shopify Checkout checks carts against inventory and holds inventory only at
  payment submission: <https://help.shopify.com/en/manual/checkout-settings>
- Shopify order management includes search/filtering, draft orders, payment
  capture, editing orders, refunds, returns, packing slips/invoices, and
  fulfillment: <https://help.shopify.com/en/manual/fulfillment/managing-orders>
- Shopify fulfillment includes labels, carrier workflows, third-party
  fulfillment services, tracking, and bulk fulfillment:
  <https://help.shopify.com/en/manual/fulfillment>
- Shopify staff permissions are fine-grained across orders, discounts, payments,
  products, and settings:
  <https://help.shopify.com/en/manual/your-account/staff-accounts/staff-permissions/staff-permissions-descriptions>

## Scorecard

| Area | Score | Current state | What takes it to 10 |
|---|---:|---|---|
| Products and variants | 6 | Product/variant schema, status, prices, sale/preorder price, SKU, stock, import, admin create/edit/delete. | Image upload/media manager, option-group editor, variant assets, compare-at/cost/unit pricing, metafields, SEO fields, bulk editor, product validation, product publish channels. |
| Categories/collections | 4 | Manual collections with product membership and parent id. | Smart/automatic collections, sort rules, publish scheduling, menu/channel availability, collection images/SEO, bulk assignment. |
| Pricing, discounts, taxes | 5 | Integer cents, line-level rounding, sale/preorder prices, fixed/percentage/free-shipping coupons, usage ledger. Taxable shipping fixed in this pass. | Atomic promotion limits, automatic discounts, discount stacking/exclusion rules, gift cards/store credit, tax zones, inclusive tax, duties, multi-currency, price lists. |
| Customers | 5 | Customer table, password/Google auth, account orders/addresses, tags, admin create/edit. | Password reset, enforced email verification, cookie customer sessions, marketing consent lifecycle, segmentation, merge/export/delete, GDPR flows, customer notes/metafields. |
| Admin users and auth | 6.5 | httpOnly admin cookie, CSRF, TOTP, scrypt passwords, rate limiting, roles, store ACL. | Fine-grained permissions, invitation flow, session revocation UI, audit views by actor, per-action capability model, production CSP/host, Redis-backed rate limits. |
| Cart and checkout | 4.5 | Server-priced cart estimate, checkout creates orders, stock allocation, idempotency, stale allocation job. Allocation rollback fixed in this pass. | Public cart CRUD/sync endpoints, abandoned checkout identity capture/recovery, shipping-method selection and validation, checkout configuration, fraud/bot protections, payment-session lifecycle. |
| Orders and order items | 6 | Order/order_line snapshots, states, order detail, admin list/detail, fulfill/cancel/refund records, draft orders, export/import tracking. | Edit orders, returns/exchanges, gateway-backed refund/capture/void, invoices/packing slips, timeline events, partial fulfillment UI, archiving, fraud review, notifications. |
| Inventory | 5 | Stock on hand/allocated, atomic allocation, movements, low-stock admin view, stale allocation release script. | Multi-location inventory, inventory policies, transfers, reservations by checkout/payment step, supplier/fulfillment-service sync, scheduled cleanup worker. |
| Payments | 2.5 | Provider interface plus manual/COD. Payment method toggles enforced in this pass. | NMI/Stripe/Sezzle tokenized gateway flows, webhooks, captures, voids, refunds, payment event ledger, PCI/SAQ-A documentation, reconciliation. |
| Shipping and fulfillment | 3.5 | Shipping methods table/admin, manual fulfillment/tracking, auto-delivered job. | Real rate calculation, shipping profiles/zones, carrier labels, fulfillment services, split shipments, delivery holds, returns labels. |
| Platform/ops/security | 5.5 | RLS, RLS assertion, typecheck, focused tests, fail-fast env, production 500 masking fixed in this pass. | CI, staging/prod env split, backups/restore drill, observability, webhooks/outbox, Redis jobs, load tests, secrets management, deployment hardening. |

## Fixes Applied In This Pass

1. **Stock allocation rollback**
   - Files: `packages/api/src/orders/stock-reservation.ts`,
     `packages/api/src/routes/checkout.ts`,
     `packages/api/src/routes/admin-orders.ts`
   - Before: checkout/draft-order could allocate early lines, discover a later
     blocked SKU, return 409, and still commit the earlier allocation.
   - Now: missing/disabled SKUs are prevalidated, stock update failures throw a
     `StockReservationError`, and `withStore()` rolls the transaction back.

2. **Verified-customer coupon trust**
   - File: `packages/api/src/routes/checkout.ts`
   - Before: guest checkout could send another customer's email and inherit that
     account's verification categories for coupon conditions.
   - Now: coupon verification benefits and `customerId` come only from the
     authenticated bearer session. Body email remains contact info.

3. **Payment method toggles enforced**
   - Files: `packages/api/src/payments/provider.ts`,
     `packages/api/src/routes/pay.ts`
   - Before: admin could disable `cod` or `manual`, but `/pay` would still accept
     any registered provider.
   - Now: `/pay` rejects configured-disabled methods.

4. **Taxable shipping honored**
   - Files: `packages/api/src/money/totals.ts`, `packages/api/src/store-context.ts`,
     `packages/api/src/routes/cart.ts`, `packages/api/src/routes/checkout.ts`,
     `packages/api/src/routes/admin-orders.ts`
   - Before: `store.shipping_taxable` existed but totals ignored it.
   - Now: shipping enters the tax basis only when `shippingTaxable` is true.

5. **Production 500s no longer expose raw error messages**
   - File: `packages/api/src/app.ts`
   - Before: production responses returned `err.message`.
   - Now: production returns `internal error`; dev/test still expose details.

6. **Doc drift corrected**
   - Files: `README.md`, `packages/admin/README.md`
   - Root/admin docs no longer claim the backend is only M0 or that admin tokens
     live in localStorage.

7. **Email identity normalization**
   - Files: `packages/api/src/auth/email.ts`,
     `packages/api/src/routes/auth.ts`, `packages/api/src/routes/admin.ts`,
     `packages/api/src/auth/admin-session.ts`,
     `packages/api/src/routes/admin-reports.ts`,
     `packages/api/src/routes/admin-settings.ts`,
     `packages/api/src/routes/admin-orders.ts`,
     `packages/api/src/scripts/seed-admin.ts`
   - Before: password/customer/admin flows stored and compared raw email strings
     while Google sign-in lowercased, so case variants could fail login or create
     duplicate identities.
   - Now: customer registration/login, Google link-up, admin login, admin/staff
     creation, customer creation, draft-order customer lookup, and seed-admin use
     a single lowercase/trim normalization helper.

## Remaining High-Priority Gaps

### 1. Cart is not a first-class persisted checkout resource

`packages/api/src/routes/cart.ts` currently exposes cart estimate, but the `cart`
and `cart_line` tables are not backed by public create/update/merge endpoints.
Admin abandoned carts can read rows, but the storefront has no complete REST cart
sync contract.

Needed:

- `POST /v1/shop/cart`
- `GET /v1/shop/cart/{token}`
- `PATCH /v1/shop/cart/{token}/lines`
- customer-cart merge on login
- abandoned checkout identity capture once email is entered
- cart-to-order conversion that sets `converted_order_id`

### 2. Payments are still test/offline only

The `PaymentProvider` interface is sound, but real gateways are absent. This
blocks true launch parity.

Needed:

- NMI tokenized card flow first, then Sezzle/Stripe as needed
- webhook idempotency using `processed_event`
- capture/void/refund operations
- gateway event audit trail
- admin payment status and reconciliation views

### 3. Promotion limits are not fully concurrency-safe

Checkout still checks `usedCount` and increments later. Concurrent checkouts can
race global limits. Per-customer limits are also count-then-insert.

Needed:

- atomic conditional update for global usage
- row lock or serializable transaction around promotion usage
- robust per-customer limit enforcement for limit values above 1
- tests with concurrent checkout attempts

### 4. Shipping methods are not authoritative at checkout

Checkout accepts a numeric `shipping` amount from the request body. There is a
shipping-method table, but no enforced selected method/rate calculation in the
checkout route.

Needed:

- selected `shippingMethodId` or code
- server-side calculator evaluation
- zones/rates/min/max/exclusions validation
- block physical checkout when no shipping method is eligible

### 5. Refunds are ledger-only, not gateway operations

Admin refund records update SellRight state, but there is no provider-backed
refund/capture/void integration.

Needed:

- `PaymentProvider.refundPayment`
- idempotent refund events
- partial refund correctness tests
- restock and order state transitions tied to provider success/failure

### 6. Customer auth is not production-complete

Customer auth still returns bearer tokens for the storefront. Password reset,
email verification enforcement, and customer cookie sessions are not complete.

Needed:

- httpOnly customer cookie + CSRF or same-site session model
- password reset and email verification emails
- account lock/session revocation
- marketing consent capture and audit trail

### 7. Products need richer merchandising primitives

The schema is workable, but the admin product surface is basic.

Needed:

- product media upload and variant media assignment
- option-group editor
- compare-at price, cost, barcode, dimensions
- product/variant metafields
- SEO title/description on products and collections
- bulk edit/import/export

### 8. Admin roles are too coarse

`owner/manager/staff/read_only` is enough for early dogfooding but not Shopify
class staff control.

Needed:

- per-action permissions for orders, refunds, discounts, products, customers,
  settings, payments, staff, and reports
- staff invitation flow
- session management and forced logout
- audit views filtered by actor/action

### 9. Production operations are not at Shopify-grade maturity

Needed:

- CI running build/typecheck/unit tests/RLS assertion
- `_test` Postgres setup for destructive RLS tests
- scheduled stale allocation release job
- automated backups and restore drill
- structured logs, metrics, alerts
- deployment env/secrets hardening

## Domain Notes

### Products

Strengths:

- UUID product/variant model with store scoping
- SKU uniqueness per store
- soft delete preserving order history
- sale/preorder price support
- static manifest browse path

Gaps:

- no media upload
- no variant option editing in admin
- no compare-at/cost/unit pricing
- no sales channel visibility
- no product metafields

### Categories / Collections

Strengths:

- manual collections exist
- product membership and ordering exists
- parent collection id exists

Gaps:

- no smart collections
- no publish scheduling
- no collection image/SEO admin
- no menu/channel binding

### Pricing

Strengths:

- integer cents everywhere
- line-level rounding tests
- sale/preorder/base selection
- coupon re-evaluation on the server
- taxable shipping now supported

Gaps:

- promotion concurrency
- no stacking/exclusion engine beyond early fields
- no tax zones or inclusive tax
- no multi-currency price lists
- no gift cards/store credit

### Customers

Strengths:

- customer records, tags, auth, Google sign-in, addresses, order history
- admin create/edit

Gaps:

- no password reset
- no enforced email verification
- no customer deletion/export/privacy flows
- no segmentation beyond tags

### Admin Users / Auth

Strengths:

- scrypt password hashes
- httpOnly admin cookie
- CSRF double-submit
- TOTP
- rate limit
- ACL by store

Gaps:

- rate limit is process-local
- permissions too broad
- no invitations
- no production CSP/admin host

### Orders / Order Items

Strengths:

- order-line snapshots
- separate payment and fulfillment axes
- draft orders, CSV export, tracking import, refund records
- audit log

Gaps:

- no order editing after placement
- no returns/exchanges
- no real payment captures/refunds
- no invoices/packing slips
- no customer notifications

### Cart

Strengths:

- estimate endpoint reprices server-side
- cart tables exist

Gaps:

- no complete cart API
- no cart merge
- abandoned cart rows are not reliably populated from storefront
- no recovery emails

## Verification Performed

Commands run:

```powershell
pnpm --filter @sellright/api exec vitest run src/money/totals.test.ts src/payments/provider.test.ts src/orders/stock-reservation.test.ts
pnpm --filter @sellright/api typecheck
pnpm --filter @sellright/api exec vitest run src/app.test.ts src/money/totals.test.ts src/payments/provider.test.ts src/orders/stock-reservation.test.ts
pnpm --filter @sellright/api exec vitest run src/auth/email.test.ts src/app.test.ts src/money/totals.test.ts src/payments/provider.test.ts src/orders/stock-reservation.test.ts
pnpm --filter @sellright/api test
```

Results:

- Focused regression tests: 13/13 passed.
- API typecheck: passed.
- Full API test command: 5 test files passed, then failed at
  `src/db/rls.test.ts` before running RLS tests because `DATABASE_URL` was not a
  dedicated `_test` database.

Known verification gap:

- `pnpm --filter @sellright/api test` still requires `DATABASE_URL` to point at
  a dedicated `_test` database because `src/db/rls.test.ts` truncates tables by
  design. Without that env, the suite refuses to run to protect dev/prod data.

## Recommended Roadmap To 10

### Phase 1: Launch Safety

1. Real NMI tokenized payments, webhook idempotency, capture/refund.
2. Full cart CRUD/sync and abandoned checkout capture.
3. Server-side shipping method/rate selection in checkout.
4. Customer auth cookies, password reset, email verification.
5. CI with a provisioned `_test` Postgres database.
6. Production admin host, CSP, secrets, backups, observability.

### Phase 2: Shopify-Core Parity

1. Order editing, returns/exchanges, invoices/packing slips.
2. Product media upload, option editor, compare-at/cost/barcode/metafields.
3. Smart collections and collection publish/SEO controls.
4. Promotion concurrency hardening and automatic discounts.
5. Multi-location inventory and fulfillment service hooks.

### Phase 3: Competitive Platform

1. Webhooks/outbox and app integration surface.
2. Bulk operations/import/export for products, customers, and orders.
3. Advanced analytics/reports.
4. Fine-grained staff permissions and invitation lifecycle.
5. Multi-currency/tax zones/duties if the sales footprint requires it.
