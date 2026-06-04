# DD Customization Spec — what "my store, built in" actually means

Evidence-based inventory of every **active** DD Vendure plugin (read from `~/sites/damned/admin/src/plugins/` on the server, 2026-06-04). This is the real feature parity target for the from-scratch backend — the customizations Adrian wants native, not the generic commerce baseline.

> **Two corrections to earlier assumptions, from reading the code:**
> 1. DD payments = **NMI (primary) + Sezzle (BNPL)**, not Stripe. Rebuild needs a **payment-provider interface**.
> 2. **PCI: the NMI plugin handles raw card data (PAN/CVV/expiry) server-side** → current backend is SAQ-D scope. **Do not replicate.** Rebuild must tokenize (NMI Collect.js / Customer Vault) → SAQ-A. ⚠ **Decision needed.**

---

## Payments & verification

| Plugin | What it does | Rebuild | Architecture implication |
|---|---|---|---|
| **nmi-payment** | Primary card processor. `type=sale` → immediate `Settled` (no separate capture). Luhn + expiry + amount-integrity pre-checks. **Post-approval AVS/CVV policy:** if AVS=N/C or CVV=N → auto-reverse (void→refund fallback) + `manualReview` flag + CRITICAL log. `void`/`refund` retryable; sale `allowRetry=false`; unique `orderid` per attempt. | **Medium** | **PCI red flag — raw PAN server-side.** Tokenize in rebuild. Keep the AVS/CVV auto-reversal + manual-review logic — that's real fraud control. |
| **Sezzle** (BNPL) | Redirect flow: `createPayment` → Sezzle session → return `checkoutUrl`, state `Authorized`. Customer redirected; on return, storefront calls `verifySezzlePayment(orderCode)` → verifies `completed`+`approved`, captures if needed → `PaymentSettled`. Refund via `/v2/order/{uuid}/refund`. Token cached. | **Hard** | Two-step authorize→settle with a redirect handoff + a custom shop mutation. The **stale-order-cleanup cross-checks Sezzle** before cancelling (browser-close recovery) — must rebuild together. |
| **sheerid-plugin** | Military/first-responder/teacher/student/medical/senior verified discounts. SheerID webhook (HMAC-verified) → OAuth → fetch verification → write customer fields `sheerIdVerifications`/`activeVerifications`/`verificationMetadata` (1-yr expiry). Registers promotion condition **`verified_customer`**. Discount table: military/first-responder/medical 20%, teacher/student/senior 15%. | **Trivial** | Verification → customer attributes → promotion gating. ⚠ Current code exposes **two unauthenticated test/clear endpoints** — drop or guard in rebuild. |

**Payment-layer takeaway:** a clean `PaymentProvider` interface with `createPayment / settle / refund / void` + per-provider flow (direct-charge for NMI, redirect-verify for Sezzle, intent-based for Stripe on RH). Tokenized inputs only. Idempotency + AVS/CVV policy live above the provider.

---

## Pricing, promotions, shipping (money-path)

| Plugin | What it does | Rebuild | Money-path |
|---|---|---|---|
| **variant-pricing** | Custom unit-price strategy: `isPreOrder ? (preOrderPrice||listPrice) : (salePrice||listPrice)`. Pre-order beats sale. | **Trivial** | **Yes** — sets line unit price → subtotal/tax. Needs variant fields `salePrice, preOrderPrice, isPreOrder, shipDate`. |
| **custom-coupon-validation** (`validateLocalCartCoupon`) | Previews a coupon against the **client-side local cart** before an order exists. Validates promo: date window, `minimum_order_amount`, `customer_group`, **`verified_customer`** (SheerID), `containsProducts`, usage/per-customer limits (raw SQL on `order_promotions_promotion`). Computes preview discount (%/fixed/free-shipping). **Skips `hasFacetValues`** (deferred to server). | **Medium** | Preview only (no order mutation), but must **match server apply-time math** or storefront shows a number Vendure later rejects. Facet gap is known. |
| **custom-shipping** | `ShippingEligibilityChecker`: country allow/block list (`exclude` flag) + optional `subTotalWithTax` min/max range. | **Trivial** | Indirect — gates which methods (and free-shipping coupon) are eligible. Empty-country footgun. |

---

## Orders (FSM + ops automation)

| Plugin | What it does | Rebuild | FSM impact |
|---|---|---|---|
| **order-status** | Adds **`Refunded`** terminal state (reached when `totalRefunded >= totalWithTax`). Auto-flags `order.isPreOrder` on settle if any line is pre-order. | **Trivial** | **+1 state: `Refunded`.** |
| **order-tracking** | Guest order lookup by code+email (bypasses 2h token), in-memory rate limit 10/hr. `trackOrder(orderCode,email)`. | **Trivial** | none |
| **order-tools** | Admin: XLSX order export (multi-sheet), tracking CSV import (VeraCore quirks, carrier inference USPS/FedEx/UPS, fulfillment creation + `Shipped`), **auto-Delivered cron** (Shipped→Delivered after 10d). Virtual display states `Processing`/`Pre-ordered`. 6 admin GraphQL ops + dashboard UI. | **Medium** | uses existing states; adds operational automation |
| **order-deduplication** | Redis interceptor on `addPaymentToOrder`: dedup key `{customer}_{session}_{cartHash}`, `SET NX EX 120`, Lua atomic release → blocks double-charge. | **Medium** | the idempotency guard (maps to our `processed_event`/lock) |
| **stale-order-cleanup** | Hourly cron: cancel `ArrangingPayment`/`AddingItems` older than 30min; **Sezzle recovery** (check API before cancel, settle if completed); opt-in cascade hard-delete of old cancelled orders (ordered FK deletes in a txn). | **Hard** | the Sezzle recovery + cascade delete are load-bearing |

---

## Growth, content, infra

| Plugin | What it does | Rebuild | Note |
|---|---|---|---|
| **affiliate** | Coupon-based affiliate program. **Affiliate = a Promotion whose name contains an email** (auto-onboard). 48-char access token → self-serve dashboard `/affiliate?t=`. Commission = **10%** of settled-order subtotals. Manual `settleAffiliate` with server-recompute + cents-equality validation. | **Medium** | New tables **`affiliate`**, **`affiliate_settle`**. Onboarding-by-promotion-name is a convention to reproduce or redesign. |
| **cache-invalidation** | **SSE** stream `/api/cache-events` pushing invalidation to storefront + `cacheVersion` poll fallback + Cloudflare purge on product/variant/stock events. | **Medium** | **This is the existing SSE.** Depends on `CloudflareCacheService` + `CatalogManifestService` in `../services/` (not yet read). |
| **listmonk** | Auto-subscribe on `PaymentSettled` (guarded by `listmonkSubscribedAt`); `/newsletter-signup` REST (Turnstile+honeypot+rate-limit). Listmonk REST upsert. | **Trivial** | needs customer field `listmonkSubscribedAt` |
| **seo-plugin** | Sitemaps (products/collections/blog/index), JSON-LD (Product/Org/Website/Breadcrumb), robots.txt, **IndexNow** auto-submit on product change (10s debounce). | **Trivial** | hardcoded shipping/return JSON-LD → move to config |
| **search-extension** | Adds variant custom fields (`salePrice,preOrderPrice,shipDate,isPreOrder`) to search results (batched, no N+1). | **Trivial** | needs the variant fields |
| **blog** | Headless CMS: posts, publish scheduling, tags, SEO fields, TipTap, server-side `sanitize-html`, reading-time. CRUD admin + shop `blogPost(slug)`/`blogPosts`. | **Trivial** | table `blog_post` |
| **contact-form** | Double opt-in: submit → HMAC-signed verify link → `/verify-submission` (Redis NX idempotency) → emails. | **Medium** | HMAC + idempotency must port exactly |
| **auth-flow** | `checkCustomerEmail` (exists?) with honeypot + Turnstile + rate-limit. **No Google OAuth in DD** (RH has it). | **Trivial** | |
| **audit-plugin** | PCI payment audit logging (file-based): payment/refund/admin-access/suspicious-activity/reconciliation; thresholds (≥3 fails suspicious, >10× avg amount). | **Trivial** scaffold | real logic in `../utils/payment-logger.js` (not read) |

---

## Derived requirements for the rebuild

**Custom fields → real columns:**
- `product_variant`: `sale_price`, `pre_order_price`, `is_pre_order`, `ship_date`
- `order`: `is_pre_order`
- `customer`: `listmonk_subscribed_at`, `sheerid_verifications` (jsonb), `active_verifications` (text[]), `verification_metadata` (jsonb)

**New subsystems beyond generic commerce:** payment-provider abstraction (NMI direct + Sezzle redirect + Stripe intent); SheerID verification → promotion gating; affiliate program (2 tables); pre-order pricing/flagging; local-cart coupon preview; SSE cache-invalidation channel; auto-Delivered + stale-order automation; double-opt-in contact + newsletter.

**FSM additions:** `Refunded` terminal state; pre-order tagging; the Sezzle authorize→settle path.

**Shared infra to build first:** Redis (rate-limit + dedup pool), Cloudflare Turnstile verify helper, Cloudflare cache purge service, SSE manager, email handlers. (`../services/CloudflareCacheService`, `CatalogManifestService`, `../utils/payment-logger.js`, `redis-connection-pool.js` not yet read — read before finalizing those rebuild scopes.)

**Drop / fix in rebuild:** raw-card PCI exposure (tokenize); SheerID's two unauthenticated test/clear endpoints; hardcoded SEO shipping JSON-LD (→ config); in-memory rate limiters (→ Redis); `standard-payment` dummy handler left enabled in prod.

---

## Shared services & infra (read 2026-06-04)

**Confirmed live payment methods (DB `payment_method`):** `nmi`=enabled, `sezzle`=enabled, `standard-payment`=enabled (Vendure dummy — disable in prod).

### Read path = static catalog manifest + SSE (KEEP — it's the world-class pattern)
`catalog-manifest.service.ts`: the storefront reads **pre-generated flat JSON** (`shop-catalog.json` + per-product `products/<slug>.json` under `CATALOG_DIR`), NOT live API. Regenerated on `ProductEvent/ProductVariantEvent/CollectionModificationEvent` (debounced 3s/coalesce 10s) and `StockMovementEvent` (immediate). Atomic `.tmp`→rename writes. 5-min stock reconciler fixes search-index drift. SSE + `cacheVersion` tell the storefront to refetch; Cloudflare purge on change.
- **Rebuild:** keep static-catalog-generation + SSE invalidation as the canonical read path (browse = static files from CDN, ~zero backend load). The Vendure-internal workarounds (raw SQL for `priceWithTax`, search-index reconciler) **disappear** — we own the schema, generate the manifest from our own tables, no search-index to drift.

### PaymentProvider interface (locked)
```
interface PaymentProvider {
  requiresRedirect: boolean
  createPayment(ctx, order, amount, tokenizedInput): CreatePaymentResult   // NMI: charge→Settled; Sezzle: session→Authorized+checkoutUrl
  verifyReturn?(orderCode, ctx): { success, message }                       // redirect flows only (Sezzle verify→capture→Settled)
  cancel?(ctx, order, payment): CancelResult                                // NMI void; Sezzle DELETE /v2/order (ADD — missing today)
  refund(ctx, order, payment, amount): RefundResult                         // NMI by transactionId; Sezzle by sezzleOrderUuid
}
```
- Idempotency, AVS/CVV auto-reversal policy, and manual-review flagging live **above** the provider (shared), not per-gateway.
- **Tokenized inputs only** — NMI Collect.js/Vault; raw PAN never reaches the server (SAQ-A). Stripe (RH) uses PaymentIntents. Interface is extensible for future providers (Adrian: more gateways later).
- Fix: Sezzle client = singleton (token cache currently breaks per-call); add Sezzle cancel/void.

### Shared infra (build once, best-practice)
| Service | Keep | Improve in rebuild |
|---|---|---|
| `cloudflare-cache` (purge API) | fail-soft, dedup | add retry/backoff; chunk at 500 URLs/req |
| `redis-connection-pool` (ioredis singleton, namespaced) | namespace isolation, auto-pipeline | guard max namespaces |
| `redis-rate-limiter` (sliding window sorted-set) | fail-open, standard headers | **Lua script for true atomicity** (pipeline has a concurrency gap); singleton; x-forwarded-for key |
| `csrf-protection` (HMAC double-submit) | action-scoped, double-submit | **remove `'default-csrf-secret'` fallback** (throw if unset); use `crypto.createHmac`; one-time tokens for checkout |
| `payment-logger` (PCI audit, daily files) | dual-write, authCode never logged, IP hash | **sha256 IP hash** (djb2 today); async writes off hot path; actually wire retention/encryption (declared, not implemented); suspicious/reconciliation must also persist |
| `connection-monitor` + `health-monitor` | health checks | **consolidate to one** (health-monitor is superior); make GC threshold-based not random; try/finally on queryRunner |

**Catalog-manifest** is the one **Hard** rebuild here (debounce/coalesce state machine, atomic writes) — but simpler for us than for DD because we drop the Vendure-schema workarounds.
