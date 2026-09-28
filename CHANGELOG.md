# Changelog — SellRight web, API, and admin

Notable changes to the SellRight commerce API, storefront, and desktop-browser
admin. The native iOS admin ships separately and is tracked in
[`ios/CHANGELOG.md`](ios/CHANGELOG.md).

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Every user-facing feature, fix, security change, or operational contract change
must update the matching changelog in the same push.

## [Unreleased]

### Added

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
    and facet-value scope conditions (`money/coupon.ts`'s existing condition
    vocabulary — no new shape introduced) and usage limits are now editable
    in the admin UI, including an edit flow for existing discounts (the API
    already supported all of this; only the UI was missing it).
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

- NMI test profiles can use an existing merchant account on the production
  endpoint with per-transaction test mode. Endpoint identity is retained for
  replay, reconciliation and refunds.

- Web/admin favicons, touch icons, and manifest artwork now use the selected
  SellRight mark from the verified cross-platform asset kit.

### Fixed

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
