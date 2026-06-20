# Subscriptions / recurring billing — design (#2)

> Status: **design for sign-off** — not built yet. Grounded in Stripe research (`.audit/stripe-research.json`). Approve / adjust the decisions, then I implement in the phases below.

## Why this is small for SellRight
The entitlement model already exists: `license` (`expiresAt`, `updatesUntil`, `seats`, `status`) + variant fields `licenseDurationDays` / `updatesDurationDays`, and idempotent license issuance on paid orders. Subscriptions add **(a)** recurring billing via Stripe, **(b)** a record linking our license to the Stripe subscription, and **(c)** a renewal → "extend the license" wire. We are not building a billing engine — Stripe is.

## Recommended architecture (Stripe Billing)

- **Use Stripe Billing, not a custom re-charge loop.** Built-in dunning (Smart Retries), SCA/3DS handling on renewals, and the hosted Customer Portal are worth the 0.5% Billing fee and save real engineering. (Research recommendation.)
- **Checkout Session (`mode: 'subscription'`)** for v1 — Stripe-hosted, handles SCA automatically, least custom UI. (Direct Subscriptions API later if we want a fully bespoke flow.)
- **`invoice.paid` is the single authoritative "they paid → extend entitlement" signal** — covers the initial charge and every renewal. Filter `invoice.billing_reason` (`subscription_create` vs `subscription_cycle`).
- **Mapping:** set `subscription_data.metadata = { storeId, licenseId, orderId }` at Checkout creation — it auto-propagates to every invoice's `subscription_details.metadata`, so each `invoice.paid` knows exactly which license to extend. (Subscription-item metadata does NOT propagate — only top-level.)
- **Test Clocks** (sandbox) to simulate full renewal + dunning cycles before go-live.

## Lifecycle → our actions (webhook)
| Stripe event | Our action |
|---|---|
| `checkout.session.completed` (mode subscription) | link `session.subscription` → our `subscription` row (status `incomplete`) |
| **`invoice.paid`** | **extend the license** (`expiresAt`/`updatesUntil` += interval), set sub `active`, bump `currentPeriodEnd`. The authoritative grant. |
| `invoice.payment_failed` | mark `past_due`, log; **do not revoke** (dunning in progress) |
| `invoice.payment_action_required` | flag SCA needed; surface the hosted-payment URL |
| `customer.subscription.updated` | sync status / `cancel_at_period_end` |
| `customer.subscription.deleted` | dunning exhausted / cancelled → set sub `canceled`, let the license lapse at `expiresAt` |

Never grant on `customer.subscription.created` (may be `incomplete`).

## Data model (one new table + small variant additions)
```
subscription:
  id, storeId, customerId, licenseId (nullable until first invoice), orderId,
  stripeSubscriptionId (unique), stripeCustomerId, priceId,
  status (incomplete|active|past_due|canceled), currentPeriodEnd, cancelAtPeriodEnd,
  createdAt, updatedAt   — RLS like every store-scoped table
```
Variant additions for a "recurring" product: `stripePriceId text`, `billingInterval text` (`month`|`year`) — or derive from a new `fulfillmentType` value. **Decision D3 below.**

## Decisions for you (defaults = my recommendation)
- **D1 — Billing vs custom:** ✅ Stripe Billing. (Recommended.)
- **D2 — Flow:** ✅ Checkout Session (`mode:subscription`) for v1; Subscriptions-API/custom-UI later.
- **D3 — Catalog model:** add `stripePriceId` + `billingInterval` to the variant and treat any variant with a `stripePriceId` as recurring — vs a brand-new `fulfillmentType: 'subscription'`. I recommend the **variant-fields** approach (less churn, composes with existing license fields). 
- **D4 — What a renewal extends:** `expiresAt` (access) and `updatesUntil` (update pass) both += one interval per paid cycle, driven by the variant's existing duration fields. (Recommended.)
- **D5 — Customer Portal:** include Stripe's hosted Customer Portal for self-serve cancel/update-card (one endpoint to create a portal session). Recommended.
- **D6 — Reuse the dual-mode Stripe (test/live) + the new webhook tenant-resolver** from #4 (subscription/invoice metadata carries storeId). Yes.

## Implementation plan (phased, each build+test+commit)
1. **Schema:** `subscription` table + variant `stripePriceId`/`billingInterval` + migration (hand-written `--custom`, snapshot stays aligned).
2. **Create flow:** `POST /v1/shop/orders/{code}/subscribe` (or a cart-checkout branch) → Stripe Checkout Session (mode:subscription, metadata) → return the hosted URL. Admin: set a variant's `stripePriceId`.
3. **Webhook:** extend the existing handler with the lifecycle table above; `invoice.paid` → extend license + upsert subscription row (idempotent by event.id + stripeSubscriptionId).
4. **Portal:** `POST /v1/shop/account/billing-portal` → Stripe portal session URL.
5. **Admin:** subscriptions list + status on the customer/order detail.
6. **Tests:** pure helpers (period-extension math, status mapping) unit-tested; lifecycle via Stripe Test Clocks on the box.

## Out of scope for v1 (flag for later)
Proration/plan-changes, usage-based/metered billing, multiple subscriptions per customer UI, tax-on-subscription (Stripe Tax).

---
**Approve (or tweak D1–D6) and I'll build phase 1→6, committing each.** This is the only one of the three that I gated on a doc — #1 (signed downloads) and #4 (refund/dispute reconcile) are already shipped.
