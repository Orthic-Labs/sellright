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
- **Monorepo-modular, NOT microservices.** One deployable API with clean internal
  module boundaries. A solo operator does not pay the microservices ops tax for
  this traffic. Revisit only if a single component needs independent scaling.
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

### 1.3 Data model (35 tables, by domain)

- **Tenancy:** `store` (registry), `admin_user`, `admin_user_store` (ACL),
  `session` (customer + admin sessions share the table, discriminated by
  `customer_id` / `admin_user_id`).
- **Catalog:** `product`, `product_variant`, `product_option_group`,
  `product_option`, `variant_option`, `collection`, `collection_product`,
  `asset`, `product_asset`, `variant_asset`.
- **Customer:** `customer`, `address`.
- **Orders & money:** `order`, `order_line` (with snapshot cols), `payment`,
  `refund`, `refund_line`, `fulfillment`, `fulfillment_line`.
- **Inventory:** `stock` (on_hand/allocated), `stock_movement`.
- **Promotions/shipping:** `promotion`, `shipping_method`.
- **Cart (separate from orders):** `cart`, `cart_line`.
- **DD-parity:** `affiliate`, `affiliate_settle`, `blog_post`.
- **Infra:** `processed_event` (idempotency), `audit_log`.

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

### 1.10 Admin (API + SPA)

- **API** (`routes/admin.ts`, `/v1/admin/*`): bearer-admin auth, dashboard KPIs,
  orders (list/detail/fulfill/cancel), products (list/detail/edit), variants
  (price/sale/enabled/stock), customers (list/detail). Store-scoped via
  `withStore`; mutations write `audit_log` (order timeline); `requireWrite()`
  blocks `read_only` admins.
- **SPA** (`packages/admin`): Shopify-style light theme, store switcher, the
  pages above with inline edit + fulfill/cancel UI. Token + active store in
  `localStorage`. Builds ~76 KB gzip.

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

## 2. Status matrix

| Area | State |
|---|---|
| Schema + RLS (35 tables, migrations 0000–0006) | ✅ applied, isolation tested |
| Data importer (catalog/customers/orders) | ✅ cent-perfect parity |
| Shop API: catalog, cart estimate, checkout, pay, auth, account, coupons | ✅ verified on real data |
| Payments: `cod` + `manual` | ✅ | real NMI/Sezzle/Stripe ⛔ blocked on creds |
| Admin API + SPA (orders/products/customers/dashboard) | ✅ live + audited |
| Admin: fulfillment inventory side-effect, RBAC `read_only` gate | ✅ fixed + verified 2026-06-05 |
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
| CI | ❌ deliberate (manual `pnpm verify`) |

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

### 3.3 Admin token storage — localStorage vs httpOnly cookie
**Context.** Admin bearer token is in `localStorage` (JS-readable ⇒ XSS can
exfiltrate; 14-day TTL widens the window).
**Decision.** Move to httpOnly cookie + CSRF, or keep localStorage + mitigations.
**Recommendation.** **Move to an httpOnly, Secure, SameSite=Strict session
cookie** set by the API, with a CSRF token for mutations and a strict CSP on the
admin host. It's the standard fix and the admin is same-origin behind nginx
anyway. Until then: shorten TTL to ~2 days and add CSP. Worth doing before the
admin is exposed beyond the SSH tunnel.

### 3.4 Login rate-limiting / lockout
**Context.** `/v1/admin/login` has no throttle. scrypt is slow but doesn't stop
credential-stuffing.
**Decision.** Where does the counter live?
**Recommendation.** **Postgres-backed attempt counter** (per-email + per-IP,
exponential backoff, short lockout) for v1 — no new infra. Move to Redis only
when BullMQ/Redis lands anyway. Add to the shop login too.

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
3. **Admin auth hardening** — httpOnly+Secure+SameSite cookie + CSRF + CSP
   (§3.3) **and** login rate-limiting (§3.4).
   **Done =** no admin token in `localStorage`; mutations require a CSRF token;
   a brute-force loop on `/v1/admin/login` trips lockout.
4. **Production admin host** — built `dist/` behind nginx + Cloudflare Access +
   systemd for the API (§3.12). Replaces the dev-server-on-a-tunnel.
   **Done =** admin reachable on its subdomain through Access (no SSH tunnel);
   API runs under systemd and restarts on reboot.
5. **Real payment gateway** for the launching store (§3.1) — NMI-tokenized for
   DD, or Stripe for RH (RH launches first, greenfield).
   **Done =** a real sandbox transaction completes through `PaymentProvider`
   (tokenized — no raw PAN), webhook/verify idempotent, order → Paid.
6. **Minimal observability** *(added in self-review — was deferred to "future,"
   which is wrong for a money-taking store).*
   **Done =** structured error logging shipped somewhere queryable, an uptime
   check on the API + storefront, and one alert channel that pages you on
   down/5xx-spike. Launching blind to errors is a self-inflicted outage.
7. **Automated DB backups** *(added in self-review — the rollback story only
   covered pre-migration snapshots, not a live store).*
   **Done =** scheduled `pg_dump` (or PITR) of the prod DB with an offsite copy
   and a **tested restore**, before the store takes a real order.
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

The council correctly flagged there was no documented rollback. The plan:

- **Keep the Vendure stack warm** through each cutover — do not decommission it
  until parity is proven and the store has run clean on SellRight for a defined
  bake period.
- **Storefront rollback:** the `providers/shop/*` modules are the seam. Reverting
  a flow = point that provider back at the Vendure `/shop-api` GraphQL endpoint
  (+ DNS/API base if needed). Per-flow, instant, no data migration.
- **DD/SS data cutover gate (M9):** the **parity-replay** test — re-run real
  historical order inputs through SellRight's money core and diff totals against
  Vendure's stored `grand_total` to the cent (the one-shot import already proved
  $852,930.51 parity; replay proves the *live compute path*). Preserve external
  customer IDs (Stripe/NMI/Sezzle) so payment history survives.
- **DB rollback:** snapshot `sellright_dev`/prod before each migration and before
  cutover; migrations are forward-only but a snapshot restore is the floor.
- **Smallest test scope:** shadow a single flow (account login) on a staging
  domain with real traffic before the full storefront cutover.

### Scalability / performance (not a v1 blocker, but on the radar)

Deliberately *not* solved by microservices (see non-goals). Concrete items when
traffic warrants: a single `pg.Pool` is shared (fine now); **browse load is
already offloaded** to the static catalog manifest (no DB on home/shop/PDP);
admin auth currently costs ~2 DB round-trips before the handler's own txn
(collapse `resolveAdmin`+`adminStores` into one query, or cache per-token); add
indexes on the hot filter/sort paths (`order(store_id,state,created_at)`,
`order(customer_id)`, `product(store_id,name)`) before large admin lists get
slow; move heavy/async work (emails, recovery, settlement) to the planned
BullMQ/Redis layer rather than request threads.

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
| App connects as DB **owner**; RLS safety = `FORCE` on every table | A future table missing `FORCE` leaks cross-tenant under owner | §3.7: `pnpm verify` FORCE-assertion + eventual non-owner role |
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
`0006` admin_user_store NO FORCE.

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
`ARCHITECTURE-PLAN-v1.md`, `BUILD-PLAN-RH-v1.md`.

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
