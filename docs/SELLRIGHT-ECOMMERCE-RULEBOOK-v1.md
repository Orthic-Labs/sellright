# SellRight Ecommerce Rulebook v1

This document defines the deterministic commerce rules for SellRight. The goal is simple: every order is calculated from explicit inputs, in one fixed order of operations, with integer cents and stored snapshots. If the same inputs and rules are used, the result is identical every time.

This is not a parity document for Vendure, WooCommerce, Shopify, or Medusa. It is the SellRight rulebook. Legacy systems are useful references, but SellRight should not depend on their hidden behavior.

## 1. Core principles

1. All money is stored and calculated in integer minor units.
   - USD 12.34 is stored as 1234.
   - Never use floating point numbers for money.
   - Currency is set per order and never changes after order creation.

2. Every order calculation uses one canonical function.
   - No controller, payment provider, admin action, or job recalculates totals differently.
   - The canonical function returns a full breakdown: line subtotals, discounts, shipping, tax, and grand total.

3. Order snapshots are the source of truth after checkout.
   - Product prices, promotion rules, shipping rates, and tax config can change later.
   - Existing orders keep their captured unit prices, discounts, shipping, tax, and total.

4. Payment providers never define the order total.
   - SellRight computes the total first.
   - The provider only confirms payment, authorization, void, refund, or failure for that exact amount.

5. Rules should be explicit and boring.
   - If a rule matters to checkout, it belongs in this document or in a versioned config.
   - No hardcoded brand behavior belongs in the core product.

## 2. Price selection

Each variant has a base price and may have sale or pre-order pricing.

Price selection:

```ts
unitPrice =
  variant.isPreOrder && variant.preOrderPrice != null ? variant.preOrderPrice :
  variant.salePrice != null ? variant.salePrice :
  variant.price
```

Rules:

- Pre-order price overrides sale price.
- Sale price overrides base price.
- The selected unit price is snapshotted onto the order line.
- Later catalog price changes do not affect the order.
- A disabled or deleted variant cannot be purchased.

## 3. Cart validation

The storefront may keep a local cart, but the server validates it before checkout.

Validation rules:

- Every variant must exist, be enabled, and belong to the current store.
- Quantity must be a positive integer.
- The server ignores client-provided prices.
- The server reselects unit prices from current catalog rules.
- The server checks stock availability before order creation.
- Coupons are previewed against the cart but revalidated at checkout.

## 4. Line subtotals

Line subtotal:

```ts
lineSubtotal = unitPrice * quantity
```

Order subtotal:

```ts
orderSubtotal = sum(lineSubtotal)
```

Rules:

- Line subtotal is before discounts, shipping, and tax.
- Quantity changes always recalculate from the snapshotted unit price if the order already exists.
- A line total can never go below zero.

## 5. Promotion eligibility

A promotion must be eligible before it can apply.

Supported eligibility rules:

- Store scope
- Active date window
- Enabled status
- Coupon code match, if coupon-based
- Minimum order subtotal
- Customer group
- Verified customer status, such as SheerID
- Product or collection inclusion
- Product or collection exclusion
- Shipping country, state, or zone
- Usage limit
- Per-customer usage limit
- First-order-only
- Exclusion group

Rules:

- Promotion eligibility is checked server-side at checkout.
- Coupon preview must use the same eligibility rules as checkout whenever possible.
- If preview cannot evaluate a condition, checkout remains authoritative.
- Promotions do not apply to deleted, disabled, or out-of-store products.

## 6. Promotion application

Promotion application order:

1. Sort eligible promotions by priority.
2. Apply line/product promotions.
3. Apply order-level subtotal promotions.
4. Apply shipping promotions.
5. Enforce exclusion groups and non-stacking rules.

Rules:

- Only one promotion in the same exclusion group may apply.
- Higher-priority promotions win within an exclusion group.
- Product/line discounts apply before order-level discounts.
- Free-shipping promotions affect shipping only (see §7/§9 — zero the shipping amount, never also create a discount line, or it subtracts twice).
- Discounts cannot reduce a line, shipping amount, or order below zero.
- Fixed-amount discounts are capped at the remaining eligible amount.
- **Rounding is LINE-LEVEL (locked).** Percentage discounts round to whole cents per line, not on the order total. This attaches discounts cleanly to line snapshots, refunds, tax, and per-line ledgers, and matches how Vendure applies discounts today. The storefront coupon *preview* must use the same line-level rounding so preview == checkout.

Default rounding (per line):

```ts
lineDiscount = roundHalfUp(lineEligibleAmount * percentage)
discountTotal = sum(lineDiscount)
```

### v1 implementation scope (DD-compatible, not the full engine)

The stacking/exclusion/priority machinery above is the **forward architecture**, documented so the data model fits it. **v1 implements only what DD uses:**

- One coupon code per order (no stacking).
- Discount types: `order_percentage`, `order_fixed`, `free_shipping`.
- Eligibility subset DD actually uses: store scope, active window, enabled, coupon match, minimum subtotal, customer group, verified customer (SheerID), product/collection inclusion, usage + per-customer limits.
- No combinatorial promo engine until a store genuinely needs multi-promo stacking.

## 7. Shipping

Shipping methods are store-scoped and selected from eligible methods.

Eligibility rules:

- Method is enabled.
- Destination country/state/zone is allowed.
- Destination is not in a blocked zone.
- Cart subtotal is within min/max thresholds, if configured.
- Cart contains no shipping-incompatible items.

Shipping total:

```ts
shippingTotal = selectedShippingMethod.rate
```

Rules:

- Shipping is snapshotted onto the order.
- Free-shipping promotions set eligible shipping cost to zero.
- Free shipping does not change item subtotal or item tax basis unless the store tax config says shipping is taxable.
- A missing shipping method blocks checkout for physical goods.
- Digital-only carts may use zero shipping if the store enables digital fulfillment.

## 8. Tax

Tax mode is configured per store.

Default v1 tax mode:

- Tax-exclusive pricing.
- One store-level tax rate, default 0.
- Shipping taxable flag is configurable per store.

Tax-exclusive calculation:

```ts
taxableItems = discountedSubtotal
taxableShipping = shippingIsTaxable ? shippingTotal : 0
taxTotal = roundHalfUp((taxableItems + taxableShipping) * taxRate)
```

Tax-inclusive calculation, if enabled later:

```ts
includedTax = grossAmount - roundHalfUp(grossAmount / (1 + taxRate))
```

Rules:

- One tax mode applies to the whole order.
- Tax uses discounted amounts, not pre-discount amounts.
- Tax is snapshotted onto the order.
- Refund tax uses original order snapshots, not current tax config.
- External tax providers may replace the tax calculation, but must return a deterministic tax breakdown that is snapshotted.

## 9. Grand total

Grand total:

```ts
grandTotal =
  discountedSubtotal +
  shippingTotal +
  taxTotal
```

Where:

```ts
discountedSubtotal = orderSubtotal - discountTotal
```

Rules:

- Grand total must be greater than or equal to zero.
- Payment amount must equal grand total.
- If the payment provider reports a different amount, checkout fails or is flagged for manual review.
- **Free shipping is applied by setting `shippingTotal = 0`, never by adding a shipping discount to `discountTotal`.** Modeling it both ways double-subtracts it.

## 10. Inventory

Inventory is not pure math because it depends on database concurrency.

Stock model:

```ts
available = onHand - allocated
```

Allocation rules:

- Stock allocation happens inside a database transaction.
- The stock row is locked before checking availability.
- If available stock is less than requested quantity, checkout fails.
- Successful checkout increments allocated stock.
- Fulfillment can decrement allocated stock and/or on-hand stock according to the configured inventory model.
- Cancellation releases allocated stock for unfulfilled lines.
- Refund restock behavior is explicit per refund.

Default v1 behavior:

- **Allocate at order creation / payment attempt** (the order is created at checkout, so these coincide).
- **Release allocation on cancellation OR on timeout** — a scheduled job releases allocations from orders stuck in a pre-payment state past a threshold (DD's stale-order-cleanup pattern). This prevents abandoned checkouts from holding stock.
- Restock on refund only when the admin selects restock.

## 11. Order and fulfillment state machines

Two state machines: **order** (payment/refund/cancel lifecycle) and **fulfillment** (shipping lifecycle, on fulfillment records). Order *display* states for the UI are **derived** from both — they are not separate canonical states.

**Canonical order states (payment/refund lifecycle):**

```txt
PendingPayment
Paid
PartiallyRefunded
Refunded
Cancelled
```

**Fulfillment states (per fulfillment record — a fulfillment groups order lines + tracking):**

```txt
Pending
Shipped
Delivered
```

An order can have multiple fulfillments (split shipments). DD relies on this granularity — keep it; do not collapse to a single `Fulfilled`.

**Derived order display states** (computed, not stored as canonical):

- `Processing` — Paid, no fulfillment shipped yet (and not a pre-order)
- `Pre-ordered` — Paid, contains a pre-order line not yet past its `shipDate`
- `PartiallyShipped` / `Shipped` — some / all fulfillments Shipped
- `PartiallyDelivered` / `Delivered` — some / all fulfillments Delivered

Rules:

- Both machines use explicit allowed-transition tables. Every transition writes an audit log row.
- A fulfillment cannot be created/shipped before the order is `Paid` (or authorized, per store policy).
- A fulfillment may carry a tracking code + carrier; a scheduled job may auto-advance `Shipped → Delivered` after a configured age (DD's auto-Delivered-after-10-days), per store config.
- **Pre-order hold:** a fulfillment for a line whose variant has a future `shipDate` is held (not shippable) until that date. This is a fulfillment rule, not an order-state rule.
- `Refunded` is terminal when total refunded ≥ paid amount.
- `Cancelled` is terminal unless a specific admin recovery flow is added.

**Deferred to v2 (named, not silently omitted): order modification.** Editing a placed order (add/remove lines, take additional payment — Vendure's `Modifying` / `ArrangingAdditionalPayment`) is out of v1 scope. v1 orders are immutable after `Paid` except via refund/cancel.

## 12. Payments

Payment providers implement the same provider interface but may have different flows.

Provider types:

- Direct tokenized charge, such as NMI.
- Redirect authorize/verify/capture, such as Sezzle.
- Intent-based payment, such as Stripe PaymentIntents.

Rules:

- Raw card data never reaches SellRight servers.
- NMI must use tokenized input, such as Collect.js or Customer Vault.
- Payment creation is idempotent.
- Webhooks are signature-verified.
- Duplicate webhook events are no-ops.
- Provider responses are normalized into local payment states.
- Provider metadata is stored, but provider-specific fields do not define the core order model.
- AVS/CVV risk signals are stored when available.
- Shared fraud policy may void, reverse, refund, or flag manual review based on normalized provider signals.

## 13. Refunds

Refunds are ledger entries against the original payment and order snapshots.

Refundable amount:

```ts
refundableAmount = paidAmount - alreadyRefundedAmount
```

Rules:

- A refund cannot exceed the remaining refundable amount.
- Partial refunds reference specific order lines when possible.
- Refund tax is based on the original line tax snapshot.
- Refund shipping is explicit.
- Restock is explicit per refunded line.
- Provider refund success writes a local refund ledger entry.
- Local refund state must reconcile with the provider.

## 14. Idempotency and retries

Idempotency rules:

- Every external payment event has a unique processed-event record.
- The processed-event record is written before side effects.
- Duplicate events return success and perform no side effects.
- Checkout payment attempts use idempotency keys.
- Retryable provider failures may retry safely.
- Non-retryable provider failures must not create duplicate charges.

## 15. Store scope and tenancy

Rules:

- Every store-scoped row has `store_id`.
- Storefront store context is resolved server-side from host/domain.
- Admin store context is resolved from the authenticated user's store grants.
- The client never directly asserts trusted `store_id` on mutations.
- Postgres RLS enforces store isolation as defense-in-depth.
- Background jobs, imports, uploads, and webhooks run with explicit store context.

## 16. Customer and account rules

Rules:

- Customer email uniqueness is per store unless global accounts are explicitly enabled.
- Guest checkout is allowed only if enabled per store.
- Guest order tracking requires order code plus matching email.
- Password reset and email verification tokens are single-use and expire.
- OAuth accounts may exist without a password hash.
- Customer deletion is soft-delete by default to preserve order history.

## 17. Affiliate rules

Default DD-compatible model:

- An affiliate may be linked to a promotion.
- Affiliate commission is calculated from settled eligible order subtotals.
- Default commission is 10 percent unless store config overrides it.
- Settlement is manual by default.
- Settlement recomputes from orders and validates against the requested amount.

Rules:

- Affiliate commission does not include tax or shipping unless configured.
- Cancelled, unpaid, refunded, or fraud-reversed orders are excluded.
- Partial refunds reduce eligible commission.
- Settlement writes an immutable settlement record.

## 18. Content and cache invalidation

Rules:

- Catalog read path may use static JSON manifests.
- Product, variant, collection, asset, and stock changes invalidate catalog cache.
- Cache invalidation is best-effort but versioned.
- Storefront can use SSE to refresh when cache version changes.
- Static manifest writes are atomic.

## 19. Reconciliation rules

Scheduled reconciliation should verify:

- Sum of order lines equals stored subtotal and totals.
- Payment provider charges match local payment rows.
- Provider refunds match local refund ledger.
- Stock availability matches stock movements and allocations.
- Orders are not stuck in transitional states past configured thresholds.

Rules:

- Reconciliation alerts on drift.
- Reconciliation does not silently mutate money records without an explicit repair job.
- Repair jobs write audit logs.

## 20. Configuration rules to decide per store

These are valid store-level choices, but each order must snapshot the effective choice.

- Currency
- Tax mode
- Tax rate or tax provider
- Whether shipping is taxable
- Rounding mode
- Promotion stacking policy
- Guest checkout enabled
- Digital goods enabled
- Inventory allocation timing
- Payment providers enabled
- Fraud/manual-review thresholds
- Affiliate commission rate
- Newsletter/listmonk behavior
- Cache/CDN behavior

## 21. Implementation rule

The code should reflect this structure:

```txt
money/
  price-selection.ts
  totals.ts
  promotions.ts
  shipping.ts
  tax.ts
  refunds.ts
  fsm.ts
  rounding.ts
```

The checkout service calls the money module. The money module does not call the database, payment providers, email, queues, or HTTP clients.

The only exception is inventory allocation, which belongs in a transactional service because it requires row locks.
