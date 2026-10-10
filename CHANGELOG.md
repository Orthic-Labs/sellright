# Changelog — SellRight web, API, and admin

Notable changes to the SellRight commerce API, storefront, and desktop-browser
admin. The native iOS admin ships separately and is tracked in
[`ios/CHANGELOG.md`](ios/CHANGELOG.md).

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Every user-facing feature, fix, security change, or operational contract change
must update the matching changelog in the same push.

## [Unreleased]

### Added

- **Release registration policy host**: the engine owns `POST /v1/admin/apps/releases`; plugins supply `ApiPlugin.releaseRegistration` (app/channel claims, tenant-bound service credential, validation hook, optional `repointArtifacts`). Startup fails on conflicting claims or a re-registered host route. Admin-session republish of the same `(app, channel, platform, version)` is now an upsert (was a unique-violation error); `download_artifact` conflicts still keep the existing row unless the policy opts in. See `docs/policies/RELEASE-REGISTRATION.md`.
- Entitlement authorization policy: one plugin policy consulted by every activation, refresh, update-feed, lease, trial and StoreKit link path. The default policy changes nothing.
- `/v1/licenses/activate` alias for licence activation.
- Signed entitlement formats above v2 can be negotiated with `x-entitlement-versions`; unnegotiated clients always receive byte-identical v2 tokens.
- Admin essentials for running real stores:
  - **Refunds**: per-line quantity + independent per-line restock toggle
    (a single refund can restock one line and not another), a separate
    `shippingAmount` refunded on top of the item total (own `refund.shippingAmount`
    ledger column, not folded into the adjustment bucket), and a `reason`
    field — all surfaced end to end (API `POST /v1/admin/orders/{code}/refund`
    + the order-detail refund panel), plus per-refund history with the
    restock/reason breakdown.
  - **Partial fulfillment**: `POST /v1/admin/orders/{code}/fulfillments`
    creates a fulfillment scoped to selected lines/quantities (distinct from
    the existing all-or-nothing `POST /fulfill`, unchanged for its CSV/bulk
    callers), with an optional ship-from location, tracking/carrier, and a
    `notifyCustomer` toggle that gates the customer email without ever
    gating the outbound `order.shipped` webhook. Multiple partial
    fulfillments per order are supported (split shipments); the order-detail
    page gets a per-line quantity picker and a fulfillment history list.
  - **Stock adjustments**: `POST /v1/admin/variants/{id}/stock/adjust` applies
    a signed delta with a mandatory reason — never an absolute overwrite —
    recorded as a new `stock_movement` row (now carrying an `actor`) every
    time; `GET .../stock/history` and a per-location breakdown
    (`GET .../stock/locations`) are surfaced in a new Inventory "Adjust"
    modal. Terminology is "Committed" everywhere (already was; verified
    consistent). Stock reads remain live/uncached throughout.
  - **Discounts admin**: the existing `startsAt`/`endsAt`, minimum-order-amount
    and native item-scope conditions (whole order, collections, products,
    tags — `money/coupon.ts`'s condition vocabulary, at most one scope per
    discount) and usage limits are now editable in the admin UI, including
    an edit flow for existing discounts (the API already supported all of
    this; only the UI was missing it). Discounts saved with the retired
    `at_least_n_with_facets` condition hydrate with a warning and drop the
    condition on save.
  - **Order timeline internal notes**: `POST /v1/admin/orders/{code}/notes`
    appends a staff-only note into the same `audit_log`-backed timeline as
    every other order event (no second feed to keep in sync).
  - **Shared `ConfirmDialog`**: an accessible, focus-managed confirm modal
    (`useConfirmDialog()`) replaces every `window.confirm(...)` call site in
    the admin app (orders bulk-purge, order cancel/refund, product
    archive/variant delete, blog post delete, tax zone delete, staff
    removal, affiliate payout). Icon-only buttons without an accessible name
    (copy link, remove line item, delete variant, remove/add collection
    product) now carry `aria-label`.

- Order/payment/fulfillment status split (backend de-Vendure work). The order
  API surfaces (admin order list/detail, account order list/detail, the
  public receipt, and guest tracking) now expose three separate, lowercase
  snake_case, wire-facing fields alongside the existing combined `state`:
  - `status`: `open` | `completed` | `cancelled` | `archived` — a Postgres
    STORED GENERATED column (migration 0080) computed from `state` +
    `deleted_at`, backfilled automatically for every existing order.
  - `paymentStatus`: `pending` | `authorized` | `paid` | `partially_refunded`
    | `refunded` | `voided` | `failed` — computed at read time from the
    order's payment rows (`orders/status.ts`); NOT a persisted column (see
    migration 0080's header comment for why: it depends on another table
    that changes at many independent call sites, so persisting it would need
    either a trigger or manual dual-write at every one of those sites — read-
    time derivation from the same source of truth is correct by construction
    instead).
  - `fulfillmentStatus`: `unfulfilled` | `partially_fulfilled` | `fulfilled`
    | `partially_delivered` | `delivered` — same reasoning, derived from
    `order_line`/`fulfillment` rows.

  `GET /v1/admin/orders` gains `?status=`, `?paymentStatus=`, and
  `?fulfillmentStatus=` filters (the last two backed by SQL fragments in
  `orders/status-sql.ts` that a DB test proves agree with the TS derivation).
  The internal FSM (`money/fsm.ts`, the `order_state` enum, every transition
  guard) is completely unchanged — this is a read-side projection only.

- Native coupon/promotion conditions replace the Vendure-era
  `at_least_n_with_facets` (which read `productVariant.metafields
  .facetValueIds`). Three native item-targeting conditions are available:
  `at_least_n_in_collections`, `at_least_n_products`, `at_least_n_with_tags`
  — matching against a product's real `collection_product` membership,
  product id, or native `product.tags`. `money/coupon.ts` (the runtime
  evaluator used by cart/checkout/admin order-line edits) no longer has any
  Vendure-shaped concept in it. The Vendure importer (`import/catalog.ts`,
  which is explicitly allowed to know about Vendure) now resolves each
  `at_least_n_with_facets` condition's target facet values into synthetic,
  unpublished native collections at migration time and rewrites the
  condition to `at_least_n_in_collections` — the facet id never reaches a
  live store.
- **Customer return requests** (storefront + API): `GET`/`POST /v1/shop/account/orders/{code}/returns`
  let a signed-in customer ask to return units that have shipped (only paid orders, only shipped and
  not-yet-refunded units, never the same unit in two open requests) and read each request's status
  (requested / approved / received / refunded / rejected) on their account order page. Requests land in the
  admin Returns queue unchanged; the shopper never chooses restock. New error code `NOT_RETURNABLE`.
- **Sign-in links in the storefront**: the sign-in page offers "Email me a sign-in link" when the store has
  it on (`GET /v1/shop/config` now reports `auth.magicLink`), and `/account/magic-link` exchanges the emailed
  token for a session (the API already minted the link; the storefront had no page for it).

- **Order editing** (migration 0084): `GET /v1/admin/orders/{code}/edit/context`, `GET .../edit/variants`,
  `POST .../edit/preview` (stateless: totals, per-line diff, stock delta, balance) and `POST .../edit/commit`
  (guarded by `expectedGrandTotal`, idempotent) edit a paid order's lines, adjustments, coupon and shipping.
  Stock deltas are reserved live, never cached. Adjustments are labelled +/- amounts in `order_adjustment`; each
  committed edit writes an `order_edit` row (before/after snapshot, balance, settlement). `order.shipping_override`
  marks a hand-set shipping amount. `PUT /v1/admin/orders/{code}/address` edits an address on any non-cancelled
  order. A balance is settled by refunding the difference, recording a manual payment, or emailing a pay link.
- **Balance payments**: `/pay`, NMI and Sezzle accept a Paid order with a positive amount due and charge only the
  balance. Payment status gains `balance_due` (filterable on the admin order list and export); the receipt-scoped
  `/orders/{code}` page on the storefront takes the balance payment. Edit refunds are tagged by the server-set
  `refund.metadata.source`, never the free-text reason, so they neither re-open the amount due nor claw points back twice.
- **Persisted shipping method** (migration 0086): `order.shipping_method_code` / `shipping_method_name`, also set by
  the Vendure importer. Orders created before it keep the order-edit inference fallback.
- **Loyalty bonus rules and program dashboard**: `store.config.loyalty` gains review, sign-up, first-order and
  birthday bonus points and per-product earn multipliers (all 0 / empty = off; `signupBonusSince` stops imported
  accounts qualifying retroactively). Bonus ledger rows (new `bonus` kind, migration 0085) carry a deterministic
  `source_ref` so a trigger pays once; `POST /v1/admin/loyalty/ledger/{id}/reverse` reverses a bonus without
  re-enabling it. Customers get optional `birth_month` / `birth_day`. Admin: settings for every field plus
  `GET /v1/admin/loyalty/summary` (issued, redeemed, outstanding, liability).
- **Product reviews** (migration 0085, `product_review`): `GET`/`POST /v1/shop/catalog/products/{slug}/reviews`
  (approved reviews plus rating aggregate; submissions are moderated, one per product per email). Admin queue at
  `/v1/admin/reviews` with approve/reject, public reply (`PUT /v1/admin/reviews/{id}/reply`) and
  `/v1/admin/reviews-settings`. Approval grants the review bonus. Product detail returns `productId`.
- **Storefront**: `/account/rewards`, PDP reviews (AggregateRating JSON-LD only when the count is above 0),
  earn-points notes from the store's loyalty settings, receipt-scoped balance-pay page.
- **Owner gaps**: affiliate stats by date range with per-SKU sales (`GET /v1/admin/affiliates/{id}/stats`);
  TipTap blog editor (lazy chunk); waitlist demand report + CSV (`/v1/admin/waitlist/report[.csv]`); sitemap
  preview/refresh and an SEO settings card (`/v1/admin/seo/sitemaps[/refresh]`); clear a customer's SheerID
  verification (`POST /v1/admin/customers/{id}/verification/clear`, new `customer_verification` staff permission;
  the legacy revoke route now requires it). Admin also gains the customer list counts fix, an order export dialog
  (date range, statuses, method, country, coupon, per-line rows, column presets), a manual tracking grid, CSV
  tracking import with preview, a shipping rule editor, auto-deliver run-now, accept-invite page,
  invoice/packing-slip buttons, a Stripe mode-switch error toast, and force-purge of a trashed paid order with a
  required reason.
- **Browser e2e suites**: admin (`packages/admin/e2e`, 13 specs / 54 `test()` blocks) and storefront
  (`packages/storefront/e2e`, 10 specs / 51 blocks). Each starts a throwaway API over a freshly created
  `sellright_admin_e2e` / `sellright_storefront_e2e` database on a non-superuser role and refuses
  non-e2e targets; CI jobs `e2e-admin` and `e2e-storefront`. Storefront money specs run mock NMI/Sezzle/IndexNow
  receivers and an SMTP sink.
- **Demo**: new visitor tenants start with points on at the product defaults and reviews on (no review rows are
  seeded); the demo policy allows the new owner features inside the visitor's own store (see `deploy/demo/README.md`);
  the demo admin helper understands the `/admin` mount (login hint, sidebar links, Export).

### Changed — BREAKING (pre-1.0 API consumers)

- Admin discounts API: the canonical route is now `/v1/admin/discounts`
  (`GET`/`POST`/`GET :id`/`PATCH :id`/`DELETE :id`), matching what the admin
  dashboard has always called this feature. `/v1/admin/promotions*` remains
  mounted as a deprecated alias (flagged `deprecated: true` in the OpenAPI
  doc, identical handler) for one release, then will be removed.
- Payment record wire state: an individual payment's `state` field (order
  detail endpoints, the public receipt, guest tracking) now reads lowercase,
  and `Settled` reads as `captured` instead — `pending`, `authorized`,
  `captured`, `declined`, `failed`. This is distinct from the new order-level
  `paymentStatus` above. The underlying `payment_state` Postgres enum and
  every internal read/write of it are unchanged.
- Admin dashboard label: "Tax Zones" is now "Taxes" (nav item, page title,
  empty state, delete-confirmation copy). The route path, API path
  (`/tax-zones`), and `TaxZone` type name are unchanged.

- Points & rewards (loyalty). Per-store program in `store.config.loyalty`
  (off by default): points earned per $1, points needed per $1 off, minimum
  redemption, optional maximum discount (% of subtotal) and optional expiry.
  Registered customers earn on the post-discount merchandise subtotal
  (never shipping or tax) when an order reaches Paid, once per order.
  Checkout accepts `redeemPoints` (signed-in only): re-validated under a
  per-customer lock, applied as a pre-tax discount, reserved on the order,
  released when an unpaid order is cancelled (including the stale-unpaid
  job) and restored/reversed in proportion to refunds. Balances are the sum
  of an append-only, FORCE-RLS `loyalty_ledger` (migration 0070); reversals
  the balance can't cover are recorded as shortfall, never a negative
  balance. Admin: Points settings page, per-customer balance/ledger, and
  `loyalty`-permission-gated manual adjustments (audited). Shop API:
  `GET /v1/shop/account/loyalty`, `loyalty` terms on `/v1/shop/config`,
  `pointsToEarn` on cart estimates. Storefront: account balance card,
  points-to-earn on cart totals, and a redeem control at checkout.
- Importer: store-credit balances (`account_credit`) become loyalty
  `import` entries at the target's `pointsPerDollarOff` (optional
  `loyalty` block in the migration config); `account_credit_discount` and
  discount + free-shipping multi-action promotions are recorded as counted
  exclusions instead of failing the run.

### Changed

- Malformed typed extensions on trial and activation requests return 400 `INVALID_REQUEST` instead of 500.
- NMI test profiles can use an existing merchant account on the production
  endpoint with per-transaction test mode. Endpoint identity is retained for
  replay, reconciliation and refunds.

- Web/admin favicons, touch icons, and manifest artwork now use the selected
  SellRight mark from the verified cross-platform asset kit.

### Fixed

- Stripe balance payments: the PaymentIntent idempotency key now carries the settled-tender count and a settled
  replay is skipped (a later edit raising the total by the same amount used to replay the earlier succeeded intent
  within Stripe's 24h window); `/pay` always namespaces the balance claim by settled-tender count; `/pay` no longer
  reports Settled for a failed or amount-mismatched intent on an already-Paid order.
- Admin: toggling a discount's enabled flag no longer applies schema defaults (it zeroed the value); the discount
  edit modal no longer shows stale values after save; admins with 2FA can sign in from the UI; customer detail
  includes tags so an edit no longer wipes them. `affiliate_payouts` was missing from `UI_PERMISSION_KEYS`.
- Storefront: the confirmation receipt poll aborts on unmount; CartService adopts only the latest snapshot (stale
  coupon/refresh responses could resurrect a removed coupon or a discarded cart); legacy `sr()` sends
  `sr_cust_csrf` for signed-in customers.
- Demo: the PDP reviews read was refused by the demo policy, so the reviews block hid itself; without a catalog
  manifest the PDP had no product id or rating (now taken from product detail and the reviews summary).
- Admin **Returns -> Approve**: the "Restock" choice is now honoured (`POST /v1/admin/returns/{id}/approve`
  accepts `restock`); it used to be silently dropped, so the flag set when the request was opened always won.
- Storefront **account**: a full page load of any `/account/*` page bounced signed-in customers to `/sign-in`
  (the server-side guard looked for a cookie name the API never sets); the address book could not add or
  edit an address (empty country list, missing name/phone fields, server-side write rejected by CSRF) and
  showed stale lists; the order detail page failed to render on a direct load (invalid `<div>` inside `<p>`);
  the bare `/orders/{code}` link in order emails was a dead end and now leads to the account order or the
  order-tracking lookup.
- NMI refund reconciliation requires successful matching refund evidence,
  rather than treating a known transaction reference as settlement.
- Gateway replay and verification reject endpoint changes with a controlled
  conflict response.
- Opt-in gateway tests require an explicitly named disposable database and
  independent single-use tokens for charge and refund acceptance.
- Container CI provides the required non-owner role password and empty gateway
  secret file.

- Postgres transactions no longer stay open while Stripe, SMTP, or APNs calls
  wait on the network. Payments and refunds use a cross-process advisory lock
  around short prepare/result transactions; outboxes use claim → send →
  conditional-finalize. This prevents the idle-transaction timeout from killing
  live commerce requests and keeps retry/idempotency behavior intact.
- Broken Postgres clients are evicted when rollback fails, while the original
  request error is preserved for diagnosis.

### Operations

- Postgres operations now enable `pg_stat_statements`, log queries over one
  second, and expose a repeatable top-query inspection loop before further
  tuning. The update-heavy email and push outboxes use lower per-table
  autovacuum thresholds to prevent queue bloat.
- Postgres connections now carry a deployment-specific `application_name`.
  The operator runbook defines database-qualified statement, lock, and
  idle-in-transaction timeouts and their verification queries.

## 2026-07-17

### Added

- Mobile-admin push delivery, including APNs device-token ownership and Live
  Activity payload support (`383b53c`, `bfac16a`).
- Order detail now exposes line IDs needed to construct per-line refunds
  (`7be6ad6`).

## 2026-07-05

### Added

- Self-service account deletion and export, SQL-compiled smart collections,
  server-authoritative shipping, and DB-backed route integration coverage.

### Security

- Stored HTML sanitization, newsletter and artifact-host SSRF defenses,
  CSRF/RBAC hardening, tenant RLS coverage, and safer error disclosure.
