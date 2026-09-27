# Changelog — SellRight web, API, and admin

Notable changes to the SellRight commerce API, storefront, and desktop-browser
admin. The native iOS admin ships separately and is tracked in
[`ios/CHANGELOG.md`](ios/CHANGELOG.md).

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Every user-facing feature, fix, security change, or operational contract change
must update the matching changelog in the same push.

## [Unreleased]

### Added

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
