# RH Commerce Backend — Build Plan (Pass 2, from scratch)

**Decision (locked 2026-06-04):** Build the backend **from scratch**. No Medusa, no fork, no third-party base.

> **This is a PRODUCT, not just a migration.** End goal: a commerce backend Adrian can **sell / open-source and self-host**. Consequences that are now requirements, not preferences:
> - **Standard documented API** (OpenAPI) — not a TS-coupled tRPC API a buyer can't consume.
> - **Multi-store is a first-class feature** — a `Store` (tenant) entity, store-scoped data, an admin that manages multiple stores from one window. A single-store buyer just has one store.
> - **Clean install / config** — nothing hardcoded to Adrian's brands.
> - **License** = Adrian's choice later (he can pick permissive or fair-source; this is the independence he wanted).
>
> **Commerce scope = DD + RH.** **SS is dropped** — it's image-sharing, not e-commerce; its backend is a separate later track. DD + RH are distinct stores but **one admin manages both from a single window** (the Vendure-channel experience), via the multi-tenant `Store` model + store switcher. Dogfood on DD + RH; ship as a product.

> **The real feature spec lives in [`DD-CUSTOMIZATION-SPEC-v1.md`](DD-CUSTOMIZATION-SPEC-v1.md)** — an evidence-based read of every active DD plugin. The from-scratch backend must reach parity with those customizations (payment-provider abstraction, SheerID verified discounts, affiliate program, pre-order pricing, local-cart coupon preview, SSE cache-invalidation, order automation), not just generic commerce. Two corrections it forced: DD runs **NMI+Sezzle not Stripe**, and the current NMI code is **PCI SAQ-D (raw card data server-side)** — the rebuild tokenizes.

This is the concrete blueprint: stack, schema, the isolated money core, the API surface, the admin surface, and the build sequence. Stack picks below are sensible defaults stated for veto — say the word on any and I'll swap before we write code.

> **Dev corpus = a sanitized, isolated clone of DD's real data** (decided 2026-06-04). We build the backend, the importer, and the money core against a read-only dump of `vendure_db` (DD) loaded into a separate dev database — real catalog, real orders, real coupons/shipping/refunds. This makes the **cent-perfect parity gate available from day one** (diff our totals against DD's real stored order totals) instead of relying on synthetic cases.
>
> **Hard guardrail:** the dev backend points only at the clone, **never at live `vendure_db`**. Dump is sanitized (live Stripe keys + PII scrubbed) so a dev box can never charge a real card or email a real customer. Live DD is untouched until a real, gated cutover.
>
> **Launch order is deferred** ("we're only dating") — which store goes live on the new stack first (RH, pre-revenue and zero-risk; or DD) is decided later. RH remains the natural zero-stake first cutover, but it's not locked.

---

## 0. Pre-M0 de-risk spike (do this FIRST, before committing the plan)

A small throwaway spike to validate the single riskiest assumption — that a clean reimplementation can match Vendure's stored totals to the cent — *before* we bet the M3 gate on it.

- Take the sanitized DD clone, pick ~10 real orders spanning the messy cases, reconstruct their inputs.
- Write a minimal `calculateOrderTotals` and diff against Vendure's stored totals.
- **Outcome A — exact parity achievable:** confirm Vendure's rounding/tax rules; keep the 0-cent hard gate.
- **Outcome B — not exactly reproducible:** document Vendure's exact rounding (per-line vs per-doc, tax-inclusive handling) and either match it deliberately or define a tolerance + reconciliation policy. **Better to learn this in a day than at M3.**
- Also surfaces the **legacy-input coverage** question: if some old orders can't have inputs fully reconstructed, define the exception policy (exclude from fixtures, flag for manual check). This spike *is* the rollback/parity de-risk; its result tunes §8.

## 1. Stack (defaults — veto any)

_Revised post `/review-self` (2026-06-04): tRPC → Hono+OpenAPI (product needs a standard API; tRPC is a poor fit for a Qwik consumer and locks the API to TS)._

| Layer | Pick | Why this, not the alternative |
|---|---|---|
| Frontend | **Qwik** (SSR, TS) | **Locked — best for ecom, untouched.** Calls the backend from server loaders. |
| Server + API | **Hono + `@hono/zod-openapi`** + `hc` typed client | One tool = fast server + typed routes + **real REST/OpenAPI contract** (sellable, language-agnostic, documented) + typed client for the Qwik loaders & admin. Replaces both Fastify and tRPC. No GraphQL, no codegen-before-server, no NestJS ceremony. |
| Validation | **zod** | One schema shared across API ↔ money-core ↔ OpenAPI spec |
| DB / ORM | **Drizzle + Postgres** | **Postgres stays** — ACID + relational integrity + row-level locking is exactly what the money path needs; data already lives there. Drizzle is SQL-first so we write exact `SELECT … FOR UPDATE` + explicit transactions (Prisma hides the locking we must control; also no Rust query-engine binary to deploy). |
| Multi-tenancy | **`Store` entity + store-scoped rows + Postgres RLS** (defense-in-depth) | First-class multi-store as a product feature; RLS makes cross-store leakage impossible even with an app bug |
| Jobs | **BullMQ / Redis** | Already run Redis; emails, listmonk, exports, indexing go async |
| Catalog read path | **Static JSON manifest + SSE invalidation** | DD already does this (`catalog-manifest.service`): storefront reads pre-generated `shop-catalog.json` + per-product files from CDN, regenerated on product/stock events, SSE/`cacheVersion` triggers refresh. Browse = ~zero backend load. Keep it — drops the Vendure search-index workarounds since we own the schema. |
| Realtime | **SSE (Hono streaming)** | Server→client push for cache-invalidation (you already built this in DD), order-status, live stock. REST stays for everything else. |
| Payments | **`PaymentProvider` interface** — NMI (direct, **tokenized**), Sezzle (redirect→verify), Stripe (intents) | DD runs NMI+Sezzle, RH runs Stripe — payments must be pluggable, not one gateway. ⚠ **Tokenize** (NMI Collect.js/Vault) — never handle raw PAN (current DD code is SAQ-D; rebuild targets SAQ-A). |
| Admin | **React + Vite + Tailwind/Shadcn + TanStack**, multi-store switcher, CRUD scaffolded from the Drizzle schema | Manages DD + RH from one window; schema-driven scaffolding cuts the biggest solo-build cost |
| Money core | **pure functions, integer cents** | The only exhaustively-tested module; CRUD never touches totals |

---

## 2. Schema (~15 core tables + 3 infra)

Integer **cents** for every money column. UUID PKs. `created_at`/`updated_at` everywhere. Soft-delete (`deleted_at`) on catalog + customer.

**Tenancy (product-first)**
- `store` — id, slug, name, currency, default_tax_zone, config (jsonb). The tenant root.
- `admin_user_store` — admin_user_id, store_id, role  → which stores an admin can manage (DD + RH from one window).
- **Every store-scoped table carries `store_id`** (product, collection, customer, order, promotion, shipping_method, stock, …). **Postgres RLS** enforces `store_id = current_store` so an app bug cannot leak across stores. Assets and admin users can be shared or scoped per config.

**Catalog** (all store-scoped)
- `product` — id, slug (uniq), name, description, status(`draft|active`), featured_asset_id, deleted_at
- `product_option_group` — id, product_id, name (e.g. "Size")
- `product_option` — id, group_id, value (e.g. "L")
- `product_variant` — id, product_id, sku (uniq), name, **price** (cents), **sale_price** (cents, nullable), weight_g, enabled, deleted_at
- `variant_option` — variant_id, option_id (which options define this variant)
- `collection` — id, slug, name, parent_id (nullable, for nesting), description
- `collection_product` — collection_id, product_id, position
- `asset` — id, type, path/url, width, height, alt (images/galleries)
- `variant_asset` / `product_asset` — ordered galleries

**Customer & auth**
- `customer` — id, email (uniq), first_name, last_name, phone, **stripe_customer_id**, listmonk_subscribed_at, google_sub (nullable), password_hash (nullable for OAuth-only), email_verified, deleted_at
- `address` — id, customer_id, full_name, line1, line2, city, province, postal_code, country, phone, is_default_shipping, is_default_billing
- `session` — id, customer_id (or admin_user_id), token_hash, expires_at  (customer + admin sessions)
- `admin_user` + `admin_role` — id, email, password_hash, role, permissions(jsonb)

**Order & money**
- `order` — id, **code** (uniq, human), customer_id (nullable until checkout), **state** (FSM enum), currency, **subtotal / discount_total / shipping_total / tax_total / grand_total** (all cents), shipping_address (jsonb snapshot), billing_address (jsonb snapshot), placed_at
- `order_line` — id, order_id, variant_id, quantity, **unit_price** (cents snapshot at add), line_subtotal, line_discount, line_tax, line_total (cents), fulfilled_qty, refunded_qty
- `payment` — id, order_id, amount (cents), method, **stripe_payment_intent_id** (uniq), status, error_message
- `refund` — id, payment_id, order_id, amount (cents), reason, state
- `refund_line` — refund_id, order_line_id, quantity, amount (cents), restock(bool)
- `fulfillment` — id, order_id, state, tracking_code, carrier
- `fulfillment_line` — fulfillment_id, order_line_id, quantity
- `shipping_method` — id, code, name, calculator (jsonb: zones + rates), enabled
- `promotion` — id, code (nullable for automatic), type(`percentage|fixed|free_shipping`), value, conditions (jsonb), starts_at, ends_at, usage_limit, used_count, priority, exclusion_group
- `stock` — variant_id, on_hand, allocated  (available = on_hand − allocated)

**Infra (the safety rails)**
- `processed_event` — **id = Stripe event id (uniq)**, type, processed_at  → payment idempotency
- `audit_log` — id, actor, entity, entity_id, action, from_state, to_state, data(jsonb), at  → every order/payment/stock mutation
- `stock_movement` — variant_id, delta, reason, ref_order_id, at  → inventory audit trail

**DD-parity additions (from the customization spec)**
- `product_variant` extra cols: `sale_price`, `pre_order_price`, `is_pre_order`, `ship_date` (drive variant-pricing + search)
- `order` extra col: `is_pre_order`
- `customer` extra cols: `listmonk_subscribed_at`, `sheerid_verifications` (jsonb), `active_verifications` (text[]), `verification_metadata` (jsonb) → feed the `verified_customer` promotion condition
- `affiliate` — store_id, promotion_id (uniq), email, access_token (uniq), onboarded_at
- `affiliate_settle` — store_id, promotion_id, amount_cents, period_start_at, period_end_at, settled_at, tx_ref, notes
- `blog_post` — store_id, title, slug (uniq/store), excerpt, body, body_html, author_name, reading_time, featured_asset_id, tags, is_published, publish_date, seo_title, seo_description
- FSM gains a **`Refunded`** terminal state (reached when total refunded ≥ grand_total)

---

## 3. The money core (the only code that needs exhaustive tests)

A single module of **pure functions, no I/O**, called by services. CRUD never touches totals.

```
moneyCore/
  totals.ts        calculateOrderTotals(lines, shipping, promotions, taxConfig) → totals
  promotions.ts    applyPromotions(lines, promos) → adjusted lines  (priority + exclusion groups)
  tax.ts           calculateTax(lines, zone) → tax lines  (per-document rounding, locked, never mixed)
  refund.ts        computeRefund(order, requestedLines, restock) → refund ledger entries
  fsm.ts           transition(order.state, event) → newState | error   (explicit allowed-transitions table)
```

**Order FSM** (cart is client-side, never persisted as an order until checkout):

```
PendingPayment ─paid→ Paid ─fulfill→ PartiallyFulfilled ─fulfill→ Fulfilled
      │                  │                                            │
   cancel             refund                                       refund
      ▼                  ▼                                            ▼
  Cancelled        PartiallyRefunded ───────────────────────────► Refunded
```

**Inventory** is the one money-path piece that is *not* pure (needs the DB): `allocateStock(variantId, qty)` runs inside a transaction with `SELECT ... FOR UPDATE` on the `stock` row, decrements atomically, errors if `available < qty`. Optional soft-reserve + expiry for flash sales (skip for v1).

**Idempotency:** the Stripe webhook handler writes the event id into `processed_event` (unique constraint) **before** any side effect; duplicate delivery → constraint violation → 200 + no-op.

---

## 4. API surface — Hono + zod-openapi route groups (~40 ops)

Every route is a typed Hono handler with a zod schema; the schemas generate the OpenAPI spec and the `hc` typed client. **Versioned under `/v1`** (see §8). All shop/admin routes are store-scoped (§2 tenancy).

**GET/POST /v1/shop/catalog** — getProduct(slug), listProducts(filter/sort/page), search, getCollection, listCollections, getVariantStock, getGallery
**/v1/shop/cart** — validateCart (server re-prices + stock-checks), estimateTotal, validateCoupon
**/v1/shop/checkout** — createOrderFromCart, setShippingAddress, setBillingAddress, getShippingQuotes, setShippingMethod
**/v1/shop/payment** — getPublishableKey, createPaymentIntent, updatePaymentIntent, getPaymentStatus · **+ POST /v1/webhooks/stripe** (raw body, signature-verified, idempotent)
**/v1/shop/auth** — register, verifyEmail, login, logout, me, requestPasswordReset, resetPassword, changeEmail, changePassword, authWithGoogle, checkEmailExists
**/v1/shop/account** — listAddresses, createAddress, updateAddress, deleteAddress, listMyOrders, getOrderByCode, trackOrder
**/v1/shop/content** — submitContactForm, newsletterSubscribe  (blog → likely storefront-side, decide in M2)

**/v1/admin/*** — products CRUD, variants CRUD + stock adjust, collections CRUD, assets upload, orders (list/detail/transition/fulfill/refund), customers (list/detail), promotions CRUD, shippingMethods CRUD, stores (list/switch), adminAuth. Permission-checked via `admin_user_store.role`.

---

## 5. Build sequence (no time estimates — I report start/done + flag blockers)

**Scope = DD + RH only (SS dropped).** Dev/build runs against the **sanitized DD clone** throughout; which store goes *live* first (RH or DD) is deferred. Phased so the solo-operator surface is never "everything at once" — each milestone ships a working slice.

- **M0 — Skeleton.** Repo (`api/ admin/ storefront/ shared/`), **Hono + zod-openapi + Drizzle + Postgres**, CI (lint/typecheck/build/test), env/secrets, Stripe test keys, OpenAPI served at `/v1/openapi.json`.
- **M1 — Schema + tenancy + importer.** All migrations incl. `store` + `store_id` + **RLS policies** (§7). Build the read-only importer against the **DD clone**: stores, products, variants, options, collections, assets, customers, addresses, **orders + `stripe_customer_id`** (DD has real ones — this is also what feeds the parity fixtures). Importer is reusable for any store.
- **M2 — Catalog (read path).** Catalog routes + rebuild Qwik catalog/PDP/collection pages on the typed client. No money yet. Proves API + tenancy end-to-end on real DD catalog.
- **M3 — MONEY CORE + parity gate.** moneyCore pure functions + 100% unit tests. **Cent-perfect parity replay** against the DD clone's real stored order totals (§8 spec). ⛔ **Hard gate — no checkout code until synthetic suite is green AND DD replay diffs to zero cents.**
- **M4 — Checkout + payments.** createOrderFromCart → allocateStock (atomic) → Stripe PaymentIntent → signature-verified idempotent webhook → order FSM to Paid. Risky core, now on a proven money module.
- **M5 — Customers + auth.** Sessions, register/verify/reset, Google OAuth, addresses, account + order history.
- **M6 — Admin (thin → full).** **Thin first:** orders (list/detail/transition/fulfill/**refund**) + products/variants/stock — the operate-the-store essentials. Then collections, customers, promotions, shipping, multi-store switcher. Scaffolded from the Drizzle schema.
- **M7 — Jobs + observability.** BullMQ workers: order/shipping emails, listmonk sync, product/order export. Audit log + structured logging + Sentry/trace-id at the payment boundary.
- **M8 — First store live.** Point that store's Qwik storefront at the new backend; keep its Vendure instance as instant rollback. RH (pre-revenue) is the natural zero-risk first flip, but the order is deferred.
- **M9 — Second store live.** Same, on the proven stack. For DD specifically, re-run the cent-parity replay against current production data immediately before cutover, shadow-run, then flip with Vendure kept as rollback for a few weeks.

**Dependencies:** M1 RLS before any store-scoped route. M3 gates M4 (correctness before money moves). M4+M5+M6(thin) gate M8.

---

## 6. What does NOT carry over (scope relief)

Of the ~25 RH Vendure plugins, most are non-money and either port trivially or leave the backend:
- **Port as small services/jobs:** listmonk sync, contact-form, order-tracking, product/order export, SEO, audit.
- **Becomes a route, not a plugin:** Google OAuth (auth router), coupon validation (money core), custom shipping (shipping_method calculator), variant sale price (a column).
- **May leave the backend entirely:** blog (move to storefront content / a flat CMS).
- **Replaced by infra, not rebuilt:** cache-invalidation, stale-order-cleanup, order-dedup → handled by the FSM + idempotency table + a cron.

---

## 7. Tenant isolation — RLS mechanism (concrete)

Not just "RLS on." The spec:
- Every store-scoped table has `store_id uuid not null`. A Postgres policy per table: `USING (store_id = current_setting('app.current_store')::uuid)` for SELECT/UPDATE/DELETE, plus a `WITH CHECK` on INSERT. Tables get `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY`.
- The app connects as a **non-superuser, non-owner role** (RLS doesn't apply to owners) and sets `SET LOCAL app.current_store = $1` at the start of every request transaction, from the resolved store context (subdomain/host or admin store switcher).
- **Default-deny when unset:** if `app.current_store` is missing, `current_setting('app.current_store', true)` returns NULL and the `= $store` predicate yields no rows — a request without a resolved store sees nothing and can write nothing (fail-closed, never fail-open). **Pool safety:** `SET LOCAL` is transaction-scoped, so every request runs inside one transaction; with a transaction-pooling pgBouncer this is safe (no leakage of the setting across pooled connections).
- Migrations author the policies alongside the tables (Drizzle migration + raw SQL for policies).
- **Tests:** a cross-store leakage suite — seed two stores, assert every list/get/mutation with store A's context can never see or touch store B's rows, including via joins and aggregates. This suite is a CI gate.
- Background jobs/imports run with an explicit store context too (no ambient superuser bypass in app paths).

## 8. Parity gate + API versioning (the two missing specs Codex flagged)

**Cent-perfect parity replay (M3 gate):**
- **Fixtures = reconstructed inputs, not just outputs.** From each DD order, rebuild the *inputs*: order lines (variant, qty, the unit price as captured at order time), applied promotions/coupon codes, chosen shipping method, tax zone, customer group. Pair each with Vendure's stored `subtotal/discount/shipping/tax/grand_total` as the expected output. Cover the messy cases — multi-line, coupon, free-shipping, mixed tax, partial refund, sale-price variants. (Capturing historical unit prices matters: today's variant price ≠ the price at order time.)
- **Tolerance: 0 cents** on every total field. Any nonzero diff fails the gate.
- **Workflow:** `pnpm parity` runs all fixtures through `calculateOrderTotals`, prints a per-order diff table, exits nonzero on any mismatch. Wired into CI. Re-run against *current* DD data immediately before the DD cutover (M9).

**API versioning / backward-compat (sellable + self-hosted product):**
- Path-versioned: `/v1/...`. The OpenAPI spec at `/v1/openapi.json` is the published contract.
- Within `/v1`: additive-only changes (new optional fields/endpoints). Breaking changes → `/v2` with `/v1` kept during a deprecation window; deprecations announced via `Deprecation`/`Sunset` headers + changelog.
- The `hc` typed client and storefront pin a version. Self-hosters upgrade backend + storefront together within a major; the version contract is what makes the product safe to ship to others.

## 8b. Cutover safety, security baseline, reconciliation (money-moving hardening)

**Cutover rollback — the post-flip order problem.** Once a store is live on the new backend it takes real orders/payments that exist *only* there; a naive "flip back to Vendure" would strand them. Plan:
- Forward-only after a **soak window**: flip, watch closely; rollback is only "real" during the soak. To roll back during soak, **replay new orders into Vendure** via the importer in reverse (or, simpler, a short maintenance freeze at flip so the post-flip set is empty/tiny).
- Stripe is the source of truth for money: any order created post-flip has its PaymentIntent in Stripe regardless of which backend rolls back, so no charge is lost — only order *records* need reconciling.
- **One concrete runbook (not options):** (1) maintenance freeze on the store; (2) final delta import; (3) flip DNS/storefront to new backend; (4) soak window N hours with reconciliation jobs green; (5) if abort during soak → flip storefront back to Vendure + replay the (small, frozen) post-flip order set. **Rehearsed in staging before any production flip** (an M8 acceptance criterion).

**Auth / security baseline (product-grade):** admin auth = email+password + **TOTP MFA**; sessions httpOnly/secure, short-lived + refresh. **Rate limits** on auth, checkout, payment, and coupon routes. API auth schemes: customer session cookie (storefront), admin session (admin), and **scoped API keys per store** for the OpenAPI product surface. Webhook routes verify Stripe signatures. Secrets in env/secret store, never in the clone.

**Admin RBAC (define before M6):** roles `owner | manager | staff | read_only`, granted *per store* via `admin_user_store.role`. The **store switcher only lists stores the admin is granted** (server-enforced, not a UI filter) — switching sets `app.current_store` only if the grant exists; store resolution is a server trust boundary, never client-supplied.

**Store resolution trust boundary:** storefront store is derived from host/domain server-side; admin store is the switcher value validated against the user's grants. The client never asserts `store_id` directly on any mutation.

**RLS non-request paths:** webhooks resolve store from the event's order before opening the scoped transaction; uploads and BullMQ jobs carry an explicit `store_id` in their payload and set `app.current_store` at the top of their own transaction — no ambient/superuser bypass anywhere in app code.

**Reconciliation metrics (ongoing drift detection):** scheduled jobs that assert invariants and alert on drift — sum(order line totals) == order grand_total; stock on_hand/allocated vs movements ledger; Stripe charges/refunds vs local `payment`/`refund` rows; orders stuck in a state past threshold. Dashboards + alerts, not just logs.

**Rejected alternative (ADR note):** *strangler-fig / adapter behind a proxy* (replace Vendure endpoint-by-endpoint live) was considered and rejected for v1 — it requires running both systems against the *same* live data with a translation layer, which is more dangerous on the money path than building clean against a clone and doing a gated, soak-protected flip per store. Revisit only if a big-bang flip proves too risky for DD.

## 8c. Per-milestone acceptance criteria (done = …)

- **M1:** importer loads the full DD clone with zero FK violations; cross-store leakage test suite passes (CI gate).
- **M3:** synthetic money-core suite 100% green **and** DD parity replay diffs to **0 cents** on every fixture.
- **M4:** a test order goes cart→PaymentIntent→paid; a **duplicate webhook delivery produces exactly one** order/charge/fulfillment (idempotency test); oversell test (2 concurrent buyers, 1 unit) yields exactly one success.
- **M6 (thin):** an order can be viewed, fulfilled, and partially refunded from the admin, with the refund reflected in Stripe + the refund ledger.
- **M8:** store live on new backend; reconciliation jobs green for the full soak window; rollback runbook executed once in staging.

## 9. Open choices before M0

Stack + multi-store + API are locked (§1, §2). Launch order is deferred. Remaining:

1. **Repo shape** — single repo with `api/ admin/ storefront/ shared/` packages (recommended) vs separate repos.
2. **Where the dev backend lives** — local dev box against the DD clone first (recommended); promote to the VPS when there's something to host.
3. **License posture** (can wait) — permissive (MIT/Apache) vs fair-source (BSL/Elastic-style, blocks cloud resale). Decide before any public release, not before M0.

**Then M0 starts with two concrete first actions:**
- (a) Scaffold the repo skeleton (stack from §1).
- (b) Take a **sanitized read-only dump of `vendure_db`** (DD) → isolated dev clone DB. ⚠ Production read on the live DD store — needs your explicit go + agreement on the sanitize step (scrub live Stripe keys/secrets; hash customer emails/phones) before I run it.
