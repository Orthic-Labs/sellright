# SellRight — Architecture, Open Decisions & Roadmap (v1)

> **What this is.** A living snapshot of SellRight *as built* (2026-06-05), the
> decisions still open (with full context + a recommendation for each), and what
> belongs in v2 / later. The pre-build planning docs (`ARCHITECTURE-PLAN-v1`,
> `BUILD-PLAN-RH-v1`, `DD-CUSTOMIZATION-SPEC-v1`) describe intent; **this doc
> describes reality and the road ahead.** On conflict, this doc wins for
> "what exists today"; the **`SELLRIGHT-ECOMMERCE-RULEBOOK-v1`** wins for
> "how commerce must behave."

---

## 0. One-liner

A from-scratch, self-hostable, multi-tenant commerce backend (TypeScript · Hono ·
Drizzle · Postgres) replacing Vendure, with a typed REST API, a thin
Shopify-style admin SPA, and a Qwik storefront. Dogfooded on **Damned Designs
(DD)** and **Rotten Hand (RH)**; intended to become a sellable / open-source
product.

### Locked decisions & non-goals (do not re-litigate)

These are settled; they're recorded here so reviewers don't keep surfacing them
as "missing alternatives":

- **From-scratch, NOT a fork/framework.** Medusa (tried pre-Vendure, bad
  experience), Saleor, Shopify, and "fork/freeze Vendure" were all explicitly
  rejected. Rationale: full control of the data model, the money path, the
  multi-tenant model, and licensing; the goal is a *product we own and can sell*,
  not a customization of someone else's. This is final.
- **Monorepo-modular, NOT microservices / NOT composable.** One deployable API
  with clean internal module boundaries. A solo operator does not pay the
  microservices ops tax for this traffic. *Endorsed by current research, not just
  preference:* the 2025–2026 "composable regret" correction shows mid-market
  composable TCO running 100–200% higher and full-microservices multiplying
  backlogs without platform-engineering maturity (`docs/research/ecom-backend-research-2026-06.md`
  §2). Revisit only if one component needs independent scaling — extract-on-
  evidence, never by default.
- **Frontend = Qwik** (best-for-ecom, locked). **API = typed REST (Hono +
  zod-openapi)**, not GraphQL/tRPC.

---

## 1. Current architecture

### 1.1 Monorepo layout

```
sellright/                      pnpm workspace
├── packages/
│   ├── shared/   @sellright/shared    integer-cents money primitives
│   ├── api/      @sellright/api       Hono + zod-openapi + Drizzle (THE backend)
│   ├── admin/    @sellright/admin     React+Vite admin SPA   [excluded from workspace]
│   └── storefront/                    cloned DD Qwik app      [excluded from workspace]
└── docs/
```

`admin` and `storefront` are **excluded from the pnpm workspace**
(`!packages/*`) — each manages its own lockfile/toolchain so their frontend deps
can't disturb the `api`/`shared` build. Install them with
`pnpm install --ignore-workspace`.

### 1.2 Stack by package

| Package | Stack |
|---|---|
| `shared` | TS, integer-cents money helpers (pure) |
| `api` | Hono 4 + `@hono/zod-openapi` (typed REST → OpenAPI contract + `hc` client, **no GraphQL/tRPC**), Drizzle ORM, `pg`, zod, scrypt auth |
| `admin` | React 18, Vite 5, TypeScript, Tailwind 3, TanStack Query 5, react-router 6, lucide-react. Hand-rolled fetch client (not `hc`) |
| `storefront` | Qwik (cloned DD storefront), Vite SSR |

### 1.3 Data model (37 tables, by domain)

- **Tenancy:** `store` (registry), `admin_user`, `admin_user_store` (ACL),
  `session` (customer + admin sessions share the table, discriminated by
  `customer_id` / `admin_user_id`).
- **Catalog:** `product`, `product_variant`, `product_option_group`,
  `product_option`, `variant_option`, `collection`, `collection_product`,
  `asset`, `product_asset`, `variant_asset`.
- **Customer:** `customer`, `address`, `payment_method` (gateway vault refs).
- **Orders & money:** `order` (→ `promotion_id`), `order_line` (with snapshot
  cols), `payment`, `refund`, `refund_line`, `fulfillment`, `fulfillment_line`.
- **Inventory:** `stock` (on_hand/allocated), `stock_movement`.
- **Promotions/shipping:** `promotion`, `promotion_usage` (per-customer usage
  ledger), `shipping_method`.
- **Cart (separate from orders):** `cart`, `cart_line`.
- **DD-parity:** `affiliate`, `affiliate_settle`, `blog_post`.
- **Infra:** `processed_event` (idempotency), `audit_log`.

All six M:N link tables (`variant_option`, `collection_product`,
`product_asset`, `variant_asset`, `fulfillment_line`, `refund_line`) now carry
`store_id` + FORCE RLS (migration 0009) — isolation no longer rides on the parent
FK alone. See §1.14 for the full relationship review.

Money is **integer cents** everywhere. PKs are UUID. Column names are
`snake_case` (Drizzle `casing: 'snake_case'` set in **both** `drizzle.config.ts`
and the runtime `drizzle()` in `db/client.ts` — missing either breaks runtime
queries).

### 1.4 Multi-tenancy & RLS (the core safety model)

- Every store-scoped table carries `store_id` and has **`FORCE ROW LEVEL
  SECURITY`** with a policy keyed on `current_setting('app.current_store')`,
  hardened fail-closed via `nullif(...,'')::uuid` (migration 0002) — unset
  context ⇒ zero rows, never all rows.
- **Registry/ACL tables are `NO FORCE`:** `store` (0004) and `admin_user_store`
  (0006), because they must be read *before* a store context exists (host→store
  resolution; admin's store list for the switcher).
- **`withStore(storeId, fn)`** (`db/client.ts`) is the single entry point for
  store-scoped work: opens a txn, `SET LOCAL app.current_store`, runs `fn`. All
  handlers wrap their data access in it.
- The unscoped `db` client is used only for migrations, the admin
  registry/session lookups (cross-store by design), and jobs that set their own
  context.

**Audited 2026-06-05: isolation holds.** The admin `x-store-slug` header is
*not* attacker-controllable — `requireStore()` matches the slug against the
admin's own ACL and 403s otherwise; `storeId` comes from the matched ACL row,
never the raw header. (See §3 "DB runtime role" for the one latent caveat.)

### 1.5 Request lifecycle

1. Resolve store: `x-store-slug` header (dev default `damned`) → `resolveStore()`
   against the `store` registry. Admin routes additionally check the slug
   against the caller's ACL.
2. Auth: bearer token → `resolveCustomer()` / `resolveAdmin()` (SHA-256 token
   hash lookup, TTL + expiry checked).
3. `withStore(store.id, tx => …)` runs the handler under RLS.
4. zod-openapi validates request + response shapes and generates the OpenAPI
   contract at `/v1/openapi.json`.

### 1.6 Money & order state

- `money/totals.ts` — pure, tested, **line-level rounding** (per-line % then
  round; storefront preview must match).
- `money/fsm.ts` — order **payment** lifecycle:
  `PendingPayment → Paid → {PartiallyRefunded → Refunded | Cancelled}`.
- **Shipping state is a separate axis** on `fulfillment` records
  (`Pending → Shipped → Delivered`); `order.state` does **not** change on
  shipment. Display state is derived from both.

### 1.7 Catalog read path: static manifest + dynamic REST

- **Browse (static):** `manifest/generate.ts` reads the SellRight catalog and
  writes `shop-catalog.json` + `products/{slug}.json` to
  `CATALOG_DIR=/home/vendure/sites/sellright-data`, in the format the cloned
  storefront already understands. Home/shop/PDP SSR off these files.
- **Dynamic (cart/checkout/auth/account):** live REST under `/v1/shop/*`.

### 1.8 Cart (deliberately separate from orders)

`cart` / `cart_line` exist for persistence, cross-device recovery, and
abandonment analytics — **never shown as orders**. The storefront keeps a snappy
local cart and syncs here. An `order` is created from a cart only at checkout
(`cart.converted_order_id` links the two). This fixes Vendure's
cart-is-an-order-in-`AddingItems` backend crowding.

### 1.9 Payments

`payments/provider.ts` defines a **`PaymentProvider`** interface. Implemented
today: `manual` and `cod` (credential-free, for e2e). Real gateways
(NMI / Sezzle / Stripe) plug into the same interface — **deferred, blocked on
sandbox creds** (§3.1). Payments are idempotent via `processed_event`; the
provider confirms the exact amount SellRight computed (provider never defines
the total).

### 1.10 Admin (API + SPA) — full Shopify-parity (built 2026-06-05)

The admin API is split into per-domain route files sharing `admin-helpers.ts`
(auth/role guards, `guard()`, zod fragments): `admin.ts` (auth, dashboard, orders
list/detail/fulfill/cancel, products, variants, customers), `admin-catalog.ts`
(product/variant create+delete, collections, inventory), `admin-orders.ts`
(refunds, draft orders, abandoned carts, CSV order export, tracking CSV import),
`admin-marketing.ts` (promotions CRUD + Listmonk), `admin-settings.ts` (store/tax,
payments, shipping methods, staff+roles, notifications, Google client id, 2FA),
`admin-reports.ts` (customer write, sales/top reports, global search, activity),
`admin-affiliate.ts` (affiliate program + public dashboard), `admin-content.ts`
(blog). Store-scoped via `withStore`; mutations write `audit_log`; RBAC via
`requireWrite` (read_only blocked) + `requireManage` (owner/manager for
settings/staff).

**SPA** (`packages/admin`, ~24 pages, ~89 KB gz): Shopify-style light theme, store
switcher, global search. Nav: Home, Orders (+ New/Import-tracking/Export/Pre-orders/
Abandoned), Products (+ create), Collections, Inventory, Customers (+ create/edit/
tags), Discounts, Affiliates, Marketing (Listmonk), Blog, Reports, Activity,
Settings (store/tax, payments, shipping, staff/roles, Google sign-in, **2FA**).

**Auth (see §1.10a):** httpOnly cookie session + CSRF; no token in localStorage.

### 1.10a Authentication & session security (built 2026-06-05)

- **Passwords:** scrypt, per-user salt, constant-time compare (`auth/password.ts`).
- **Sessions:** opaque 256-bit token, only its SHA-256 hash stored (`session`
  table; admin 14 d / customer 30 d TTL). A DB leak yields no usable tokens.
- **Admin transport = httpOnly cookie** (`auth/cookies.ts`): `sr_admin` (httpOnly,
  SameSite=Lax, Secure in prod) + a non-httpOnly `sr_csrf` cookie. `requireAdmin`
  accepts the cookie OR a bearer header (API clients unaffected). **No admin token
  in localStorage** — XSS can't read it.
- **CSRF** (`app.ts` middleware on `/v1/admin/*` mutations): double-submit —
  `x-csrf-token` must equal the `sr_csrf` cookie; bearer requests exempt; login/
  logout exempt.
- **Admin 2FA (TOTP, RFC 6238, no dep — `auth/totp.ts`):** `/2fa` setup/enable/
  disable; login returns `twoFactorRequired` then needs the 6-digit code.
- **Login rate-limiting** (`auth/rate-limit.ts`): 8 fails / 15 min per ip+identity
  → 429; admin + customer.
- **Customer Google sign-in** (`/v1/shop/auth/google`): verifies the GIS ID token
  via Google tokeninfo + `aud` check; upsert by `google_sub`. Client id in admin
  Settings (`store.config.googleClientId`) or `GOOGLE_CLIENT_ID` env.
- **RBAC:** `owner / manager / staff / read_only`.
- **Still open:** storefront (customer) still uses bearer-in-localStorage (migrate
  to cookies); password-reset + email-verification enforcement (needs SMTP); CSP
  on the prod admin host.

### 1.11 Storefront

Cloned DD Qwik app. **Browse + checkout→COD→confirmation are wired to SellRight**
(`utils/sellright.ts` REST client; `placeOrder` short-circuits to
`srCreateOrder`+`srPayOrder('cod')`). Still on Vendure GraphQL: **auth, account,
text-search** (those UI flows fail until rewired — §3.9).

### 1.12 Dev / deploy environment

- **Code + DB live on Hetzner** (`/home/vendure/sites/sellright`); the laptop
  clone (`D:\Claude\sellright`) is secondary, synced via git push/pull.
- **DB = native (non-docker) Postgres 17.10 on port 5433** (docker
  `vendure-postgres` owns 5432). DB `sellright_dev`, role `sellright`.
- **Ports on the box:** API `:3300` · storefront SSR `:4100` · admin SPA `:4300`
  · **`:4200` = Stunning Strangers prod store — do not touch.**
- **No CI** (out of hosted minutes, deliberate). Gate = run `pnpm verify`
  (build + typecheck + RLS test) by hand before pushing.
- Ops scripts (`packages/api/scripts-deploy/`): `deploy-admin.sh`,
  `start-admin.sh`, `restart-and-test.sh`. **Robust API restart must
  `pkill -f src/index.ts` + `fuser -k 3300/tcp`** (a `pgrep|head -1` kills the
  pnpm wrapper, not the node server → old code keeps the port). psql reads of
  RLS tables need `set app.current_store='<uuid>'` first.

### 1.13 Imported data (parity verified)

Full DD `vendure_db` → `sellright_dev`: 31 products / 91 variants / 107 assets;
8,233 customers / 7,810 addresses; **13,481 orders / 21,387 lines / 13,538
payments**. **Cent-perfect:** imported `grand_total` sum **$852,930.51** ==
Vendure's stored `subTotalWithTax + shippingWithTax`. (The historical "$2M
cumulative" is the pre-Vendure WordPress era, not in this DB.) `order_line` got
snapshot columns (`variant_sku`/`variant_name`, nullable `variant_id`) because
93% of historical lines reference since-deleted products.

---

### 1.14 Data-model relationship review (2026-06-05)

A full pass over every FK/relationship. **What's strong (keep):** order-line
snapshots (survive product deletion), address-as-jsonb-snapshot on the order,
payment/refund/fulfillment as independent records (two-axis money-vs-shipping
state), cart split from orders, integer-cents money, RLS on every data table.

**Gaps fixed (migration 0009 + code, verified live):**
- **Promotions had no order linkage and no usage ledger** — worse, *checkout
  ignored coupons entirely* (orders were created at full price even when the cart
  preview showed a discount). Fixed: `order.promotion_id` FK + `promotion_usage`
  ledger; checkout now re-validates the coupon server-side, applies the discount,
  records usage, bumps `used_count`, and **enforces `usage_limit` +
  `per_customer_usage_limit`**. Verified: `bigred` → discount applied,
  `promotion_usage` row, counter incremented.
- **Address shape inconsistency** (`street_line1`/`country_code` in the order
  jsonb vs `line1`/`country` in the `address` table) — fixed: the order snapshot
  is normalized to the canonical `address`-table shape on write (accepts either
  input shape). Admin reader stays tolerant for legacy imported orders.
- **Link tables lacked `store_id`/RLS** — fixed: all six now carry `store_id` +
  FORCE RLS (defense-in-depth; `pnpm verify` asserts 34 store-scoped tables FORCE).
- **Loose FKs tightened** — `collection.parent_id` (self-ref), `stock_movement.ref_order_id`, `session.customer_id` now have FK constraints (NOT VALID so legacy rows don't block; enforced for new writes).
- **Saved payment methods** — new `payment_method` table (gateway vault refs,
  never a PAN) replaces the lone `customer.stripe_customer_id` approach; foundation
  for Stripe/PayPal.

**Deliberate decisions — NOT built (would be dormant scaffolding per rule #10;
documented with the trigger that flips each):**
- **Single-currency, single-tier pricing on the variant** (`price`/`sale_price`/
  `pre_order_price`; currency on `store`). No multi-currency, no customer-group/
  B2B/quantity-break pricing. *Trigger to build a `price` table keyed by
  `(variant, currency, customer_group, min_qty)`:* the first multi-currency or B2B
  store. This is the main modelling ceiling for SellRight-as-a-product.
- **No facet/attribute model** — `product_option`/`variant_option` are per-product
  variant axes, not store-wide filterable facets; `collection` (with `parent_id`
  tree) is the category/navigation system. *Trigger:* faceted filtering (color/
  size/material across products) → v2.
- **Tax is one rate** (`store.tax_rate`). No tax classes/zones. *Trigger:* a store
  that needs per-product tax classes (DD/RH don't).
- **No customer groups / B2B** — single tier. *Trigger:* tiered pricing or B2B
  (pairs with the pricing decision above).
- **No returns/RMA entity** — `refund` models money; `refund_line.restock` is a
  bool. *Trigger:* a real returns workflow (inspection, RMA lifecycle) → v2.

## 2. Status matrix

| Area | State |
|---|---|
| Schema + RLS (37 tables, migrations 0000–0010) | ✅ applied, isolation tested |
| Coupons applied + audited at checkout (promotion_usage, limits enforced) | ✅ verified live |
| Data importer (catalog/customers/orders) | ✅ cent-perfect parity |
| Shop API: catalog, cart estimate, checkout, pay, auth, account, coupons | ✅ verified on real data |
| Payments: `cod` + `manual` | ✅ | real NMI/Sezzle/Stripe ⛔ blocked on creds |
| Admin API + SPA (orders/products/customers/dashboard) | ✅ live + audited |
| Admin: fulfillment inventory side-effect, RBAC `read_only` gate | ✅ fixed + verified 2026-06-05 |
| **Admin Shopify-parity (5 phases)**: catalog create/collections/inventory, refunds, draft orders, abandoned carts, discounts manager, **Listmonk in-admin**, settings (payments/shipping/staff-roles/tax), reports, search, activity, customer edit | ✅ shipped + verified 2026-06-05 |
| **DD-customization parity**: order CSV export, tracking CSV import, pre-order statuses, **affiliate system** (10% commission + settle + dashboard), blog CMS, guest order tracking, shipping eligibility, newsletter, auto-Delivered cron | ✅ shipped + verified 2026-06-05 |
| **Auth hardening**: httpOnly cookie sessions + CSRF + admin 2FA (TOTP) + login rate-limiting + customer Google sign-in | ✅ shipped + verified 2026-06-05 |
| Admin: product **image upload** | ⛔ depends on asset service (§3.8) |
| Listmonk live connection / Google sign-in live | ⚠ integration built; needs Listmonk URL+token / Google client id |
| DD custom features still blocked | ⛔ NMI/Sezzle (keys), SheerID webhook (account), SSE cache-invalidation (Redis/CF), contact-form + email flows (SMTP) |
| Storefront: browse + checkout→COD→confirmation | ✅ plumbing-verified |
| Storefront: auth / account / text-search UI | ⛔ still Vendure GraphQL |
| Facets / category filters | ⛔ not imported (no facet model) |
| Assets/images | ⚠ proxied to DD's asset server (dev) |
| Admin: product/variant **create** + image upload | ❌ edit-existing only |
| Fulfillment records (shipping state) end-to-end | ⚠ admin can ship/deliver; no carrier integration |
| Refunds | ❌ schema exists, no flow/UI |
| Shipping methods / tax config | ⚠ schema exists, no admin UI; DD has no tax |
| SSE channel (cache-invalidation / order-status / live-stock) | ❌ designed, not built |
| Prod admin host (nginx) + auth hardening | ❌ dev server + SSH tunnel |
| CI | ✅ GitHub Actions: build/typecheck/unit + RLS suite vs `_test` Postgres (2026-06-06) |
| **Checkout shipping authoritative** (server computes rate from selected method; body.shipping is bootstrap-only fallback) | ✅ shipped 2026-06-06 (`shipping/calculator.ts` + tests) |
| **Promotion concurrency** (FOR UPDATE row lock + re-read usedCount under lock) | ✅ shipped 2026-06-06 |
| **Audit-pass correctness** (atomic stock-reservation rollback, coupon-verification trust w/ guest email-linking, email normalization) | ✅ committed 73e041c (2026-06-06) |
| **Housekeeping jobs scheduled** (auto-deliver + release-stale) | ✅ opt-in in-process scheduler (`JOBS_ENABLED=1`); release-stale APPLY gated on cutoff confirmation |

---

## 2A. Path to 10 (Shopify parity) — roadmap + live progress

Source: adversarial review of `ECOMMERCE-BACKEND-AUDIT-2026-06-06.md` (Codex scored
the backend 5.5/10 vs a full-Shopify "10"). Note the framing caveat: a literal
10 measures against Shopify's *entire* surface (app platform, POS, multi-currency,
gift cards, smart collections, multi-location) — several of which are prior
**deliberate non-goals** for the DD/RH dogfood. Reaching a literal 10 means
consciously re-including them. Sequenced critical-path-first below.

### Phase 1 — Launch-grade (the real critical path)
| Item | State |
|---|---|
| Audit-pass correctness fixes (stock rollback, coupon trust, email normalize) | ✅ done 2026-06-06 (73e041c) |
| Shipping authoritative at checkout | ✅ done 2026-06-06 (5ed999c) |
| Promotion concurrency hardening | ✅ done 2026-06-06 (5ed999c) |
| CI + `_test` Postgres (RLS suite runs) + opt-in job scheduler | ✅ done 2026-06-06 (688b8c9) |
| Cart as a first-class resource (CRUD/merge/abandoned/convert) | ⏳ next — buildable now |
| Customer cookie sessions + CSRF (mirror admin model) | ⏳ buildable now (reset/verify emails ⛔ SMTP) |
| Real NMI tokenized payments + webhooks + capture/void + gateway refunds + reconciliation | ⛔ **blocked: NMI sandbox keys** |
| Prod admin host + CSP + `NODE_ENV=production` + non-owner DB role + backups + observability | ⛔ **blocked: domain + CF Access + one sudo** |

### Phase 2 — Shopify-core parity (buildable now unless noted)
Order editing · returns/exchanges · invoices/packing slips · customer
notifications (⛔ SMTP) · product **media upload** (⛔ object storage) · option-group
editor · compare-at/cost/barcode/dimensions/metafields · product+collection SEO
fields · smart collections + publish/SEO · tax zones/inclusive tax · automatic
discounts · gift cards/store credit · multi-location inventory + transfers.

### Phase 3 — Competitive platform
Webhooks/outbox + app surface (⚠ Redis at scale) · bulk import/export · advanced
analytics · fine-grained per-action permissions + staff invitations + session
revocation · multi-currency/markets/duties.

### What only Adrian can unblock (≈half of "10")
- **Payment sandbox keys** — NMI (primary), Sezzle, Stripe
- **SMTP / email provider** — password reset, email verification, order/shipping
  notifications, recovery, staff invitations
- **Object storage + CDN** (S3/R2 + Cloudflare token) — product image upload
- **Prod admin host** (domain + Cloudflare Access) + go to set `NODE_ENV=production`
  and create the non-owner DB role on the box (one sudo)
- Optional: Redis (atomic rate-limit/jobs/outbox), Listmonk URL+token, SheerID account

---

## 3. Open decisions (full detail + recommendation)

### 3.1 Real payment gateways — **BLOCKER (needs Adrian)**
**Context.** `PaymentProvider` interface is ready; `cod`/`manual` cover e2e. DD
runs **NMI (primary) + Sezzle (BNPL)**; RH runs **Stripe**. 🚨 The *current* DD
NMI plugin handles raw card data server-side (PCI **SAQ-D**).
**Decision.** Which gateway first, and the tokenization model.
**Recommendation.** Build **NMI via Collect.js / Vault tokenization → SAQ-A**
first (matches DD's revenue path; never replicate raw-PAN handling). Then Sezzle
(redirect-verify), then Stripe (PaymentIntents) for RH. Provide **NMI + Sezzle
sandbox creds** to unblock. Keep `cod` permanently for testing.

### 3.2 RBAC model
**Context.** Roles exist (`owner/manager/staff/read_only`). I added a minimal
`requireWrite()` (blocks `read_only` from mutations). No per-action matrix.
**Decision.** How granular? Who can refund, change price, manage staff, see PII?
**Recommendation.** Keep it **coarse for v1**: `owner` = everything incl. staff
management + refunds; `manager` = orders/products/stock/refunds; `staff` =
orders/fulfillment only; `read_only` = view. Encode as a per-action capability
check (`requireCap('order.refund')`) mapping role→caps in one table, so it's data
not code. Defer fine-grained custom roles to v2.

### 3.3 Admin token storage — ✅ RESOLVED (httpOnly cookie + CSRF, 2026-06-05)
Done: admin sessions moved to an httpOnly, SameSite=Lax (Secure in prod) cookie +
double-submit CSRF; no token in localStorage. See §1.10a. (`Secure` is prod-only
because dev runs over http://localhost; admin 2FA also shipped.) **Remaining
sub-item:** apply the same cookie model to the **storefront/customer** auth (still
bearer-in-localStorage), and add a strict CSP on the prod admin host.

### 3.4 Login rate-limiting / lockout — ✅ RESOLVED (2026-06-05)
Done: in-memory sliding window (8 fails / 15 min per ip+identity → 429), wired
into admin AND customer login (`auth/rate-limit.ts`). It's per-process — move the
store to Redis when running multiple API instances (the only remaining upgrade).

### 3.5 Partial fulfillment
**Context.** Fulfillment is all-or-nothing per order; `fulfillment_line` is
unused. Stock side-effect now correct for the all-or-nothing path.
**Decision.** Support per-line / per-quantity shipments?
**Recommendation.** **v2.** Most DD/RH orders are small; all-or-nothing is fine
to launch. When built: accept per-line quantities, write `fulfillment_line`,
increment `fulfilled_qty` by shipped units, decrement stock per shipped unit
(the current single-record path already moves stock correctly — extend, don't
rewrite).

### 3.5 Partial fulfillment
**Context.** Fulfillment is all-or-nothing per order; `fulfillment_line` is
unused. Stock side-effect now correct for the all-or-nothing path.
**Decision.** Support per-line / per-quantity shipments?
**Recommendation.** **v2.** Most DD/RH orders are small; all-or-nothing is fine
to launch. When built: accept per-line quantities, write `fulfillment_line`,
increment `fulfilled_qty` by shipped units, decrement stock per shipped unit
(the current single-record path already moves stock correctly — extend, don't
rewrite).

### 3.6 `seed-admin` store scope
**Context.** `seed-admin` grants `owner` on **every** store and re-forces owner
on conflict. Password now via `ADMIN_PASSWORD` env (not argv).
**Decision.** Default to one store, or keep all-stores?
**Recommendation.** **Parameterize** `seed-admin <email> [storeSlug] [role]`,
default to a single named store and `staff` role; keep an explicit
`--all-owner` flag for the bootstrap superuser (you). Low effort, removes the
"every seeded admin owns everything" footgun once non-owner accounts exist.

### 3.7 DB runtime role — owner vs dedicated non-owner *(latent safety caveat)*
**Context.** RLS isolation currently rests entirely on **`FORCE` being present
on every data table**, because the app connects as the table **owner** (`FORCE`
applies to the owner; `NO FORCE` registry tables are owner-readable by design).
The "policy stays for non-owner roles" clause in 0004/0006 is never exercised.
Risk: a *future* `store_id` table added with `ENABLE` but not `FORCE` would
silently leak under an owner connection.
**Decision.** Run the app as a dedicated non-owner login role, or keep owner +
a guard?
**Recommendation (revised after council review).** **Make the non-owner role the
primary fix, and do it before any public exposure — not "when convenient."** The
council's point is correct: with a non-owner role, a future `store_id` table that
forgets `FORCE` **fails closed immediately** (the policy applies and returns zero
rows), whereas a build-time assertion only catches it if someone runs the build
and reads the failure. So:
1. **Now / launch-gate:** run the app as a dedicated **non-owner** login role
   with explicit `GRANT`s; migrations still run as owner. This makes "missing
   `FORCE`" fail safe by default.
2. **Belt-and-suspenders:** *also* add the `pnpm verify` assertion that every
   `store_id` table has `FORCE` RLS — a fast, explicit signal even though the
   non-owner role already protects you.
Owner-as-runtime-role is acceptable only for the current single-operator dev
phase; it must not survive into a publicly reachable deployment.

### 3.8 Asset / image hosting
**Context.** Product images are served by proxying `/assets/*` to DD's Vendure
asset server (dev convenience). Manifest stores the `preview/...` path.
**Decision.** Proxy permanently, migrate assets into SellRight storage, or CDN?
**Recommendation.** **Migrate to object storage + CDN** (e.g. S3/R2 +
Cloudflare) with a SellRight asset service that owns upload/resize/serve.
Required before SellRight is independent of the old DD stack and before
multi-tenant image isolation matters. Until then the proxy is fine for dev.

### 3.9 Storefront dynamic-provider rewire (auth / account / search)
**Context.** Browse + checkout are on SellRight; **auth/account/text-search still
call Vendure `/shop-api` GraphQL** → those UI flows fail.
**Decision.** Finish the rewire now, or after gateways?
**Recommendation.** **Next major storefront phase** — it's the gap between
"plumbing works" and "a customer can actually use the site." Rewire the
`providers/shop/*` modules to the existing SellRight REST endpoints (auth,
account, and a `/v1/shop/search` to add). Needs dev-server + browser QA. Do it
in parallel with §3.1. **Migrate one flow at a time** (start with account login),
each behind a staging domain with the old Vendure path kept warm as the instant
rollback — don't cut all four flows over at once.

### 3.10 Facets / category filters
**Context.** DD's "category" facet wasn't imported (no facet model); products
show, filters don't.
**Decision.** Port a facet/attribute model, or rely on `collection`?
**Recommendation.** For v1, **map DD categories onto `collection`** (already in
the schema) and drive filters off collections. A general facet/attribute system
(color/size/material as filterable) is **v2**.

### 3.11 Admin create flows + image upload
**Context.** Admin is edit-existing only; no product/variant create, no upload.
**Decision.** Build now or after the storefront is fully live?
**Recommendation.** **After §3.8 (asset hosting)** — create-product without
image upload is half a feature, and upload needs the asset service. Sequence:
asset service → admin create/upload.

### 3.12 Production admin host
**Context.** Admin is the Vite **dev** server on `:4300` behind an SSH tunnel;
survives the session but not a reboot (no systemd unit). `vite preview` has no
proxy.
**Decision.** How to host for real?
**Recommendation.** Serve the **built `dist/`** behind nginx on an
authenticated admin subdomain (e.g. Cloudflare Access, like the existing Vendure
admins), with nginx proxying `/v1`→API and `/assets`→asset service. Add a
systemd unit for the API. Pair with §3.3 (cookie auth) so it's safe to expose.

### 3.13 SSE channel
**Context.** Designed (cache-invalidation, order-status, live-stock); DD already
has the cache-invalidation pattern. Not built in SellRight.
**Decision.** First-class now or later?
**Recommendation.** Build the **cache-invalidation SSE** when the storefront
goes live on SellRight (it's what keeps CDN/edge caches correct on price/stock
changes). Order-status + live-stock SSE are nice-to-have **v2**.

### 3.14 CI
**Context.** None, deliberately (no hosted minutes). Manual `pnpm verify`.
**Decision.** Keep manual, or self-hosted runner?
**Recommendation.** **Keep manual for now** (minimum mechanism). Add a
**pre-push git hook** running `pnpm verify` so the gate can't be forgotten —
cheaper and more reliable than a runner for a solo operator.

---

## 3A. Launch-blocking gate — clear BEFORE any public exposure or v2 work

The council's sharpest criticism: several §3 items are framed as peer "decisions"
when they are actually **hard prerequisites** — a v2 feature wishlist must not
start while the system is unsafe to expose. None of the v2 list (§4) begins until
this gate is green. Each item lists its **acceptance criterion ("done =")** so
the gate is objectively checkable. Roughly dependency-ordered, but items 3–8 are
**not strictly serial** — auth hardening, host, gateway, observability and
backups can proceed in parallel once 1–2 land.

1. **DB non-owner role + `FORCE` assertion** (§3.7) — fail-closed tenant
   isolation. *Foundational; do first.*
   **Done =** app connects as a non-owner role; the cross-store RLS leakage test
   passes under that role; `pnpm verify` fails if any `store_id` table lacks
   `FORCE`.
2. **Storefront auth / account / search rewired to SellRight** (§3.9) — without
   this, customers cannot log in, view orders, or search. Migrate one flow at a
   time, Vendure kept warm.
   **Done =** register/login/logout, account order-history + addresses, and
   product search all run through `/v1/shop/*` with no remaining Vendure
   `/shop-api` calls in `providers/shop/*`; browser-QA'd end to end.
3. **Admin auth hardening** — ✅ **mostly DONE (2026-06-05):** httpOnly cookie +
   CSRF + login rate-limiting + admin 2FA all shipped & verified (§1.10a, §3.3,
   §3.4). **Remaining:** CSP headers on the prod admin host (ships with item 4),
   and migrate the storefront/customer auth to cookies too.
4. **Production admin host** — built `dist/` behind nginx + Cloudflare Access +
   systemd for the API (§3.12). Replaces the dev-server-on-a-tunnel.
   **Done =** admin reachable on its subdomain through Access (no SSH tunnel);
   API runs under systemd and restarts on reboot.
5. **Real payment gateway** for the launching store (§3.1) — NMI-tokenized for
   DD, or Stripe for RH (RH launches first, greenfield).
   **Done =** a real sandbox transaction completes through `PaymentProvider`
   (tokenized — no raw PAN), order → Paid; **plus** (Codex): the webhook handler
   is **idempotent AND retry-safe** (duplicate/late/out-of-order webhooks
   converge to the same state; a dropped webhook is recovered by a poll/verify
   fallback), and a **daily reconciliation** job diffs provider-side transactions
   against our `payment` rows and flags any mismatch. Acceptance test: replay a
   duplicate webhook, a delayed webhook, and a dropped webhook (verify-fallback
   catches it) → exactly one settled payment, order Paid once.
6. **Minimal observability** *(added in self-review — was deferred to "future,"
   which is wrong for a money-taking store).*
   **Done =** structured error logging to a queryable sink (e.g. a log service /
   Sentry-class error tracker); an uptime check on the API + storefront; and an
   alert channel that **pages you** on concrete triggers (Codex): **API down/health
   fail for >1 min**, **5xx rate >2% over 5 min**, **checkout-success rate drops
   below the agreed floor**, and **p95 request latency >1 s for 5 min**. (Tune the
   numbers once a baseline exists; the point is they're defined, not "agreed
   bounds".)
7. **Automated DB backups** *(added in self-review — the rollback story only
   covered pre-migration snapshots, not a live store).*
   **Done =** scheduled backups with a **stated RPO/RTO** (Codex): target
   **RPO ≤ 5 min** (WAL-archiving / PITR) — or **RPO ≤ 24 h** if daily `pg_dump`
   is accepted for the launch store — and **RTO ≤ 1 h** to a defined restore
   target (a standby instance or a documented restore runbook). Offsite copy +
   a **tested restore** to that target before the store takes a real order.
8. **Secrets management** *(added in self-review).*
   **Done =** prod secrets (DB URL, payment keys, admin bootstrap) live in a
   restricted-perms env file or a secrets store loaded by the systemd unit —
   not pasted on a command line or only in a process's inherited env. Payment
   keys especially never touch argv/`/proc/cmdline` or git.

**Explicitly NOT in the gate:** full RBAC (§3.2) — deferred because the first
launch is single-operator (you are the only admin; the `read_only` block already
exists). It becomes blocking the moment a second, lower-trust admin is added.

**RH launches first** (zero orders → zero cutover risk) and needs items 1–8 (the
asset service, §3.8, only if it can't reuse DD assets). **DD/SS cutover is later**
and additionally needs the asset service + the parity-replay gate below.

### Cutover & rollback (the missing reversibility story)

The council flagged the missing rollback; Codex flagged that the *naïve* version
("revert the storefront provider to Vendure") silently abandons any orders,
payments, and customer edits that SellRight already accepted during the bake.
There are **two distinct rollback regimes** and they are not the same:

**Regime A — rollback BEFORE the first real order (clean, instant).**
- The `providers/shop/*` modules are the seam: revert a flow by pointing it back
  at the Vendure `/shop-api` GraphQL endpoint (+ DNS/API base if needed). Per-flow,
  no data migration, no reconciliation. This is the *only* truly instant rollback.

**Regime B — rollback AFTER SellRight has accepted real writes (reconciliation
required — you cannot just flip the switch).**
- Orders + payments created on SellRight during the bake **exist only in
  SellRight**; Vendure has never seen them. Reverting the storefront to Vendure
  without moving them strands real customer money. So Regime B requires a
  **forward reconciliation export**: a one-way exporter that writes
  SellRight-side orders/payments (and any customer/address edits) **back into
  Vendure** before/at the moment of revert, OR an explicit decision to **stop
  taking new orders, drain in-flight ones, then revert** (maintenance window).
- **Therefore: prefer forward-fix over rollback once real orders flow.** Regime B
  is the break-glass option, not the default. Build the SellRight→Vendure
  order/payment exporter (or accept the maintenance-window drain) *before*
  SellRight takes the first real order, so the option actually exists.

**Data ownership during the bake (so a revert doesn't lose customer changes).**
While auth/account is being cut over, exactly one system owns customer-mutable
data at a time:
- During the bake, **SellRight is the writer of record** for any flow already
  cut over; Vendure's copy is treated as stale for that flow. Account/address
  edits made on SellRight are included in the Regime-B reconciliation export.
- Do **not** run a window where both systems accept writes to the same record
  with no reconciliation — that is the silent-divergence trap. Cut a flow over
  fully (with the exporter ready) rather than splitting writes.

**DD/SS data cutover gate (M9):** the **parity-replay** test — re-run real
historical order inputs through SellRight's money core and diff totals against
Vendure's stored `grand_total` to the cent (the one-shot import already proved
$852,930.51 parity; replay proves the *live compute path*). Preserve external
customer IDs (Stripe/NMI/Sezzle) so payment history survives.

**DB rollback:** snapshot `sellright_dev`/prod before each migration and before
cutover; migrations are forward-only but a snapshot restore is the floor (subject
to the RPO/RTO in gate item 7).

**Smallest test scope:** shadow a single flow (account login) on a staging domain
with real traffic before the full storefront cutover.

### Scalability / performance (not a v1 blocker, but on the radar)

Deliberately *not* solved by microservices (see non-goals). Concrete items when
traffic warrants, ordered by ROI (research-backed — `docs/research/ecom-backend-research-2026-06.md`
§7):
- **PgBouncer in transaction-pooling mode** is the highest-ROI first lever
  (multiplexes clients onto a small backend pool). **Compatible with our RLS**
  because `withStore()` uses `SET LOCAL app.current_store` *inside a transaction*
  — the GUC is txn-scoped and reset at commit. **Hard rule:** never set the store
  GUC at session level (session `SET` breaks under transaction pooling).
- **Browse load is already offloaded** to the static catalog manifest (no DB on
  home/shop/PDP) — the research's "offload what you can" win, already done.
- Admin auth costs ~2 DB round-trips before the handler txn — collapse
  `resolveAdmin`+`adminStores` into one query, or cache per-token.
- Add hot-path **indexes** (`order(store_id,state,created_at)`,
  `order(customer_id)`, `product(store_id,name)`) before large admin lists slow.
- **Partition `order`/`order_line` by time only at the 100 GB–1 TB phase**
  (premature now at 13.5 k orders); tune **autovacuum** on the high-write tables
  (`order`, `order_line`, `stock_movement`, `cart_line`) before real volume.
- Move heavy/async work (emails, recovery, settlement) to the planned BullMQ/Redis
  layer rather than request threads. Don't shard/add replicas to fix a
  connection or write-throughput problem — match the fix to the bottleneck.

### Research-informed correctness deltas (2026-06)

From `docs/research/ecom-backend-research-2026-06.md` — small, mostly pre-launch,
that confirm the model and close real gaps. **Status as of 2026-06-05 (commits
2fb1102/ffb6a6b):**

- **✅ SHIPPED — `Idempotency-Key` on `/v1/shop/checkout`** (Stripe-canonical).
  `order.idempotency_key` is unique per store (migration 0007); same key → same
  order; the concurrent-double-submit loser's txn rolls back (releasing its
  allocation) and re-reads the winner. **Verified live:** same key twice →
  identical order code, no duplicate. (`pay` was already idempotent via
  `processed_event`.)
- **✅ SHIPPED — Reservation-expiry job** (`jobs/release-stale-allocations.ts`):
  releases `allocated` stock on stale unpaid `PendingPayment` orders — the
  missing "release on timeout" half of soft-reservation (research §6). DRY-RUN by
  default (won't mass-cancel imported historical orders); `--apply` to act; needs
  scheduling (BullMQ/cron) to run automatically.
- **✅ SHIPPED — Hot-path indexes** (migration 0007) + **FORCE-RLS invariant
  assertion** wired into `pnpm verify` (`db/assert-force-rls.ts`) — passes: 26
  store-scoped tables all FORCE; `session`/`processed_event` consciously exempt
  (auth/idempotency infra). Admin-auth collapsed from 2 DB round-trips to 1 join.
- **🔶 STAGED, BLOCKED on a superuser — non-owner DB role** (gate item 1). The
  enabling migration **0008 (disable RLS on `admin_user_store` registry) is
  applied**, and `create-app-role.sh` + the owner/app env-split in the deploy
  scripts are ready. Creating the `sellright_app` role needs `CREATEROLE`/the
  `postgres` superuser (the `sellright` owner lacks it). Until then the app runs
  as the owner — still fail-closed via FORCE-on-owner, just not by-default-safe
  against a future missing-FORCE table. **One command unblocks it** (see below).
- **[v2] DB-backed outbox + polling relay** (NOT Kafka/Debezium) for SSE
  cache-invalidation, BullMQ events, and the Regime-B exporter — all dual-writes;
  `processed_event` is the matching inbox (research §4).
- **[validated, no change]** RLS model, soft-reservation inventory,
  modular-monolith + from-scratch, and the static-manifest browse offload are all
  *exactly* what current research recommends.

> **To finish the non-owner-role cutover** (as a user with sudo, on the box):
> ```bash
> sudo -u postgres psql -p 5433 -d sellright_dev -c \
>   "CREATE ROLE sellright_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '<pw>';"
> # then, as the vendure user:
> APP_DB_PASSWORD='<pw>' bash ~/sites/sellright/packages/api/scripts-deploy/create-app-role.sh   # grants + ~/.sellright/env
> ADMIN_PASSWORD='<admin-pw>' bash ~/sites/sellright/packages/api/scripts-deploy/migrate-and-cutover.sh adrdsouza@gmail.com  # cuts API to app role + verifies
> ```
> (`create-app-role.sh` is idempotent on the grants; if the role already exists it
> just (re)applies grants + writes the env file. Or grant the owner CREATEROLE
> once: `sudo -u postgres psql -p 5433 -c 'ALTER ROLE sellright CREATEROLE;'` and
> the existing scripts handle the rest.)

### First-launch definition of done (observable success signals)

"RH is live on SellRight" is true when, over a defined bake window: real orders
flow browse → cart → checkout → **real payment** → Paid → fulfilled with a
checkout success rate at or above the old stack; **zero cross-tenant incidents**
(RLS); error rate and p95 latency within agreed bounds on the observability
dashboard (gate item 6); and a **restore from backup has been tested** (gate item
7). Until those hold, it's "deployed," not "launched."

---

## 4. v2 (after first real launch)

- Per-line **partial fulfillment** + carrier/label integration + tracking emails.
- **Refunds** flow (schema exists): partial/full, restock toggle, provider refund
  calls, `PartiallyRefunded`/`Refunded` transitions, refund UI.
- **Full RBAC** capability matrix + custom roles + staff-user admin UI.
- **Facet/attribute** system (filterable color/size/material) + faceted search.
- Admin **product/variant create**, bulk edit, CSV import/export, image upload &
  resize pipeline.
- **Promotions UI** (the engine + single-coupon-v1 exist): build/manage
  promotions, scheduling, the deferred stacking model.
- **Shipping** zones/rates admin + real rate calculators; **tax** engine if any
  store ever needs it (DD doesn't).
- **Affiliate** program UI + automated settlement (tables exist).
- **Blog CMS** UI (table exists) + SEO/IndexNow.
- **Analytics** off the cart/abandonment data (funnel, recovery emails).
- **Listmonk** integration, double-opt-in contact form, Turnstile anti-abuse.
- **SSE** order-status + live-stock.

## 5. Future / longer horizon

- **DD + SS production cutover** (M9): the cent-perfect parity *replay* gate (diff
  new totals vs Vendure stored totals on real orders) + preserve Stripe/NMI
  customer IDs. RH launches greenfield first (zero orders = zero risk).
- **Multi-store from one admin window** (the original driver) — switcher exists;
  needs the cookie-auth + prod host to be real.
- **Open-source / sellable extraction:** the repo is private (contains DD docs);
  if OSS, extract a clean repo rather than flipping this one public. Needs:
  config-driven tenant onboarding, a self-host installer, docs, removal of
  DD-specific assumptions.
- **BullMQ/Redis** job layer (stale-order cleanup, Sezzle recovery,
  auto-Delivered cron, email sends) — planned, not built.
- **Asset service** as a standalone module (ties to §3.8).
- **Observability beyond the minimum** — tracing, dashboards, SLOs. (The *minimum*
  — error logging + uptime + one alert — is a launch-gate item, §3A.6, not a
  future nicety.)

---

## 6. Tech-debt / risk register

| Item | Risk | Mitigation |
|---|---|---|
| App connects as DB **owner** (dev only); RLS safety currently = `FORCE` on every table | A future table missing `FORCE` leaks cross-tenant under owner | **§3A gate item 1 (do before public exposure):** run as non-owner role (fails closed) + `pnpm verify` FORCE-assertion as backstop |
| Admin token in **localStorage**, 14-day TTL | XSS exfiltration | §3.3: httpOnly cookie + CSP |
| **No login rate-limit** | Credential stuffing | §3.4: PG attempt counter |
| Assets **proxied to DD** | Coupling to old stack; not independent | §3.8: asset service + CDN |
| Storefront auth/account/search on **Vendure GraphQL** | Those flows broken on SellRight | §3.9: rewire |
| Admin on **dev server**, no reboot persistence | Goes down on box reboot | §3.12: built dist + nginx + systemd |
| `order_line` 93% reference **deleted products** | History relies on snapshot cols | Already mitigated (snapshot cols + nullable variant_id) |
| Link tables lack `store_id`/RLS (isolation via parent FKs) | Defense-in-depth gap | Add `store_id` + RLS as hardening |
| **Parallel dev** on one repo (other sessions commit) | Merge drift | Pull before work; coordinate |
| No load/perf testing; admin auth ~2 round-trips/req; missing hot-path indexes | Slow admin lists / latency at scale | §3A scalability: indexes, collapse auth query, BullMQ for async |
| No documented **cutover rollback** until this revision | Risky DD/SS migration | §3A Cutover & rollback (Vendure kept warm, per-flow revert, parity-replay) |

---

## 7. Appendix

**Migrations:** `0000` schema · `0001` RLS policies · `0002` nullif hardening ·
`0003` order_line snapshot · `0004` store registry NO FORCE · `0005` cart tables ·
`0006` admin_user_store NO FORCE · `0007` order idempotency + indexes · `0008`
admin_user_store registry (disable RLS) · `0009` model completeness (promotion
linkage/usage, payment_method, link-table RLS, FK tightening) · `0010`
customer.tags.

**API restart:** use `scripts-deploy/start-api.sh` (setsid — survives the SSH
channel); inline `nohup … &` over ssh dies on channel close. `start-admin.sh`
likewise for the SPA. Ops/verify scripts live in `packages/api/scripts-deploy/`.

**Run the stack (on Hetzner):**
```bash
# API (:3300)
cd ~/sites/sellright/packages/api && pnpm exec tsx src/index.ts   # env: DATABASE_URL, PORT=3300
# Admin SPA (:4300, proxy-enabled)         bash ~/start-admin.sh
# Storefront SSR (:4100)                    CATALOG_DIR=/home/vendure/sites/sellright-data pnpm dev
# Seed/reset an admin                        ADMIN_PASSWORD=… pnpm exec tsx src/scripts/seed-admin.ts <email>
# Robust API restart + e2e proof             ADMIN_PASSWORD=… bash ~/restart-and-test.sh <email>
```

**View the admin:** `ssh -L 4300:127.0.0.1:4300 -F ~/.ssh/config.dd dd -N`
→ http://localhost:4300/

**Canonical references:** commerce rules → `SELLRIGHT-ECOMMERCE-RULEBOOK-v1.md`;
DD plugin parity → `DD-CUSTOMIZATION-SPEC-v1.md`; original plans →
`ARCHITECTURE-PLAN-v1.md`, `BUILD-PLAN-RH-v1.md`; external research mapped to our
architecture → `research/ecom-backend-research-2026-06.md`.

---

## 8. Review history

```json
{
  "artifact": "STATE-AND-ROADMAP-v1.md",
  "review": "council review-plan (API jury: kimi-k2.6, nemotron-3-super-120b, gpt-oss-120b)",
  "date": "2026-06-05",
  "verdict": "NEEDS-REVISION",
  "avg_score": 5.3,
  "top_concerns": [
    "RLS isolation rested only on FORCE-on-every-table under an owner connection",
    "production-safety items (cookie auth, rate-limit, prod host, storefront rewire) not prioritized over the v2 wishlist",
    "no documented cutover rollback story"
  ],
  "revisions_applied": [
    "§3.7 elevated: run as non-owner DB role NOW (fails closed) + FORCE assertion as backstop",
    "added §3A Launch-blocking gate sequencing safety/cutover BEFORE any v2 work",
    "added §3A Cutover & rollback (Vendure kept warm, per-flow revert, parity-replay, DB snapshot)",
    "added §3A scalability/perf note (indexes, auth round-trips, BullMQ)",
    "§3.9 staged one-flow-at-a-time rewire with warm rollback",
    "documented Locked decisions & non-goals (from-scratch, monorepo-not-microservices) — pushed back on the jury's 'use Medusa/Saleor' and 'microservices' as out-of-context"
  ],
  "rejected": [
    "use an existing commerce framework (Medusa/Saleor/Shopify) — locked from-scratch decision, rationale documented",
    "microservices for scalability — deliberate non-goal for a solo operator"
  ]
}
```

```json
{
  "artifact": "STATE-AND-ROADMAP-v1.md",
  "review": "/review-self plan (role cards: Decision, Implementation Lead, Risk Inversion, Operator, Customer)",
  "date": "2026-06-05",
  "verdict": "NEEDS-REVISION",
  "new_findings_beyond_council": [
    "launch gate had no per-item acceptance criteria — added 'Done =' to every item",
    "minimal observability (error logging + uptime + alert) was deferred to 'future' but is launch-blocking for a money-taking store — promoted to gate item 6",
    "rollback covered only pre-migration snapshots, not routine backups of a live store — added gate item 7 (scheduled pg_dump/PITR + tested restore)",
    "secrets management for prod (esp. payment keys) undocumented — added gate item 8",
    "RBAC's absence from the gate was unstated — clarified it's deferred (single-operator) and when it becomes blocking",
    "added a first-launch definition-of-done with observable success signals"
  ],
  "note": "self-review is internal critique, not an independent jury; findings labeled as such"
}
```

```json
{
  "artifact": "STATE-AND-ROADMAP-v1.md",
  "review": "/review-cli codex (gpt-5.5, plan rubric)",
  "date": "2026-06-05",
  "verdict": "NEEDS-REVISION",
  "score": 7,
  "top_concern": "rollback/data reconciliation still underspecified once real orders start",
  "revisions_applied": [
    "Cutover & rollback split into Regime A (pre-first-order, instant) vs Regime B (post-real-writes, requires a SellRight->Vendure order/payment reconciliation export or a maintenance-window drain) — prefer forward-fix over rollback once orders flow",
    "added data-ownership-during-bake rule (single writer of record per flow; no dual-write window)",
    "fixed contradiction: risk-register row no longer says non-owner role is 'eventual' — points to §3A gate item 1",
    "gate item 5: payment Done now requires retry-safe webhooks + verify-fallback + daily provider reconciliation, with a replay acceptance test",
    "gate item 6: concrete observability triggers (health >1min, 5xx >2%/5min, checkout-success floor, p95 >1s/5min) + named log sink",
    "gate item 7: backups now carry RPO (<=5min PITR or <=24h dump) / RTO (<=1h) + restore target"
  ],
  "infra_fix": "codex CLI was broken globally — config.toml had service_tier='priority' (invalid; codex now accepts only fast|flex). Changed to 'fast'."
}
```
