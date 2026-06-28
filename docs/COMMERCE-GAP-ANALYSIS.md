# SellRight — Commerce Gap Analysis & Spec Sheet

> vs WooCommerce · Shopify (+Plus) · BigCommerce. Grounded in a code inventory of `packages/api` + `packages/admin` + `packages/storefront` and web research of each platform's best-selling plugins/apps. Generated 2026-06-19.

## TL;DR verdict

**The engine is strong; the growth-app layer and infra-at-scale are the gaps.**

SellRight's hard parts are genuinely well-built — arguably better-architected than WooCommerce and with a security posture comparable to Shopify's backend:

- **Server-authoritative pricing** at every layer (cart/checkout/draft) — client prices never trusted.
- **Postgres RLS multi-tenancy** with FORCE RLS on 40+ tables, non-owner role, startup assertion + test suite. This is the part most platforms *don't* have (Shopify is one-store-per-account; multi-store = Plus orgs).
- **Order FSM + idempotency + row-locks** on every money path; gateway-before-ledger refund invariant.
- **Dual-mode Stripe** done correctly (mode-bound webhooks, key/mode guards — from the recent hardening).
- **Native digital/license/download fulfillment + idempotent license issuance** — a category Shopify/Woo need paid apps for.

Where competitors win is **not the engine** — it's (1) the **growth/retention app ecosystem** (email/SMS, reviews, loyalty, subscriptions, upsell), (2) **operational breadth** (live shipping, automatic tax, multi-channel/POS), and (3) **infra for scale** (Redis, search index, CDN/signed URLs, cursor pagination).

**For RightApps specifically (digital software/license sales, multi-tenant), SellRight is _ahead_ of all three competitors** — and most of their "killer" gaps (carrier shipping, POS, marketplace sync) don't apply to you.

---

## ✅ Shipped since this analysis (updated 2026-06-20)

The 2026-06-19 snapshot below is now partly historical — these gaps have been closed (all committed; backend items box-verified):

- **Signed/tokenized download URLs** (Tier 1 #1) — artifacts served via expiring one-time tokens, not raw paths. ✅
- **Subscriptions / recurring billing** (Tier 1 #2) — Stripe Billing wired: subscribe → backing order → first `invoice.paid` issues the license via the existing settle path → renewals extend the entitlement; tenant resolved from our own subscription row (not metadata propagation); admin Subscriptions view + per-customer section + hosted Customer Portal. DB suite green (8 lifecycle cases). ✅
- **Stripe dispute/refund reconciliation** (Tier 1 #4) — `refund.*` + `charge.dispute.created` reconcile dashboard refunds + chargebacks into the ledger. ✅
- **Search GIN/trigram + customer_token index** (Tier 1 #5) — product search backed by a trigram index; the token index is restored. ✅
- **Server-authoritative cart lifecycle** — server cart with TTL + extend-on-activity, abandonment/cleanup jobs (abandoned carts preserved), lifecycle events, and checkout-reads-from-cart (fail-closed). ✅
- **Bulk order management** — cancel / trash (soft-delete) / restore / gated purge (cascade + a FK-coverage guard test that fails when a new FK to `order` is unhandled). ✅
- **Storefront ↔ SellRight REST** — the cloned DD Qwik storefront now resolves catalog/collections/cart/auth/account from `/v1/shop/*` (**runtime-verified against the live API with real products**); checkout (Stripe Elements) is in progress behind a `VITE_SR_CHECKOUT` flag.

Cursor/keyset pagination (Tier 2 #8) was scoped out for now (the codec was removed as YAGNI — re-add at the first list that needs it). The scorecard + roadmap rows below predate the above and are kept for the broader competitive picture; treat the items here as DONE.

---

## Scorecard at a glance

| Domain | Verdict |
|---|---|
| Multi-tenancy / store isolation | 🟢 **Ahead** (RLS-enforced; competitors don't do true multi-tenant) |
| Digital products / licensing / downloads | 🟢 **Ahead** (native; others need SendOwl/FetchApp/Easy Digital Downloads) |
| Affiliates | 🟢 **Ahead** (native + self-serve dashboard; others need an app) |
| Pricing/checkout correctness & security | 🟢 **Ahead/Parity** (server-authoritative, idempotent, RLS) |
| Core catalog (products/variants/options/collections) | 🟡 **Parity** (Vendure-class schema; UI gaps) |
| Orders/fulfillment/returns/refunds | 🟡 **Parity** (solid; missing exchanges, dispute reconcile) |
| Payments breadth | 🔴 **Behind** (Stripe+manual+COD only; no PayPal/wallets/BNPL) |
| Tax | 🔴 **Behind** (manual zones; no Avalara/auto-jurisdiction/VAT) |
| Shipping | 🔴 **Behind** (flat only; no live carrier rates/labels) |
| Email/SMS marketing & automation | 🔴 **Behind** (Listmonk proxy; no flows/abandoned-cart recovery) |
| Reviews / loyalty / subscriptions / upsell | 🔴 **Behind** (none native — the app-store money makers) |
| Multi-channel / POS / marketplace | 🔴 **Behind** (online store only) |
| Internationalization (multi-currency *settlement*, multi-language) | 🔴 **Behind** (currency presentment only) |
| Analytics/reporting depth | 🔴 **Behind** (dashboard + basic reports; no cohorts/LTV/attribution) |
| Infra scale (Redis/search index/CDN/cursor pagination) | 🔴 **Behind** (single-instance assumptions) |

---

## What merchants actually pay for (best-seller demand ranking)

The top-installed apps across all three ecosystems converge on the same categories — **this is the real "what people want" signal**. Ranked by cross-platform prevalence:

| Rank | Category | Representative best-sellers | SellRight today |
|---|---|---|---|
| 1 | **Email/SMS marketing + automation** | Klaviyo, Postscript, Attentive, Omnisend | 🟡 Listmonk proxy, no flows/recovery |
| 2 | **Reviews / UGC / social proof** | Judge.me, Loox, Yotpo, Okendo | 🔴 none |
| 3 | **Loyalty & rewards** | Smile.io, LoyaltyLion | 🔴 none (gift cards only) |
| 4 | **Subscriptions / recurring billing** | Recharge, Loop, Appstle, WooCommerce Subscriptions | 🔴 none (but license/update-pass model is 90% there) |
| 5 | **Upsell / cross-sell / post-purchase** | Rebuy, Zipify OCU, ReConvert | 🔴 none |
| 6 | **Page/landing builder** | PageFly, GemPages, Elementor Pro | ⚪ N/A (you own a code storefront) |
| 7 | **Shipping rates / labels / tracking** | AfterShip, ShipStation, Table Rate Shipping | 🔴 flat-rate only |
| 8 | **Automatic tax compliance** | Avalara AvaTax, TaxJar | 🔴 manual zones |
| 9 | **Helpdesk / support** | Gorgias, Re:amaze | 🔴 none (integrate, don't build) |
| 10 | **Bundles / kits** | Simple Bundles, Bundler | 🔴 none |
| 11 | **Memberships / access control** | WooCommerce Memberships | 🟡 license seats ≈ adjacent |
| 12 | **Wishlist** | YITH Wishlist | 🔴 none |
| 13 | **SEO** | Yoast, Rank Math | 🟢 deep JSON-LD/meta already |
| 14 | **Performance / caching** | WP Rocket | 🟡 no Redis/HTTP cache |
| 15 | **Security / firewall** | Wordfence | 🟢 RLS+CSRF+2FA already strong |
| 16 | **Marketplace channel sync** | Salestio, CedCommerce | ⚪ N/A for software |
| 17 | **Workflow automation** | Zapier, Shopify Flow | 🔴 none (webhooks are the seam) |

**Read:** categories 1–5 are where growth-stage merchants spend money and where you have nothing. Categories 6, 7, 16 mostly **don't apply** to a digital/multi-tenant software store. SEO + security (13, 15) you've already nailed.

---

## Where SellRight is AHEAD

1. **True multi-tenancy** — DB-enforced RLS store isolation. Shopify = 1 store/account; Woo = 1 site/install; BigCommerce multi-storefront is Enterprise-only. You run N stores in one DB safely.
2. **Native digital goods** — `fulfillmentType` ∈ {physical, digital_download, license, update_pass}, `license`/`licenseActivation`/`appRelease`/`downloadArtifact` tables, **idempotent license issuance** under concurrent webhook+checkout races. Shopify/Woo/BC all need paid apps (SendOwl, Easy Digital Downloads, FetchApp).
3. **Affiliates native** — paired promo code per affiliate, live commission tracking, settlement ledger, public self-serve dashboard. A paid app everywhere else.
4. **No platform transaction fee** — Shopify charges 0.5–2% unless you use Shopify Payments; you don't.
5. **Self-hosted email (Listmonk)** — no per-contact Klaviyo bill (the integration exists; flows are the gap).
6. **Security posture** — server-authoritative pricing, idempotency, FORCE-RLS, double-submit CSRF with timing-safe compare, from-scratch RFC-6238 TOTP, hash-only token storage, account-enumeration defenses. This is better than a default Woo install and on par with Shopify's backend discipline.

---

## Where SellRight is at PARITY

- **Catalog schema** — products, variants, option groups + per-variant assignment matrix, featured + gallery assets, smart (rule-based) collections, soft-delete, order-line snapshots. Vendure-class. (UI gaps below, not schema gaps.)
- **Order lifecycle** — draft/manual orders, fulfillment + tracking import, returns (RMA) + partial refunds, pre-orders, FSM-guarded transitions.
- **Inventory** — atomic stock reservation (no oversell), full movement ledger with reason codes, multi-location tables.
- **Promotions** — coupon + automatic discounts, gift cards + store credit with transaction ledger.
- **Webhooks (outbound)** — transactional outbox, `FOR UPDATE SKIP LOCKED`, HMAC signing, exponential backoff, stuck-row reaper. Genuinely well-engineered.
- **API contract** — 131 Zod-validated routes, code-first OpenAPI published at `/v1/openapi.json`.
- **SEO** — JSON-LD (Product/Offer/ShippingDetails/MerchantReturnPolicy/Org/WebSite/Blog/Breadcrumb), canonical + OG + Twitter meta, AI-training-block meta.

---

## Where competitors are AHEAD (the gaps, by domain)

### Payments
- No PayPal, no Apple/Google Pay wallets, no Buy-Now-Pay-Later (Klarna/Afterpay/Sezzle), no accelerated/one-click checkout. (Provider abstraction exists; only Stripe + manual + COD implemented. NMI/Sezzle are backlog notes.)
- **Saved payment-method vault** has a full schema (`paymentMethod` table) but **zero routes** — no save/list/charge-saved-card.
- Stripe `charge.refunded` / `charge.dispute.created` webhooks are **empty stubs** — dashboard refunds and chargebacks are not reconciled into the refund ledger.

### Tax & Shipping
- Tax: manual destination zones only. No Avalara/TaxJar, no automatic jurisdiction rates, no US economic-nexus tracking, **no EU VAT/MOSS for digital goods** (a real compliance gap if you sell software into the EU).
- Shipping: **flat-rate calculator only**. No weight-tiered, no live carrier rates (UPS/FedEx/USPS), no label purchase/printing, no rate shopping.

### Growth / retention (the app-store money makers)
- No **email/SMS automation flows** — Listmonk is connected but abandoned-cart recovery, welcome/post-purchase/win-back flows are not wired (the *data* is captured; the *job* isn't).
- No **reviews/UGC**, no **loyalty/rewards**, no **subscriptions/recurring**, no **upsell/cross-sell/bundles**, no **wishlist**.

### Channels / international / analytics
- Online store only — no **POS**, no **multi-channel** (Amazon/eBay/Google/social), no marketplace sync.
- **Currency presentment only** (display × rate) — no real multi-currency *settlement*, no multi-language storefront, no duties/import tax.
- Analytics = dashboard KPIs + top-products/revenue reports. No cohorts, LTV, attribution, funnels, or a query layer (Shopify has ShopifyQL).

### Catalog/admin UX (schema is fine; surfacing is thin)
- Smart-collection **rule editor is API-only** (must PATCH raw JSON).
- No **bulk operations** — no CSV product import UI, no bulk price/status/collection edits (only export exists).
- Admin product search filters **name only** — no vendor/type/tag/collection/price-range facets.
- **Metafields** stored but never surfaced in admin or storefront.
- Per-variant images + collection images: tables exist, **no UI**.

---

## Technical / infra scorecard (you asked specifically)

| Area | State | Verdict |
|---|---|---|
| **Database** | Postgres + drizzle, 28 versioned migrations with named intent, soft-deletes, jsonb metafields | 🟢 disciplined |
| **Multi-tenancy** | FORCE RLS on 40+ tables, non-owner app role, `withStore()` GUC, startup assertion + RLS test suite | 🟢 production-grade, ahead of field |
| **Indexing** | Indexes present (`0022_indexes`, `0028_licensing_indexes`) **but**: product search is `ILIKE` with **no GIN/trigram/FTS** (full scan); `customer_token(token_hash)` index is **commented out** despite a noted seq-scan risk | 🟡 gaps; cheap wins |
| **Redis / cache** | **None.** Rate-limiter is in-process `Map` (resets on restart, breaks across instances); job scheduler is `setInterval` with no distributed lock; no HTTP response cache | 🔴 single-instance ceiling |
| **API** | 131 routes, code-first OpenAPI + Zod on every body, single `/v1` (no versioning/deprecation path), REST only (no GraphQL, no public/partner API) | 🟡 solid contract, no ecosystem surface |
| **Pagination** | `OFFSET`-based everywhere; returns list hard-capped at 200; **no cursor/keyset** | 🟡 degrades at high page counts |
| **Connection pool** | `pg` defaults (max=10), untuned, no observability | 🟡 will queue under load |
| **Search** | `ILIKE` scan; no engine | 🟡 fine now, won't scale |
| **Jobs/queues** | `setInterval` scheduler (auto-deliver, release-stale, webhook-reaper), dry-run defaults | 🟡 works single-instance |
| **Assets/downloads** | sharp → WebP re-encode, magic-byte validation, 10MB cap; **local disk only, no S3/R2/CDN**; artifact downloads return **raw DB path with `no-store`, no signed URL/one-time token** | 🔴 **security + scale gap for a software store** |
| **Auth** | Argon/scrypt hashing, hash-only token storage, Google OAuth, RFC-6238 TOTP from scratch, password reset/verify with enumeration defenses | 🟢 strong |
| **AuthZ / roles** | 4 roles (owner/manager/staff/read_only) + per-action permissions framework — but **only `giftcards` + `webhooks`** keys are actually enforced; broader RBAC is wired but unused | 🟡 framework > coverage |
| **Audit log** | Orders, product/variant, stock adjustments | 🟡 **partial** — no customer/staff-role/settings/login audit |
| **CSRF / cookies** | Double-submit, timing-safe; `Secure` flag gated on `NODE_ENV==='production'` (breaks if deployed as `'staging'`) | 🟢 (one config footgun) |
| **Observability** | Not evidenced (no metrics/tracing/structured-log layer surfaced) | 🔴 unknown/absent |

---

## Prioritized roadmap — worth adding vs not (for RightApps)

Scored by **demand × effort × fit-for-digital-software-store**.

### Tier 1 — do soon (high ROI, on-brand for a software store)
1. **Signed/tokenized download URLs for artifacts** — *security*. Today downloads return a raw path; for a software store this is a piracy/leak vector. Add one-time/expiring tokens (or S3/R2 pre-signed). **High fit, medium effort.**
2. **Subscriptions / recurring billing** — your `update_pass` + `licenseDurationDays` model **is** subscriptions. Wire Stripe Billing for license renewals/seats. This is the single highest-leverage growth add for software. **Very high fit.**
3. **Abandoned-cart recovery + email flows** — the data is already captured and Listmonk is connected; you just need the *job* + flow templates (welcome, post-purchase, win-back, renewal-reminder). **Cheapest high-demand win.**
4. **Stripe dispute / refund webhook reconciliation** — close the two empty stubs so dashboard refunds + chargebacks hit the ledger. *Financial integrity.* **Low effort.**
5. **Search GIN/trigram index** + uncomment the `customer_token` index — *cheap perf*, removes acknowledged full-scan debt. **Low effort.**

### Tier 2 — scale & retention
6. **Reviews/UGC** — social proof for the app stores. Medium effort.
7. **Redis** — back the rate-limiter + job-lock + (optional) HTTP cache the day you go multi-instance. Unblocks horizontal scale.
8. **Cursor pagination** on orders/products/customers lists.
9. **EU VAT / digital-goods tax** — only if you sell software into the EU (MOSS/OSS). Real compliance, not optional there.
10. **CDN/object storage** (S3/R2) for assets + signed URLs (pairs with #1).
11. **Second payment method** — PayPal or wallets via the existing provider abstraction.

### Tier 3 — nice, lower priority for digital
12. Bundles, upsell/cross-sell, wishlist.
13. Loyalty/rewards (lower fit for software vs physical retail).
14. Bulk catalog ops + CSV import UI, smart-collection rule editor, metafield surfacing.
15. Expand audit-log coverage (customer/staff-role/settings/login) + broaden enforced RBAC keys.

### Skip / not worth it for RightApps
- ❌ Live carrier shipping rates + labels (digital goods)
- ❌ POS / in-person retail
- ❌ Multi-channel marketplace sync (Amazon/eBay/Walmart — N/A for software)
- ❌ Page/landing builder (you own the Qwik storefront in code — that's your model, not a weakness)
- ❌ Bookings/appointments (different vertical)

---

## One-line bottom line

> **SellRight is a world-class commerce _engine_ wrapped in a strong admin, missing the growth-app layer and scale-infra that competitors monetize separately. For a general merchant it's not a Shopify replacement (shipping/tax/channels/apps). For RightApps it already beats Shopify/Woo/BigCommerce on the things that matter to selling software — and the highest-value additions (signed downloads, subscriptions, email flows) are small because the foundations are already there.**

_Evidence: `.audit/spec-research.json` (full per-feature inventory with file:line + competitor sources)._
