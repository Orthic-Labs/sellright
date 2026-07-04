minimax

---

# SellRight vs Vendure / Shopify / Woo — migration-readiness audit

**TL;DR:** The **engine** is genuinely better-engineered than a default WooCommerce install and on par with (often ahead of) Shopify's backend discipline on the things that matter for money. **It is not yet production-migration-ready** for a live store cutover — there are 4 hard blockers (multi-tenant host routing, in-process rate-limiter at multi-instance scale, observability, storefront checkout migration still behind a feature flag) and a half-dozen Tier 2 gaps. None of the blockers are architectural; they're scoped engineering work. The dangerous stuff — payments, RLS, idempotency, crypto, SSRF, webhooks — is already correct to a level I'd be happy to ship against.

Source-of-truth assertions are file:line. I read all 7 directories of `packages/api/src`, the schemas, the 36 migrations, the auth/CSRF/TOTP/rate-limit/stock modules, the entire money core, payments+settle+webhook-reconcile, jobs/scheduler, webhooks/emit (the transactional outbox), and skimmed the storefront + admin + the existing internal `docs/COMMERCE-GAP-ANALYSIS.md` (a sibling doc already covering much of this — I'm partly validating it, partly covering what it under-weighted).

---

## What's genuinely AHEAD of the field

These are not "feature checklist" wins — they're architectural calls that almost no commerce platform gets right without paid add-ons.

1. **Real multi-tenancy via Postgres RLS** (`drizzle/0001_rls_policies.sql`, `0002_harden_rls_nullif.sql`, `db/client.ts:withStore`, `db/assert-force-rls.ts`). FORCE RLS on 40+ tables, fail-closed via `nullif(current_setting(...), '')::uuid`, defense-in-depth `store_id` columns even on join tables. A CI assertion (`db:assert-rls`) fails the build if anyone adds a store-scoped table without FORCE RLS. **Shopify = 1 store/account**, Woo = 1 site/install, BigCommerce multi-storefront is Enterprise-only. SellRight runs N stores in one DB safely.

2. **Server-authoritative money, end-to-end.** `routes/checkout.ts` re-reads the cart from the DB (not the client), `bySku` re-derives variant rows, `validateReservableItems` → `reserveStockOrThrow` allocates atomically (`orders/stock-reservation.ts:39` uses `UPDATE … WHERE (on_hand - allocated) >= $qty`, `rowCount` check, no oversell possible). The coupon path takes `FOR UPDATE` on the promotion row (`checkout.ts:220`) and re-checks usage under the lock. Shipping is server-computed once `shippingMethod` rows exist; client `body.shipping` is only honored in bootstrap mode. Tax uses `taxZone` priority matching. The money core (`money/totals.ts`) is a **pure** function — integer cents, distribution rounding via largest-remainder, line-level rounding for %, tax-inclusive vs -exclusive modes. Unit-tested with property tests (`money/totals-property.test.ts`).

3. **Stripe done correctly on the modes axis.** `routes/payment-webhooks.ts:44-58` tries TEST secret first then LIVE; `stripeModeFromConfig(store.config) !== verifiedMode` is the cross-mode guard. `keyMatchesMode` rejects a `sk_test_…` pasted into the LIVE slot. Webhook secrets are mode-bound. `verifyIntent` re-checks amount/currency/orderCode server-side (`payments/stripe.ts:110`). Idempotency on event id via `processedEvent` PK. Dual-key fallback in `stripeCreds()` for legacy migrators. Test webhook verifier uses a throwaway client that doesn't need a real API key (`stripe.ts:88-90`). This is the surface most "Stripe integrations" get wrong.

4. **Transactional outbox for outbound webhooks.** `webhooks/emit.ts:14` `emitEvent` runs inside the caller's txn → no event for a rolled-back order ever fires. `deliverWebhooks` uses `FOR UPDATE SKIP LOCKED` (Postgres-native queue primitive) + HMAC-SHA256 signatures + 6-step exponential backoff (30s → 6h). `webhook-reaper.ts` recovers crashed `processing` rows after a grace window. **Dry-run-by-default** on every destructive job (`JOBS_AUTO_DELIVER_APPLY=1`, `JOBS_RELEASE_STALE_APPLY=1`, `JOBS_WEBHOOK_REAPER_APPLY=1`); master kill switch `JOBS_ENABLED=1` defaults to off.

5. **Cryptography** is the right tool for each job: `scrypt` for password hashing with 16-byte salt and self-describing format (`auth/password.ts`), SHA-256 for session token + activation token storage (raw token only ever in cookies/URLs), HMAC-SHA256 with timing-safe compare for downloads (`licensing/download-url.ts`), `timingSafeEqual` on CSRF (`auth/cookies.ts:14`) and password (`auth/password.ts:20`). RFC-6238 TOTP from scratch with a per-actor in-process replay store (`auth/totp.ts:48`). No external crypto dep — fewer supply-chain edges.

6. **SSRF defense done properly.** `security/outbound-url.ts` is the best anti-SSRF module in any commerce tool I have read. It (a) blocks private IPv4 ranges + IPv6 ULA/link-local/multicast + IPv4-mapped IPv6 + 6to4 + Teredo + NAT64 WKP + discard-only, (b) DNS-resolves the target hostname, **(c) re-checks every resolved address against the private-IP predicate**, **(d) pins the verified IP for the actual TCP connect** — killing DNS-rebinding. Disallows username/password in URL, refuses redirects to private hosts (`outbound-url.ts:286`), caps URL length at 2048. Unit-tested.

7. **Native digital-goods licensing.** `fulfillmentType ∈ {physical, digital_download, license, update_pass}` (`schema-core.ts:32`). `license`, `licenseActivation`, `appRelease`, `downloadArtifact` tables. Idempotent issuance via per-orderLine guard inside `issueLicensesForPaidOrder` so concurrent webhook + `/pay` races can't double-issue (`payments/settle.ts`). Off-the-shelf SendOwl / FetchApp / EDD cost $20-80/mo elsewhere, then you still need to glue them.

8. **Self-hosted Listmonk email + per-app sender routing** (`email/mailer.ts`, `env.ts:53-58`). Per-`storeSlug` `EMAIL_FROM_BY_APP` / `STOREFRONT_URL_BY_APP` env lets one API process host multiple brand storefronts (Damned + Rotten + ViewRight) without per-store SMTP config.

9. **Verification gate.** `pnpm verify` runs build → typecheck → vitest → `db:assert-rls` → `db:assert-hand-written` → `assert:shop-isolation`. The hand-written-migrations rule is unusual discipline: `assert-hand-written-migrations.ts` fences off hand-edited SQL from `drizzle-kit generate` diff-churn. The shop-route-isolation check enforces that public `/v1/shop/*` routes can't use `unsafeUnscopedDb`.

10. **Postgres-side trigram indexes** (`0029_product_search_trgm.sql`) — name + description `ILIKE` now index-served. `customer_token_hash_idx` and the full `0022_indexes.sql` set cover every hot lookup path I traced.

None of this is "Vendure has more plugins" territory. This is hard problems, solved well.

---

## Where it's at PARITY with mature platforms

- Catalog schema — products, variants, option groups, option matrix, featured + gallery assets, smart (rule-based) collections with `match: all|any` conditions DSL (`catalog/collection-rules.ts`), soft-delete, order-line snapshots that survive variant deletion.
- Order lifecycle — pending/paid/refunded/Cancelled FSM with `money/fsm.ts:canTransition` guard, draft orders, fulfillment + tracking import, returns (RMA) + partial refunds, pre-orders, `refundedQty` per line, soft-trash.
- Inventory — atomic reservation, full `stock_movement` ledger with `reason`, multi-location tables (`location` + `stock_location`) layered over single-table `stock`. The aggregate `stock.onHand` is what reservations work against; multi-location is additive.
- Promotions — coupon + automatic, percentage / fixed / free-shipping, `usageLimit` + `perCustomerUsageLimit` enforced under the same row lock as the apply. Gift cards as a **tender** type with their own double-spend-protected ledger (`money/gift-card.ts`, `checkout.ts:294` takes `FOR UPDATE` on the gift-card row).
- Outbound webhooks — described above. Genuinely best-in-class.
- API contract — 131+ Zod-validated routes, code-first OpenAPI at `/v1/openapi.json`. Single `/v1` version (no deprecation policy in place — gap, see §4).

---

## Where competitors win, and SellRight is **BEHIND**

I'll sort by how much each gap matters for **cutting over live stores**.

### A. Hard migration blockers (must fix before go-live)

**A1. Multi-tenant host routing is unimplemented.** Every shop route resolves the store from `x-store-slug` header or falls back to `DEV_DEFAULT_STORE` (`routes/store-context.ts:20`). The comment in `store-context.ts:32` says "in production this maps an incoming host/subdomain to a store" but **no such code exists**. For Damneds + Rotten + ViewRight on one API you'll need a host → store mapping layer (subdomain match, or `store_domains` table, or both). Without it, production traffic hitting `damned.sellright.com` will serve `damned` only because that's the fallback — until someone sends a custom `x-store-slug` and gets someone else's store.

**A2. No CORS middleware.** Zero matches for `cors|Access-Control` in `packages/api/src`. If storefronts run on a different origin than the API (likely for Damned/Rotten on their own domains) the browser blocks every authenticated request until you install `@hono/cors`. Add it, **and** lock the origin allowlist per store — the SSRF guard you built doesn't help here.

**A3. In-process rate-limiter + TOTP replay store under multi-instance deployment.** `auth/rate-limit.ts` and `auth/totp.ts` both **explicitly acknowledge** this in their headers ("move the store to Redis when running multiple API instances"). Single-instance today, fine. The day you put API behind a load balancer with N≥2, an attacker round-robins IPs through instances to defeat the login throttle, and a TOTP replay can pass via a different instance after a restart window. **This is the documented single-instance ceiling.**

   Note also: the **job scheduler** in `jobs/scheduler.ts` `setInterval`s in **every** API instance. `FOR UPDATE SKIP LOCKED` saves you from double-delivery but every instance wastes the work and writes the same logs. A Postgres advisory lock (`pg_try_advisory_lock`) is the natural single-leader fix.

**A4. Storefront checkout migration is incomplete — feature-flagged, NOT shipped.** `packages/storefront/package.json` still says `headless commerce storefront for Damned Designs built with Vendure & Qwik`. `VITE_SR_CHECKOUT` defaults to **off** (`providers/shop/checkout/checkout.ts:32-35`). Catalog/cart/auth/account/collections/search all moved to REST, but **checkout + Stripe Elements are still behind the flag**. The existing internal `COMMERCE-GAP-ANALYSIS.md` says this is "in progress" — confirmed by re-grepping the storefront. You cannot cut Vendure over until this lands and you run a side-by-side against real orders.

### B. Tier-1 ops gaps (ship within first month of cutover)

**B1. Zero observability.** No `pino`/`winston`, no OpenTelemetry, no metrics, no request IDs, no `/v1/health` *readiness* check (only liveness — `app.ts:73-92` returns literal `'ok'` with no dependency probes). `console.error` in `app.ts:96` for unhandled errors. When a live customer hits "my payment failed twice" at 11pm, you have nothing to grep. The internal gap-analysis flagged this as "🔴 unknown/absent" but did not assign it as a blocker; I disagree — for a **live** customer-facing cutover it should be.

**B2. No HTTP cache layer.** No `Cache-Control`, no `ETag`, no `Last-Modified` headers anywhere I could find. Every catalog read = full DB query. For small catalogs and storefronts the static `shop-catalog.json` manifest generator covers it, but the dynamic REST path (`/v1/shop/catalog/products`) is uncached. Not a launch blocker for low SKU counts; is one past ~5k SKUs.

**B3. Catalog pagination is OFFSET.** Catalog list (`catalog.ts:64`) and search (`catalog.ts:276`) use `LIMIT/OFFSET` capped at 100. At `offset=10000` Postgres does 10k+ row scans before emitting any result. Cursor-based pagination was explicitly scoped out per the internal doc ("scoped out for now") — fine today, will hurt later. Add it when the first list feels it.

**B4. Asset storage is local-disk only.** `var/assets` (Sharp re-encoded webp, magic-byte validation, 10 MB cap) and `var/downloads` (HMAC-signed short-lived URLs via `licensing/download-url.ts`) live on the API server's filesystem. Multi-instance → inconsistent file state. For a software store with file installers (not just images) you really want object storage (S3/R2) fronted by signed URLs. The HMAC signing layer in `download-url.ts` is 90% reusable for `getSignedUrl`; just swap the transport.

**B5. No second payment gateway.** `SUPPORTED_PAYMENT_METHODS = ['manual', 'cod', 'stripe']` (`payments/provider.ts:75`). Provider abstraction is correct, but only Stripe is live. If your live stores lean on NMI or Sezzle, those aren't wired (the doc flags NMI/Sezzle as backlog). For Damned Designs (Stripe today) this isn't blocking — but plan for it.

**B6. No fulfillment carrier integration.** `shipping/calculator.ts` is server-authoritative flat/configurable only — no UPS/FedEx/USPS rates, no label purchase, no tracking webhook reconciliation. For physical-stock stores this is the biggest gap after multi-tenancy. The doc reads "doesn't apply for digital/software stores" — that's true for ViewRight, less true for Damned.

### C. Tier-2 — add when growth demands

**C1.** **Tax engine is hand-rolled.** `tax_zone` table is fine for US/EU flat rates; no Avalara/TaxJar, no VAT/MOSS for digital goods into EU (real compliance gap if you sell software into EU consumer market).
**C2.** **No abandoned-cart auto-emails wired.** The data is captured, `cart.abandoned` event fires, Listmonk is connected — but the *flow* isn't. Listed as Tier 1 in internal doc, I agree this should land fast.
**C3.** **No saved-payment-method vault routes.** `paymentMethod` table exists but I see no save/list/charge-saved-card endpoints. Schema ready, code missing.
**C4.** **Audit log coverage partial.** `audit_log` writes happen on `dispute_opened`, `refund_reconciled`, stock moves, fulfillment events, subscription lifecycle. Customer/staff/settings/login events aren't audited. For PCI/regulatory it's enough; for forensics on a multi-store SSO it isn't.
**C5.** **RBAC has more framework than enforcement.** `permissions` JSONB on `admin_user_store` is wired, but only `giftcards` and `webhooks` keys are explicitly checked elsewhere. The rest of the app gates only on `role`.
**C6.** **Multi-currency is display-only.** `currency_rate` converts for presentation; real settlement requires a gateway that supports the currency. Fine for now; flag if you sell into markets that *must* settle in local currency.
**C7.** **No localization / translations.** Single-language catalogs. No `product_translation` table.
**C8.** **No headline metrics / no business rules engine.** Dashboard KPIs + basic reports exist (`admin-reports.ts`); cohorts/LTV/attribution/funnels don't.

---

## Specific security findings (the small stuff)

The headline security posture is solid. Walking through the surface more carefully:

- **CORS gap** (A2) — see above. If you serve the storefront from a different origin than the API, you're shipping an XHR-only-prod-when-on-same-origin bug.
- **Stripe webhook tenant trust.** `payment-webhooks.ts:69-71` returns 503 to make Stripe retry on unresolvable subscription events — that's the right move. But `resolveStoreIdForStripeEvent` returns a storeId from `event.metadata.storeId` **after** a UUID regex check but **without** confirming it exists in our `store` table. The mode-bind check (`stripeModeFromConfig(store.config) !== verifiedMode`) catches test→live, but not "TEST event targeting a different TEST tenant". Real mitigation: re-verify by `tx.select({…})` from `store` inside `withStore` before claiming `processedEvent`. Borderline defense-in-depth issue, low risk because the actual reconcile (`tx.select(order).where(eq(code))`) is store-scoped via RLS anyway.
- **Cookie CSRF exemption on `/v1/admin/login` and `/v1/admin/logout`.** Necessary (no session yet to attach a CSRF token to). The protection is "an attacker without the password can't create a session". Reasonable. Worth a comment in the source explaining why, since future contributors will try to "fix" it.
- **TOTP replay store lives in-process** (`auth/totp.ts:48`). Documented limitation; needs Redis once multi-instance.
- **`/v1/shop/auth/check-email` is a deliberate account-existence oracle.** The doc comment acknowledges this ("blunt enumeration/scraping"). Rate-limited per IP. Keep the rate limit if you put anything behind it.
- **`processedEvent.id` is `text`, not UUID.** That's deliberate — it stores Stripe event ids verbatim, which are not UUIDs. But it means the PK is a public, adversary-known string; consider whether `processedEvent.id` should ever be returned in API responses (I don't see it being — good).
- **`accept: 'application/json'` and `content-type` not strictly enforced.** Hono's zod validators will only run on `application/json`; missing headers fall through to 400 from `c.req.valid('json')`. No issue found, just saying.
- **Magic-byte validation on asset uploads** — `admin-assets.ts` uses Sharp's re-encode which throws on non-image input. Strong default.
- **`shop-catalog.json` manifest is regenerated by a script, not a route.** Good — no public vector for a CORS-bypass or admin leak there.
- **One thing I want to flag for review:** in `routes/cart.ts` and similar, store-id resolution always falls back to `damned` when no header is sent. If you deploy behind a CDN that strips custom headers, every request becomes a Damned request. Add a sanity check that returns 404 in prod if no header is present **and** no host-routing maps to `damned`, until host-routing is implemented (A1).

I did **not** find any SQL-injection vector (everything Drizzle-bound or parameterized `sql` template with no string concatenation), any auth-bypass on store-scoped endpoints (everything goes through `withStore`), any plaintext-password storage, any raw card data persistence, or any path-traversal vector in the asset downloader.

---

## Performance analysis

Where the bottlenecks will appear as you scale:

1. **Search is fine until ~50k products.** trigram GIN indexes cover name + description `ILIKE`. Past that, you want a real search engine (Meilisearch is the easy add — it's basically a few-hour job to ingest from the `product` table on save via a `webhook` event). Until you need it, the current setup is enough.
2. **All catalog reads are full DB queries** (see B2 above). Postgres handles thousands of QPS on this schema; once you're past that, front it with a 30s `Cache-Control: public` on the manifest path plus a Redis read-through for dynamic GETs.
3. **Job scheduler is single-instance.** Documented; see A3. Trivially fixed.
4. **Webhooks outbox scales linearly with store count + endpoint count** in `webhooks/emit.ts:35-39` (`for (const st of stores.rows) { await withStore(st.id, async (tx) => …) }`). For 50 stores × 10 endpoints, the per-row claim is fast (single statement, SKIP LOCKED), but the loop is still 50 round-trips to bound-loop. Fine today; if it becomes slow, run per-store workers concurrently with `Promise.all`.
5. **`shop-catalog.json` static manifest regeneration** (`manifest/generate.ts`) — I haven't read this yet, but if it's "walk every store, every product, write a file" it's an O(N×M) offline job. Confirm it scales to 10k+ products per store. Worth a benchmark if you regenerate often.
6. **`pg` pool is 10 connections by default (`env.ts:25-28`).** Untuned. Under load you'll queue. Set `PGPOOL_MAX` to ~ `(CPU cores × 2 + spindles)` and front the API with PgBouncer in transaction mode if you scale out.
7. **Sharp is the only sync block on the asset-upload path** (`admin-assets.ts`). Fine for one upload at a time; backpressure if multiple operators upload concurrently. Probably not blocking for your traffic.

No bad joins I can see. No N+1s. Drizzle's leftJoin + groupBy on catalog list is correct.

---

## Architecture / stack notes

- **Hono** is the right choice for a small, fast, typed REST service. Mature enough that `@hono/zod-openapi` gives you code-first OpenAPI without the codegen burden of NestJS. The one thing Hono doesn't have out of the box is CORS — add `@hono/cors`.
- **Drizzle + Postgres** is genuinely a good fit for this domain (RLS-first, composite FKs, jsonb for snapshots, bigint for big artifacts). You're running `casing: 'snake_case'` correctly (`db/client.ts:15`).
- **ESM + Node 20+ + pnpm 11** is current; `packageManager` pinned. Good.
- **Vitest** is current. Tests are colocated with the code (e.g. `auth/totp.ts` + `auth/email.test.ts`). Pure modules (money/*, auth/password, auth/totp) are well-tested. The Postgres-dependent test files are **excluded by default** from `pnpm test` (`api/package.json:11`) and require the dev DB — run with `pnpm test:db`. That's correct.
- **Workspace hygiene**: storefront + admin are excluded from the pnpm workspace (`pnpm-workspace.yaml:6-9`) so their React/Qwik deps can't pollute the API/shared tree. Smart.
- **No background-worker process separation.** The scheduler lives in the API. For the volumes described (a multi-store brand operator), that's fine. Splitting out a worker process is a one-day refactor when you need it.
- **TypeScript version**: package root declares `^6.0.3` for `typescript`. Current published major as of this year is 5.x — the `^6.0.3` line looks like a future-pinned intent. Not a blocker, just flagging.

---

## Migration-readiness verdict

For **Vendure → SellRight migration of a small brand portfolio** (1-10 stores, Stripe, primarily digital software, modest physical stock):

| Block | Status |
|---|---|
| Money integrity | ✅ Ready |
| Stripe parity (intents + webhooks + refunds + disputes + subscriptions + dunning) | ✅ Ready |
| Catalog parity | ✅ Ready |
| Customer / auth / address book | ✅ Ready (incl. migrated-customer nudging) |
| Orders / fulfillments / returns / refunds | ✅ Ready |
| Multi-tenancy isolation | ✅ Ready (subject to A1) |
| Digital licensing + signed downloads | ✅ Ready |
| Affiliate program | ✅ Ready |
| Webhook delivery | ✅ Ready |
| Tax (US flat rates per zone) | 🟡 Ready |
| Shipping | 🟡 Acceptable if store uses flat tiers only |
| Multi-store host routing (A1) | 🔴 Blocker |
| Storefront checkout/payment migration (A4) | 🔴 Blocker |
| Multi-instance scale hardening (A3) | 🟡 Single-instance launch is fine |
| CORS (A2) | 🟡 Verify storefront same-origin; add if not |
| Observability (B1) | 🔴 Hard recommend pre-launch |
| Saved payment methods / second gateway (B5, C3) | ⚪ Not blocking if not in scope |

**Single-store launch (one brand on one API instance)**: Ready, **conditional** on A1 (host routing), A4 (storefront checkout off the flag), A2 (CORS check), B1 (at minimum a `pino` logger + `/readyz`). Roughly **3-5 weeks of focused work** to close those, given the codebase is in good shape.

**Multi-store / multi-instance launch**: Add A3 (Redis-backed rate-limit + scheduler leader-lock) and B2 (HTTP cache / static manifest). Roughly **6-8 weeks** including load testing.

**Vendure → SellRight data migration**: I see `import/{catalog,customers,orders,store}.ts` scripts and a `src/scripts/provision-right-apps.ts`. These are presumably the Vendure → SellRight ETL. I haven't audited them line-by-line but the presence of `isMigrated` flag and `password_hash: null` import behavior (`auth/session.ts:30-39`) says the customer import is thoughtful. **Add a dry-run mode + row-count diff against Vendure source DB** before you trust it with production data.

**One thing I want to stress**: the things I'd be most worried about in this codebase — race conditions in money paths, off-by-one cents, RLS bypass, SSRF, IDOR, webhook double-fire — are visibly handled. The internal `COMMERCE-GAP-ANALYSIS.md` from two weeks ago is high-quality and mostly self-consistent. You're in good hands from whoever wrote this. The remaining gaps are the boring infrastructure work that always gets left until the last week.

---

## Recommended pre-launch sequence

1. **A1 — host → store routing**. Add a `store_domain` table or per-store `host_pattern` config; route requests by `Host` (or `x-forwarded-host`) before falling back to header. Add a failing test if neither resolves in production.
2. **A4 — flip `VITE_SR_CHECKOUT=1` and remove the flag**. Run side-by-side against real orders for at least one full week. Validate refund, partial-cancel, license-issuance, abandoned-cart flow, address-change post-checkout.
3. **A2 — `@hono/cors` with a per-store origin allowlist + credentials allowed.** Audit any cross-origin admin tooling while you're in there.
4. **B1 — observability floor**. `pino` + request-id middleware + `/readyz` (DB ping + config validated) + `/metrics` (basic counters at minimum, Prometheus or OTel if you have a target). Even a weekend spike-debugging session on the staging box is worth days of saved incident time in production.
5. **A3 — Redis adapter for `auth/rate-limit.ts` + `auth/totp.ts` replay store**, plus a Postgres advisory-lock single-leader for `jobs/scheduler.ts`. Pick the Redis lib (ioredis is fine); interface stays the same.
6. **B4 — S3/R2 asset storage + signed URLs**. Move the `var/assets` writes behind a storage abstraction; reuse the existing `licensing/download-url.ts` HMAC signing for the artifact path.
7. **B2 — HTTP cache headers on `/v1/shop/catalog/*` and `/v1/shop/currencies`** (short TTL, store-ETag).
8. **Cutover plan** — shadow-write Vendure → SellRight for 30 days (let both systems record), prove reconciliation, then flip DNS. The schema + events are already conducive to this (`emitEvent` outbox means you can fan out to a second system with a webhook subscription).
9. **First-week-of-prod monitoring** — webhook-delivery backlog, `release-stale-allocations` dry-run (don't enable apply until you've confirmed cutoff), `cart-maintenance` abandoned count vs Vendure's historical baseline.

---

Want me to dig deeper on any of these? The four I would prioritize looking at together if you're sitting down to plan: A1 (host routing), A4 (checkout off the flag), B1 (observability floor), and the multi-instance story behind A3. The storefront cutoff in particular — I can trace exactly what's left against `VITE_SR_CHECKOUT` and give you a punch list.glmSellRight Security Audit — Readiness for Live-Store Migration (from Vendure)
Scope: packages/api (Hono + Drizzle + Postgres RLS). Read-only audit. Every claim below is traced to file:line. Self-authored docs/COMMERCE-GAP-ANALYSIS.md claims were treated as hypotheses and verified against code, not trusted.
---
Verification of the 5 self-claimed strengths
Claim 1 — "RBAC: 4 roles + per-action permissions, but only giftcards + webhooks enforced." → CONFIRMED, and worse than stated. requirePermission(st, action) exists (admin-helpers.ts:59-63) but is invoked in exactly two places: admin-marketing.ts:295 ('giftcards') and admin-settings-advanced.ts:63 ('webhooks'). UI_PERMISSION_KEYS = ['giftcards','webhooks'] (admin-settings-advanced.ts:318). Every other admin mutation uses only the coarse role checks requireWrite (role ∈ owner/manager/staff) or requireManage (role ∈ owner/manager). See Finding H-3.
Claim 2 — "gateway-before-ledger refund invariant." → CONFIRMED for the admin return-approve path. executeGatewayRefund() (admin-order-payment-helpers.ts:24-46) calls provider.refundPayment() and throws {kind:'providerfail'} on failure before the ledger insert at admin-orders.ts:343. The withStore txn rolls back on the throw — no orphan refund row. ✓ Genuine. (But see H/M findings on refund concurrency and idempotency — the invariant holds per-call, not across concurrent calls.)
Claim 3 — "Webhook signature verification is timing-safe, mode-bound, and the tenant resolver can't be tricked into the wrong store." → CONFIRMED as a real strength. Signature verify tries both test/live secrets via Stripe SDK constructEvent (HMAC-SHA256, timing-safe) (payment-webhooks.ts:44-58). Critically, verifiedMode is then bound to the resolved store's configured mode: if (!store || stripeModeFromConfig(store.config) !== verifiedMode) return; (payment-webhooks.ts:79-80). So a test-secret-signed event cannot settle a live-mode store, and the unscoped payment-ledger fallback in resolveStoreIdForStripeEvent (webhook-reconcile.ts:33) is neutralized by this mode gate. Tenant ids are UUID-validated (webhook-reconcile.ts:18,30). ✓ Solid. Residual: same-mode webhook-secret compromise = full payment forgery (inherent, not a flaw).
Claim 4 — "staging breaks the Secure cookie flag." → CONFIRMED. Secure is set only when NODE_ENV === 'production' (cookies.ts:42 and :68). NODE_ENV defaults to 'development' (env.ts:11) and the enum has no staging value. A staging box that omits NODE_ENV=production boots as development → session cookies have no Secure flag (sent over HTTP) and onError echoes raw err.message to clients (app.ts:97, expose = NODE_ENV !== 'production'). Double footgun. See M-5.
Claim 5 — "Rate limiter in-process Map." → CONFIRMED, with a serious IP-source bypass. const store = new Map(...) (rate-limit.ts:12), per-process, lost on restart, not shared across instances. Worse, clientIp trusts cf-connecting-ip first, then x-real-ip (rate-limit.ts:51) with no trusted-proxy guard — trivially spoofable when Cloudflare isn't in front. See H-2 and L-2.
---
Findings
SEVERITY: High SSRF + Listmonk credential exfiltration via public newsletter endpoint (DNS rebinding)
- Location: packages/api/src/routes/shop-extra.ts:128; contrast packages/api/src/routes/admin-marketing.ts:165,194
- What: The public, unauthenticated POST /v1/shop/newsletter-signup reads store.config.listmonk = {url, apiUser, apiToken} and calls raw fetch(\${lm.url}/api/subscribers\`, { headers: { authorization: \`Basic ${apiUser}:${apiToken}\` }}). It does **not** use safeOutboundFetch. The admin Listmonk path *does*: assertSafeOutboundUrl at save (admin-marketing.ts:194) + safeOutboundFetch (DNS-pinned) at call (admin-marketing.ts:165`). The save-time check is a one-shot validation; the public read path has no runtime private-IP guard and no DNS pinning.
- Why it matters: (1) DNS rebinding — an admin (or a lower-privilege manager) saves a Listmonk URL resolving to a public IP at validation time, then to 169.254.169.254 / http://127.0.0.1:3300/v1/admin/... at newsletter-trigger time. Every public signup then drives a server-side request to the internal network. (2) The Basic-auth header carries the real apiUser:apiToken to whatever lm.url resolves to → Listmonk credential theft via rebinding. (3) The endpoint is unauthenticated and not rate-limited, so an attacker amplifies the SSRF arbitrarily. The outbound-url.ts guard that would prevent all of this is bypassed on this one path.
- Evidence: shop-extra.ts:128 await fetch(\${lm.url.replace(/\/$/,'')}/api/subscribers\`, { method:'POST', headers:{ authorization:\`Basic ${auth}\` ...}}) — no safeOutboundFetch`.
- Benchmark: Shopify never lets storefront code make server-side fetches to operator-supplied URLs; app webhooks go through Shopify's egress with SSRF filtering. Vendure's email/marketing integrations are plugin-mediated and don't expose a public proxy. WooCommerce's Mailchimp integrations call the provider's fixed API host, not an operator-supplied arbitrary URL.
- Fix direction: Route the newsletter signup through the same lm(cfg, '/api/subscribers', …) helper (admin-marketing.ts:162) that already uses safeOutboundFetch; or call assertSafeOutboundUrl + safeOutboundFetch directly in shop-extra.ts. Add per-IP rate limiting. Consider blocking the public endpoint entirely and only syncing via the admin "sync" action.
SEVERITY: High Rate-limit bypass via spoofed cf-connecting-ip / x-real-ip (no trusted-proxy enforcement)
- Location: packages/api/src/auth/rate-limit.ts:50-51; nginx at packages/api/scripts-deploy/nginx-admin.conf:42
- What: clientIp returns cf-connecting-ip ?? x-real-ip ?? remoteAddr ?? 'unknown', trusting both headers unconditionally. nginx sets X-Real-IP $remote_addr (overwriting client values) but does not strip cf-connecting-ip. There is no config indicating whether Cloudflare is actually in front.
- Why it matters: If the API is reachable without Cloudflare (direct :3300, a different proxy, or a store cutover that hasn't put CF in front), any client sends cf-connecting-ip: <random-per-request> → every rate-limited bucket gets a fresh IP → all throttling is defeated: admin login brute-force, customer login/credential-stuffing, checkout spam, payment card-testing, forgot-password flood. X-Forwarded-For is (correctly) ignored, but cf-connecting-ip is checked first and is equally forgeable when CF is absent. For a live-store migration, any store not behind CF has no brute-force protection at all.
- Evidence: rate-limit.ts:51 return c.req.header('cf-connecting-ip') ?? c.req.header('x-real-ip') ?? c.env?.remoteAddr ?? 'unknown';
- Benchmark: Shopify/Vendure rely on edge WAF rate limiting (Cloudflare/AWS WAF) with trusted-proxy configuration; Vendure's req.ip honors a configured proxy trust list, not arbitrary headers. In-process Map limiters (SellRight) are inherently weaker than edge throttling.
- Fix direction: Make the trusted header configurable (TRUSTED_PROXY_HEADER, default x-real-ip), only honor cf-connecting-ip when BEHIND_CLOUDFLARE=1, and have nginx proxy_set_header cf-connecting-ip "" when CF isn't upstream. Better: move throttling to Redis + edge (Cloudflare rate-limit rules) before this is live.
SEVERITY: High RBAC: refunds and all financial/order mutations gated only by coarse staff role — per-action permissions wired for 2 of ~30 mutation routes
- Location: packages/api/src/routes/admin-helpers.ts:42-63; admin-orders.ts:306 (refund/return approve), admin.ts:354 (cancel), admin-catalog.ts:20/42/340/360, admin-assets.ts:36/98, apps.ts:332; admin-settings-advanced.ts:318
- What: requireWrite only excludes read_only. requirePermission(st, action) (the granular gate) is called for only giftcards (admin-marketing.ts:295) and webhooks (admin-settings-advanced.ts:63). Refunds (the most sensitive financial action) require only requireWrite — so any staff-role user (e.g. a fulfillment clerk) can issue refunds, cancel orders, delete products/variants/assets, and publish app releases.
- Why it matters: A compromised or malicious low-privilege staff account (the kind a store hands to a picker/virtual assistant) can drain store revenue via refunds, void orders, or swap downloadable release artifacts. In a multi-operator live store this is a direct money-loss path. The permission framework exists but is ~90% unwired.
- Evidence: admin-orders.ts:306 const st = requireStore(admin, c); requireWrite(st); immediately before the gateway refund at :336. No requirePermission(st,'refunds').
- Benchmark: Shopify enforces distinct staff permissions (refunds, orders, products, draft_orders, gift_cards, etc.) on every mutation; a staff member without refunds cannot refund. Vendure has a Permission enum (Refund, UpdateOrder, DeleteProduct, …) enforced by a @Allow decorator on every admin resolver. SellRight's coarse 3-role write gate is materially weaker than both.
- Fix direction: Define permission keys for every sensitive action (refunds, cancel_orders, products, variants, assets, releases, tax, staff, webhooks, giftcards, returns) and gate each mutation with requirePermission. Default staff to an empty permission set (deny-by-default) rather than blanket write. Add a test asserting every admin POST/PUT/PATCH/DELETE calls a permission gate.
SEVERITY: Medium Cross-store idempotency-key collision on the global processed_event PK silently blocks payments
- Location: packages/api/src/routes/pay.ts:65; packages/api/src/db/schema-content.ts:33; packages/api/src/db/assert-force-rls.ts:20; order code packages/api/src/routes/checkout.ts:48
- What: When no client Idempotency-Key is sent, /pay derives claimKey = \pay:${code}:${method}\` (pay.ts:65). processed_event.id is a **global** text().primaryKey() (schema-content.ts:33), and the table is RLS-exempt (assert-force-rls.ts:20). Order codes are 'SR' + randomUUID().slice(0,10)` = 40 bits of entropy shared across all stores.
- Why it matters: randomUUID is per-call random, so two different stores can independently generate the same 10-hex suffix (birthday bound ≈ 2²⁰ ≈ 1M cumulative orders platform-wide). When that happens, store B's INSERT INTO processed_event (id='pay:SR<colliding>:stripe') ON CONFLICT DO NOTHING returns zero rows → claimed.length === 0 → /pay returns {payment:'already-processed'} for an order that was never paid. The customer is then permanently unable to pay that order (every retry collides). The webhook path is safe (Stripe event.id is globally unique), but the derived-key path is not.
- Evidence: pay.ts:65 const claimKey = idemKey ?? \pay:${code}:${method}\`; + schema-content.ts:33 id: text().primaryKey() (no storeId` in the key).
- Benchmark: Shopify/Vendure scope idempotency per-merchant (Vendure's order code is per-channel and idempotency keys are namespaced per-channel). A global idempotency table without a tenant column is a multi-tenant anti-pattern.
- Fix direction: Include the store in the derived key: pay:${st.id}:${code}:${method} (and similarly for any other derived claim keys). Alternatively make the PK (store_id, id) composite. Add a regression test that two stores with the same order code can each pay independently.
SEVERITY: Medium Refund double-spend race: no row lock on return/order in approve, no Stripe idempotency key on the refund call
- Location: packages/api/src/routes/admin-orders.ts:309,312 (no .for('update')); :322 (alreadyRefunded); packages/api/src/payments/stripe.ts:145; contrast the return-open route at admin-orders.ts:251 which does lock
- What: POST /v1/admin/returns/{id}/approve loads the return (:309) and order (:312) without FOR UPDATE, then checks alreadyRefunded (:322), then calls the gateway (:336), then inserts the refund row (:343). stripeProvider.refundPayment calls refunds.create({payment_intent, amount}) with no idempotencyKey (stripe.ts:145).
- Why it matters: Two concurrent approve calls for the same return (admin double-click, or two operators) both read status='requested' and priorRefunded=0, both pass the balance check, both call Stripe, both insert. The customer is refunded twice (over-refund / double chargeback against the merchant). Separately, holding a DB transaction open across the Stripe network call (:336 inside withStore) with PGPOOL_MAX=10 (env.ts:25) means a few slow Stripe responses can exhaust the pool and stall all requests.
- Evidence: admin-orders.ts:309 const [rr] = await tx.select().from(s.returnRequest).where(eq(s.returnRequest.id, id)).limit(1); (no .for('update')); stripe.ts:145 refunds.create({ payment_intent: input.providerRef, amount: input.amount }) (no idempotency key).
- Benchmark: Shopify passes an idempotency key on refund API calls and locks the order during refund. Vendure's refund flow holds an optimistic lock on the order and refuses concurrent refunds. Stripe strongly recommends Idempotency-Key on refunds.create to survive retries.
- Fix direction: SELECT ... FOR UPDATE on both returnRequest and order at the start of approve (re-check rr.status after lock). Pass an idempotencyKey (e.g. refund:${rr.id}) to stripe.refunds.create. Move the gateway call outside the DB transaction (claim the row, commit, call Stripe, then open a second txn to record the ledger) to avoid long-held txns.
SEVERITY: Medium Secure cookie flag + error-message leakage tied to NODE_ENV === 'production' (staging footgun)
- Location: packages/api/src/auth/cookies.ts:42,68; packages/api/src/app.ts:97; packages/api/src/env.ts:11
- What: Secure is appended only when NODE_ENV === 'production'. NODE_ENV defaults to 'development' and the enum is ['development','test','production'] — there is no staging. The same switch controls error disclosure: expose = process.env.NODE_ENV !== 'production' echoes raw err.message (app.ts:97).
- Why it matters: A staging or pre-prod box mirroring the live migration that boots without NODE_ENV=production serves admin/customer session cookies without Secure over any HTTP hop (downgrade/MitM on the staging network steals the 14-day admin token) and returns internal error text to clients (stack hints, DB column names, Stripe error bodies). Both are exactly what you don't want during a sensitive cutover. The binary switch also means you cannot have Secure cookies in local HTTPS dev.
- Evidence: cookies.ts:42 const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';; app.ts:97 const expose = process.env.NODE_ENV !== 'production';
- Benchmark: Shopify/Vendure set Secure from the request scheme (TLS-present), not from a deploy env string, and never expose raw errors in any non-local config. Vendure's apiOptions.errorHandling always sanitizes.
- Fix direction: Derive Secure from the request's X-Forwarded-Proto/scheme (c.req.header('x-forwarded-proto') === 'https') instead of NODE_ENV. Always sanitize error messages (return 'internal error' unless an explicit debug flag is on). Add a boot-time check that refuses to start in production without NODE_ENV=production.
SEVERITY: Medium assert-force-rls is a dev-time CI check, not a runtime invariant; staff_invite has no RLS and is read cross-store
- Location: packages/api/src/db/assert-force-rls.ts:20,36 (exempt set + pool.end()); packages/api/src/auth/admin-staff.ts:186-201,205-207; drizzle/0008_admin_store_registry_disable_rls.sql
- What: The FORCE-RLS gate runs via pnpm verify against env.DATABASE_URL (the dev DB) and pool.end()s — it is not enforced at boot or against prod. Its exempt set includes staff_invite, which therefore has no RLS policy (confirmed: 0008 disables RLS on admin_user_store; staff_invite is listed exempt and never given a policy in 0001). listStoreInvites and findInviteByTokenHash (admin-staff.ts:186,205) read it via the unscoped client.
- Why it matters: If a future migration lands a new store-scoped table without FORCE RLS in prod (e.g. a migration applied out-of-order, or a hotfix), the dev-only gate won't catch the prod drift — a table that silently has ENABLE-but-not-FORCE RLS under the non-owner role can leak cross-tenant. staff_invite containing email + role + storeId is readable cross-store by any code path that reaches the unscoped client; today that's only admin-staff.ts, but the exempt-from-lint boundary is a regression risk (the file's own header :9-15 acknowledges this).
- Evidence: assert-force-rls.ts:20 const EXEMPT = new Set(['store','admin_user_store','session','processed_event','staff_invite']); and :36 await pool.end(); (one-shot, dev DB).
- Benchmark: Shopify (multitenant SaaS) isolates tenants via row-level scoping enforced by the framework + runtime checks, not a CI script. Vendure's multi-channel isolation is enforced in the service layer per-request. A dev-time-only RLS gate is weaker than a runtime assertion.
- Fix direction: Promote the FORCE-RLS check to a boot-time self-test (run once at startup against the connected prod DB; fail-fast if any non-exempt store-scoped table lacks FORCE RLS). Either give staff_invite an RLS policy (with an unscoped-by-token-hash exception) or document the exempt boundary and add a lint rule that staff_invite reads in admin-staff.ts must always filter by storeId except the single token-hash lookup.
SEVERITY: Medium 2FA enable/disable not rate-limited; TOTP compare not constant-time → 6-digit brute-force on a stolen session
- Location: packages/api/src/routes/admin-settings.ts:76-87,96-105; packages/api/src/auth/totp.ts:56
- What: /v1/admin/2fa/disable requires a valid TOTP code (admin-settings.ts:101) — good — but neither disable nor enable is rate-limited, and verifyTotp compares hotp(...) !== code.trim() (totp.ts:56) with JS !== (not timingSafeEqual). The replay map in totp.ts:48 only blocks reused codes, not brute-force.
- Why it matters: An attacker who obtains a valid admin session cookie (14-day TTL, no Secure on a misconfigured staging box — see M-5) can brute-force the 6-digit TOTP to disable 2FA: ~10⁶ space, ±1 step ⇒ 3 live codes, no throttle on the endpoint ⇒ at modest request rates feasible in minutes-to-hours. The non-constant-time compare additionally leaks prefix matches (mitigated by the 401-either-way response, but the endpoint timing still varies). Once 2FA is off, the session alone fully owns the admin account.
- Evidence: admin-settings.ts:96 disable handler has no loginRetryAfter; totp.ts:56 if (hotp(secret, step + w) !== code.trim()) continue;.
- Benchmark: Shopify requires re-authentication (password) plus a verified code to disable 2FA and rate-limits TOTP attempts. GitHub rate-limits 2FA challenges and locks after repeated failures.
- Fix direction: Rate-limit /2fa/disable and /2fa/enable per-admin (e.g. 5/15min). Use timingSafeEqual for the 6-digit compare. Consider requiring the current password (re-auth) in addition to the TOTP code to disable 2FA, and shortening the admin session TTL or adding session rotation.
SEVERITY: Low CSRF guard exempts any request carrying an Authorization header (latent bypass; auth chain falls back to cookie)
- Location: packages/api/src/auth/cookies.ts:57,81; packages/api/src/routes/admin-helpers.ts:26; packages/api/src/auth/session.ts:79
- What: csrfValid/customerCsrfValid return true whenever c.req.header('authorization') is present. requireAdmin/customerToken resolve the token as bearer(header) ?? cookie(...) — so a request with a bogus Authorization header still authenticates via the victim's cookie, while CSRF is skipped.
- Why it matters: Browsers do not auto-attach Authorization, and a cross-origin fetch with a custom header + credentials:'include' triggers a CORS preflight that the attacker can't satisfy without permissive CORS (none observed in app.ts). So this is not practically exploitable today, but it is a latent CSRF bypass: if permissive CORS is ever added, or HTTP Basic auth is ever layered on the API origin (auto-attached Authorization), the double-submit protection evaporates for cookie-authenticated victims. Defense-in-depth should not rely on "browsers don't send this header."
- Evidence: cookies.ts:57 if (c.req.header('authorization')) return true; + admin-helpers.ts:26 const token = bearer(...) ?? cookie(c, SESSION_COOKIE);
- Benchmark: Shopify/Vendure CSRF tokens are validated independently of the auth scheme; presence of an alternate auth header does not waive CSRF.
- Fix direction: Validate the bearer token (reject the CSRF exemption if the bearer is absent/invalid) rather than exempting on header presence alone; or have the auth chain refuse cookie fallback when an Authorization header is present.
SEVERITY: Low Sensitive endpoints with no rate limiting
- Location: packages/api/src/routes/customer-tokens.ts:60-86 (reset-password); packages/api/src/routes/auth.ts:147 (Google login); packages/api/src/routes/apps.ts:82,106 (license activation, both variants); packages/api/src/routes/shop-extra.ts:114 (newsletter signup) and ~95 (gift-card balance check)
- What: These have no clientIp/loginRetryAfter call. Rate-limited for comparison: admin login (admin.ts:36), customer register (auth.ts:69), customer login (auth.ts:114), check-email (auth.ts:212), forgot-password (customer-tokens.ts:42), verify-email (customer-tokens.ts:108), checkout (checkout.ts:102), pay (pay.ts:40).
- Why it matters: reset-password tokens are 256-bit so not brute-forceable, but the endpoint is an unthrottled DB lookup (minor DoS). License activation mints a 256-bit activationToken (download/update capability) on success; license keys are 128-bit random (issue.ts:8, SR-APPKEY-<32hex>) so guessing is infeasible, but an attacker who knows a leaked/pirated key can spam activations to exhaust seat limits (DoS on legitimate customers). Newsletter signup is an unthrottled SSRF amplifier (see H-1) and Listmonk-flood vector. Gift-card balance check (GC- + 48-bit, admin-marketing.ts:272) is unthrottled but 48-bit is not network-brute-forceable.
- Evidence: customer-tokens.ts:67 reset handler — no rate-limit call; apps.ts:82 activate handler — none.
- Benchmark: Shopify rate-limits password-reset and all auth-adjacent endpoints at the edge; license/activation endpoints in app stores are rate-limited per IP+device.
- Fix direction: Add per-IP rate limiting to reset-password, Google login, license activation (per IP+device), and newsletter signup. Edge (Cloudflare) rate-limit rules are the right primary control.
SEVERITY: Low TOTP code comparison is not constant-time
- Location: packages/api/src/auth/totp.ts:56
- What: hotp(secret, step+w) !== code.trim() uses JS string inequality (early-exit on first differing char).
- Why it matters: A timing side-channel on the 6-digit code could in theory leak matching prefixes. Practical impact is low because (a) the admin-login 401 is identical for bad password/TOTP and is itself rate-limited (8/15min per IP+email, admin.ts:36-48), and (b) the TOTP secret is unknown to the attacker. But the 2FA disable endpoint (M-4) lacks that rate limit, so the timing leak is more useful there.
- Evidence: totp.ts:56.
- Benchmark: RFC 6238 reference impls and GitHub/Authy compare codes in constant time.
- Fix direction: Compare the 6-digit strings with timingSafeEqual (pad/length-check first).
SEVERITY: Low Open redirect on licensed-download external artifact path
- Location: packages/api/src/routes/apps.ts:300 (and the admin release create at apps.ts:41-54)
- What: GET /v1/dl/{artifactKey} (and the entitlement-gated /downloads endpoint) redirect to artifact.path when it matches ^https?://. artifact.path is admin-supplied (CreateReleaseIn.path: z.string().min(1), apps.ts:43) with no host allowlist.
- Why it matters: An admin (or any staff role via the release-create endpoint, per H-3) can set artifact.path = https://evil.example/legit-installer so that a signed download link from the legitimate domain 302-redirects to an attacker host — a credible malware-delivery phishing vector for software-update flows. The signed URL binds storeId+artifactKey+exp but not the redirect target.
- Evidence: apps.ts:300 if (/^https?:\/\//i.test(artifact.path)) return c.redirect(artifact.path, 302);.
- Benchmark: GitHub release assets, Electron auto-updater, and Shopify file links serve from fixed CDN hosts (objects), not operator-supplied arbitrary URLs; update manifests pin and verify artifact hashes (SellRight stores sha256 but doesn't verify on redirect).
- Fix direction: Allowlist external storage hosts (e.g. *.r2.cloudflarestorage.com), or require local DOWNLOAD_DIR paths only. At minimum, gate release creation behind requirePermission(st,'releases') and require owner/manager for external-path artifacts.
SEVERITY: Info Dependency & image-parsing surface
- Location: packages/api/package.json (sharp ^0.35.1, stripe ^22.2.1, hono ^4.12.26, drizzle-orm ^0.45.2, pg ^8.21.0, zod ^3.25.76); engines.node >=20 running v26.4.0; packages/api/src/routes/admin-assets.ts:59
- What: Asset upload decodes/re-encodes untrusted images with sharp (admin-assets.ts:48-59). sharp bundles libvips/libwebp/libpng — historically CVE-rich (e.g. libwebp/CVE-2023-4863 heap overflow, libpng issues). The handler is admin-only and re-encodes to webp (which strips most payload vectors), but a malformed upload by a low-privilege staff user (H-3) could still target a parser bug. Versions are recent; I could not run pnpm deps:audit in this read-only pass. Node 26 is very new (engine says ≥20).
- Why it matters: Image parsing of untrusted bytes is a classic RCE/memory-corruption surface. Admin-only limits exposure; the coarse staff RBAC (H-3) widens it.
- Evidence: admin-assets.ts:59 await sharp(buf).webp({ quality: 85 }).toFile(absPath);.
- Benchmark: Shopify transcodes uploads in an isolated worker with strict size/type limits and patched libvips; WooCommerce uses WordPress's image processors with the same CVE exposure.
- Fix direction: Run pnpm run deps:audit + deps:check and pin sharp to the latest patched release; keep sharp/libvips on a regular update cadence. Consider offloading transcoding to a sandboxed sidecar. Confirm Node 26 is intentional vs. the declared ≥20.
SEVERITY: Info Secrets/logging hygiene and .gitleaks
- Location: packages/api/src/app.ts:96; packages/api/.gitleaks.toml (repo-root file is a thin allowlist); packages/api/src/scripts/seed-admin.ts:19
- What: onError does console.error('[api error]', err) (full error incl. stack/attributes) and only returns err.message when NODE_ENV !== 'production'. In production the response is sanitized to 'internal error', but the server-side console.error(err) can still log sensitive attributes (Stripe error bodies, config values) to stdout — acceptable if logs are scoped, but worth confirming no PII/secrets flow to the log aggregator. No console.log of token|password|secret|stripe|webhook_secret was found in API src (grep returned only seed-admin.ts exit logging). .gitleaks.toml allowlists a single historical IndexNow key in packages/storefront — narrow and acceptable. DOWNLOAD_URL_SECRET and STRIPE_* are optional() in env.ts — fail-safe (downloads 503, Stripe 503) but a prod deploy that forgets them silently degrades rather than fails boot.
- Evidence: app.ts:96 console.error('[api error]', err);.
- Benchmark: Shopify/Vendure redact secrets in structured logs and fail-fast on missing critical secrets in production.
- Fix direction: In production, require STRIPE_SECRET_KEY_LIVE, STRIPE_WEBHOOK_SECRET_LIVE, and DOWNLOAD_URL_SECRET to be set (fail boot). Scrub known-sensitive keys from console.error(err) (serialize with a redactor). Run gitleaks detect on the full history as part of the cutover.
SEVERITY: Info Verified strengths worth keeping (no action — listed for the record)
- Session/token entropy & storage: admin/customer sessions are 32-byte (randomBytes(32)) tokens stored only as SHA-256 hashes (admin-session.ts:34, session.ts:12); CSRF tokens 16-byte (cookies.ts:38); password-reset/email-verify tokens 32-byte hashed (customer-tokens.ts:47,82); activation tokens 32-byte hashed (tokens.ts:3-8). No session fixation (fresh token per login; sessions deleted on password reset, customer-tokens.ts:80). Password hashing is scrypt with timingSafeEqual verify (password.ts). ✓
- Account-enumeration resistance: login/forgot-password return generic messages; check-email is explicitly rate-limited and documented as a deliberate oracle (auth.ts:196-222, admin.ts:39-48). ✓
- Checkout server-authority: totals are recomputed server-side, coupon re-validated, stock allocated atomically (checkout.ts:53-55); verifyIntent re-checks amount/currency/orderCode against the order row and never trusts client-reported success (stripe.ts:110-120). ✓
- RLS fail-closed posture: withStore uses SET LOCAL (client.ts:46); nullif(...,'') hardening so an empty/reset app.current_store yields zero rows (drizzle/0002); FORCE RLS on all data tables (drizzle/0001); eslint no-restricted-imports blocks unsafeUnscopedDb in src/routes/** (eslint.config.js:32-55); assert-shop-route-isolation.mjs blocks it in shop routes. ✓ (Caveats in M-3.)
- Licensed-download signing: HMAC-SHA256, constant-time, binds (storeId, artifactKey, exp), 15-min TTL, fails loud when DOWNLOAD_URL_SECRET unset; consumer re-validates UUID + sig and applies a path-traversal guard (download-url.ts, apps.ts:282-304). ✓
- Outbound-URL SSRF guard: thorough private-IP/IPv6-mapping/zone-index/redirect blocking with DNS pinning (outbound-url.ts); used by webhook emit (emit.ts:71), admin Listmonk (admin-marketing.ts:165), and webhook-endpoint creation (admin-settings-advanced.ts:65). ✓ (Gap in H-1.)
---
Security verdict for live-store migration: GO-WITH-CONDITIONS
The core payment/RLS/session primitives are well-built (verified claims 2 and 3 are real; token hygiene and verifyIntent are solid). The platform is not No-Go, but it must not take over live revenue until the following hard blockers are closed:
Hard blockers (must fix before cutover):
1. H-1 — Newsletter SSRF + Listmonk cred exfil. Route shop-extra.ts:128 through safeOutboundFetch and rate-limit it. One-line-class fix with high impact (publicly triggerable internal-network reach + credential theft).
2. H-2 — Rate-limit IP spoofing. Stop unconditionally trusting cf-connecting-ip/x-real-ip; make the trusted header configurable and require Cloudflare to be declared in front, or put edge rate-limiting in place for every store before cutover. Without this, brute-force protection is illusory for any store not behind CF.
3. H-3 — RBAC on refunds. A staff-role user can issue refunds today. Wire requirePermission(st,'refunds') (and cancel_orders, releases, …) before handing staff accounts to operators on live stores.
4. M-5 — Staging Secure-cookie + error-leak footgun. Derive Secure from request scheme, not NODE_ENV; sanitize errors unconditionally; fail boot in prod without NODE_ENV=production. A misconfigured staging box during cutover leaks the 14-day admin token.
Strongly recommended before cutover (not strictly blocking, but fix in the same change window):
- M-1 (idempotency key namespacing — silent payment blocking is a severe failure mode), M-2 (refund double-spend race + Stripe idempotency key + move gateway call out of the DB txn), M-4 (rate-limit + constant-time TOTP on 2FA disable).
- Close the two Low CSRF/redirect gaps if CORS or external-CDN artifacts are part of the migration.
- Run pnpm run deps:audit + gitleaks detect on full history, and confirm STRIPE_*_LIVE + DOWNLOAD_URL_SECRET are set in prod env (currently optional).
Once H-1/H-2/H-3/M-5 are remediated and the recommended items are scheduled, SellRight meets a defensible bar to begin assuming live stores from Vendure, with the multi-tenant RLS and payment-verification core being its genuine strengths.
spawn_agent(Audit SellRight (D:\claude\sellright, API in packages/api) f...)
▶ Thinking: ...env.ts, schema files, and migrations.  Let me begin by exploring the repo structure and reading the critical files in parallel.
I'll start by reading the foundational files in parallel, then trace deeper into the routes and payment paths.
read_files(D:\claude\sellright\packages\api\src\db\client.ts, start_line=undefined, end_line=undefined; D:\claude\sellright\packages\api\src\env.ts, start_line=undefined, end_line=undefined; .../D:\claude\sellright\packages\api\src\db\schema-core.ts, start_line=undefined, end_line=undefined; .../D:\claude\sellright\packages\api\src\db\schema-orders.ts, start_line=undefined, end_line=undefined; .../D:\claude\sellright\packages\api\src\db\schema-content.ts, start_line=undefined, end_line=undefined)
⎿ 1049 lines | typescript
run_commands(powershell -NoProfile -Command Get-ChildItem -Path 'D:\claude\sellright\packages\api\drizzle' -Filter '*.sql' | Sort-Object Name | Select-Object -ExpandProperty Name)
⎿ 0000_conscious_black_widow.sql
   ... 36 more lines
▶ Thinking: ...e the full schema-core, schema-orders, and schema-content files since they were truncated. Let me also read the key migrations.
Let me read the critical migrations and the rest of the schema files (they were truncated).
read_files(.../D:\claude\sellright\packages\api\drizzle\0007_order_idempotency_and_indexes.sql, start_line=undefined, end_line=undefined; .../D:\claude\sellright\packages\api\drizzle\0022_indexes.sql, start_line=undefined, end_line=undefined; .../D:\claude\sellright\packages\api\drizzle\0028_licensing_indexes.sql, start_line=undefined, end_line=undefined; .../D:\claude\sellright\packages\api\drizzle\0029_product_search_trgm.sql, start_line=undefined, end_line=undefined; .../D:\claude\sellright\packages\api\src\db\schema-core.ts, start_line=85, end_line=260; .../D:\claude\sellright\packages\api\src\db\schema-orders.ts, start_line=91, end_line=295)
⎿ 456 lines | sql
▶ Thinking: ...o find the payment table definition. It's probably between orderLine and refund. Let me read schema-orders around line 175-211.
Now the CRITICAL payment paths. Let me read checkout, pay, settle, stripe, and webhooks in parallel.
read_files(.../D:\claude\sellright\packages\api\src\routes\checkout.ts, start_line=undefined, end_line=undefined; D:\claude\sellright\packages\api\src\routes\pay.ts, start_line=undefined, end_line=undefined; .../D:\claude\sellright\packages\api\src\payments\settle.ts, start_line=undefined, end_line=undefined; .../D:\claude\sellright\packages\api\src\payments\stripe.ts, start_line=undefined, end_line=undefined; .../D:\claude\sellright\packages\api\src\routes\payment-webhooks.ts, start_line=undefined, end_line=undefined; .../D:\claude\sellright\packages\api\src\payments\webhook-reconcile.ts, start_line=undefined, end_line=undefined)
⎿ 1055 lines | typescript
read_files(.../D:\claude\sellright\packages\api\src\db\schema-orders.ts, start_line=175, end_line=211)
⎿ 37 lines | typescript
▶ Thinking: ...r.charge()` / `verifyIntent()` (which calls Stripe) happen INSIDE `withStore(tx)`? Let me read the truncated section of pay.ts.
The pay.ts body was truncated around the critical claim/charge logic. Let me read the full pay.ts handler body and the checkout.ts payment section.
read_files(D:\claude\sellright\packages\api\src\routes\pay.ts, start_line=55, end_line=86; .../D:\claude\sellright\packages\api\src\routes\checkout.ts, start_line=130, end_line=322)
⎿ 225 lines | typescript
search_codebase(charge\s*[:=]|async charge|PaymentProvider, verifyIntent, claimIdempotency|processedEvent.*insert|INSERT INTO processed_event)
⎿ Found 9 results for pattern: charge\s*[:=]|async charge|PaymentProvider
README.md:7:149
  8: 
... 105 more lines
▶ Thinking: ...he DB connection open across the network call.  Let me read the stripe provider's createPayment / verifyIntent and provider.ts.
Confirmed the smoking gun in pay.ts line 73. Now let me verify what provider.createPayment does for Stripe (is it an outbound HTTP call?) and read the provider definitions, plus the list/route files.
read_files(.../D:\claude\sellright\packages\api\src\payments\stripe.ts, start_line=72, end_line=130; .../D:\claude\sellright\packages\api\src\payments\provider.ts, start_line=undefined, end_line=undefined; .../D:\claude\sellright\packages\api\src\auth\rate-limit.ts, start_line=undefined, end_line=undefined; .../D:\claude\sellright\packages\api\src\jobs\scheduler.ts, start_line=undefined, end_line=undefined)
⎿ 283 lines | typescript
read_files(.../D:\claude\sellright\packages\api\src\routes\admin-orders.ts, start_line=1, end_line=130; .../D:\claude\sellright\packages\api\src\routes\admin-products.ts, start_line=1, end_line=130; .../D:\claude\sellright\packages\api\src\routes\admin-dashboard.ts, start_line=undefined, end_line=undefined; .../D:\claude\sellright\packages\api\src\routes\admin-reports.ts, start_line=undefined, end_line=undefined)
⎿ 626 lines | typescript
▶ Thinking: ...enerate.ts.  Let me also confirm stripeProvider.createPayment does an HTTP call (stripe.ts 125-142).  Let me batch these reads.
Now the Stripe provider's createPayment (does it hit the network?), the catalog/orders/cart routes, the manifest generator, and the rest of admin-reports + admin-orders list.
read_files(.../D:\claude\sellright\packages\api\src\payments\stripe.ts, start_line=122, end_line=142; .../D:\claude\sellright\packages\api\src\routes\catalog.ts, start_line=undefined, end_line=undefined; .../D:\claude\sellright\packages\api\src\routes\orders.ts, start_line=undefined, end_line=undefined; .../D:\claude\sellright\packages\api\src\routes\cart.ts, start_line=undefined, end_line=undefined; .../D:\claude\sellright\packages\api\src\manifest\generate.ts, start_line=undefined, end_line=undefined)
⎿ 874 lines | typescript
read_files(.../D:\claude\sellright\packages\api\src\routes\admin-reports.ts, start_line=58, end_line=247; .../D:\claude\sellright\packages\api\src\routes\admin-orders.ts, start_line=130, end_line=320)
⎿ 381 lines | typescript
▶ Thinking: ...call inside txn)  Let me batch these. Let me first search for the orders list endpoint and bulk, and read emit.ts and the jobs.
Let me find the admin orders list + bulk endpoints, the webhook delivery loop, the job implementations, and confirm the refund gateway call location.
search_codebase(path: '/v1/admin/orders'[^/]|get', path: '/v1/admin/orders'\), bulk|cancel-bulk|orders/bulk|purge, executeGatewayRefund, deliverWebhooks|async function deliverWebhooks|for .*webhook_delivery)
⎿ Found 1 result for pattern: path: '/v1/admin/orders'[^/]|get', path: '/v1/admin/orders'\)
packages\api\src\routes\admin.ts:89:20
  90:     request: { query: z.object({ state: z.string().optional(), q: z.string().optional(), preOrder: z.coerce.boolean().optional(), trashed: z.coerce.boolean().default(false), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25) }) },
... 261 more lines
read_files(.../D:\claude\sellright\packages\api\src\webhooks\emit.ts, start_line=undefined, end_line=undefined; .../D:\claude\sellright\packages\api\src\jobs\cart-maintenance.ts, start_line=undefined, end_line=undefined; .../D:\claude\sellright\packages\api\src\jobs\auto-deliver.ts, start_line=undefined, end_line=undefined; .../D:\claude\sellright\packages\api\src\jobs\release-stale-allocations.ts, start_line=undefined, end_line=undefined; .../D:\claude\sellright\packages\api\src\jobs\webhook-reaper.ts, start_line=undefined, end_line=undefined)
⎿ 367 lines | typescript
▶ Thinking: ... }` and it imports executeGatewayRefund. Let me read admin-orders.ts 178-230 and admin-order-payment-helpers.ts.  Let me batch.
Now the admin orders list, bulk ops, the refund gateway-call location, and import scripts.
read_files(.../D:\claude\sellright\packages\api\src\routes\admin.ts, start_line=80, end_line=200; .../D:\claude\sellright\packages\api\src\routes\admin-order-ops.ts, start_line=undefined, end_line=undefined; .../D:\claude\sellright\packages\api\src\routes\admin-order-payment-helpers.ts, start_line=undefined, end_line=undefined; .../D:\claude\sellright\packages\api\src\routes\admin-orders.ts, start_line=178, end_line=230)
⎿ 586 lines | typescript
read_files(.../D:\claude\sellright\packages\api\src\import\orders.ts, start_line=undefined, end_line=undefined; .../D:\claude\sellright\packages\api\src\import\catalog.ts, start_line=undefined, end_line=undefined; .../D:\claude\sellright\packages\api\src\import\customers.ts, start_line=undefined, end_line=undefined)
⎿ 569 lines | typescript
▶ Thinking: ...alog.ts 103-256 (product detail N+1 check) - check the bulk route definitions for batch size caps  Let me do these in parallel.
Let me check the product detail path for N+1, search for any HTTP caching, and confirm the bulk-op batch caps + store resolution cost.
read_files(.../D:\claude\sellright\packages\api\src\routes\catalog.ts, start_line=103, end_line=256; .../D:\claude\sellright\packages\api\src\routes\store-context.ts, start_line=undefined, end_line=undefined; .../D:\claude\sellright\packages\api\src\routes\admin-order-ops.ts, start_line=60, end_line=180)
⎿ 297 lines | typescript
search_codebase(cache-control|Cache-Control|stale-while-revalidate|ETag|etag|s-maxage|max-age, resolveStoreFromCtx|async function resolveStoreFromCtx|resolveStore\(, sharp\(|import sharp|toFormat|resize\()
⎿ Found 22 results for pattern: cache-control|Cache-Control|stale-while-revalidate|ETag|etag|s-maxage|max-age
packages\storefront\vite.config.ts:158:10
  159:         // Security Headers
... 379 more lines
▶ Thinking: ...port. Let me also quickly verify there's no in-process store cache by checking store-context.ts.  Let me read store-context.ts.
Let me confirm the per-request store resolution (caching?) and check the abandoned-carts / smart-collection query shapes I flagged.
read_files(.../D:\claude\sellright\packages\api\src\store-context.ts, start_line=1, end_line=70)
⎿ 46 lines | typescript
search_codebase(new Map\(\)|const _cache|_clients\.set|let _webhookVerifier, FOR UPDATE|for\('update'|SKIP LOCKED, orderId.*idx|orders?_store.*customer|index.*on.*order.*customer)
⎿ Found 3 results for pattern: new Map\(\)|const _cache|_clients\.set|let _webhookVerifier
packages\admin\src\components\Toast.tsx:78:72
  79: 
... 139 more lines
▶ Thinking: ...port-tracking; need the cancel/fulfill/purge caps).  Let me read admin-assets.ts and the bulk cancel/fulfill route definitions.
Let me confirm the sharp/image-processing memory path and the bulk cancel/fulfill batch caps.
read_files(, start_line=undefined, end_line=60; .../D:\claude\sellright\packages\api\src\routes\admin-assets.ts, start_line=1, end_line=60; .../D:\claude\sellright\packages\api\src\routes\admin-order-ops.ts, start_line=205, end_line=245)
   ! Invalid read_files input; tool call skipped.
search_codebase(import sharp|from 'sharp'|sharp\(buffer|sharp\(path, z\.array\(z\.object.*code.*\)\.max\(|codes.*\.max\(|rows.*\.max\(\d+\))
⎿ Found 1 result for pattern: import sharp|from 'sharp'|sharp\(buffer|sharp\(path
packages\api\src\routes\admin-assets.ts:10:1
  11: import { sql, eq } from 'drizzle-orm';
... 21 more lines
▶ Thinking: ...me read admin-assets.ts and admin-order-ops.ts around 180-320 to find the bulk cancel/fulfill route definitions and their caps.
read_files(.../D:\claude\sellright\packages\api\src\routes\admin-assets.ts, start_line=1, end_line=70; .../D:\claude\sellright\packages\api\src\routes\admin-order-ops.ts, start_line=185, end_line=320)
⎿ 206 lines | typescript
▶ Thinking: ... me re-read it. Actually it said "[outdated - see the latest file content]" which means I should re-read. Let me read it again.
read_files(.../D:\claude\sellright\packages\api\src\routes\admin-order-ops.ts, start_line=183, end_line=320)
⎿ 138 lines | typescript
▶ Thinking: ...e read 103-257 now to confirm the collections list + smart collection browse. This is important for the N+1/unbounded findings.
Let me read the catalog collections + smart-collection browse section (the part that was truncated) to confirm the unbounded in-memory filter.
read_files(.../D:\claude\sellright\packages\api\src\routes\catalog.ts, start_line=175, end_line=257)
⎿ 83 lines | typescript
▶ Thinking: ...get the EXACT quote for the report (the smoking gun). The earlier targeted read returned "[outdated]". Let me re-read it fresh.
Let me re-read the exact pay.ts transaction body (the smoking gun) to quote it precisely, and confirm the Stripe provider's createPayment network call.
read_files(D:\claude\sellright\packages\api\src\routes\pay.ts, start_line=55, end_line=87; .../D:\claude\sellright\packages\api\src\payments\stripe.ts, start_line=108, end_line=142)
⎿ 68 lines | typescript
▶ Thinking: ...O for a live-store migration as-is, with a clear path to GO-WITH-CONDITIONS after the critical fixes.  Let me write the report.
I now have comprehensive evidence across all 12 areas. Here is the structured performance & scalability audit.
---
SellRight Performance & Scalability Audit — Live-Store Migration Readiness
Scope: packages/api, single Node process, node-postgres Pool (default max=10), Drizzle ORM, Postgres RLS, transaction-per-request (withStore). Read-only code audit — no edits, no runs.
Verdict up front: NO-GO for a live-store cutover as-shipped. Two hard blockers (outbound Stripe calls inside DB transactions holding pooled connections + row locks) plus a non-existent horizontal-scale story. Fixable; path to GO-WITH-CONDITIONS below.
---
CRITICAL
IMPACT: Critical Outbound Stripe paymentIntents.retrieve() executed INSIDE the withStore DB transaction
- Location: src/routes/pay.ts:55–86 (call at :73); network call at src/payments/stripe.ts:135
- Symptom under load: During concurrent checkout/pay, the Postgres connection pool exhausts and the system appears to hang. The 11th concurrent store-scoped request waits forever (see pool finding). No request ever returns a clean 503 — latency cascades.
- Root cause: The entire /v1/shop/orders/{code}/pay handler body runs inside withStore(st.id, async (tx) => …) (pay.ts:55). Inside that transaction it:
  1. reads the order (:56),
  2. inserts an idempotency claim into processed_event (:66–70) — the processed_event PK unique index becomes a serialization point,
  3. calls provider.createPayment(...) (:73) — for Stripe this is await stripeClient(mode).paymentIntents.retrieve(intentId) (stripe.ts:135), a synchronous outbound HTTPS round-trip to Stripe,
  4. then writes the payment row + transitions the order + issues licenses (:75 → settle.ts).
  So one of the (max 10) pooled connections and the idempotency claim row are held open across a network call to a third party. This is the textbook "DB transaction held across an outbound HTTP call" anti-pattern.
- Evidence:
    // pay.ts:55
  const out: R = await withStore(st.id, async (tx): Promise<R> => {
    const [order] = await tx.select().from(s.order)…            // :56
    const claimed = await tx.insert(s.processedEvent)…           // :66  claim held
    const result = await provider.createPayment({…stripeMode…}); // :73  ← STRIPE HTTPS, in-txn
    const applied = await applyPaymentResult(tx, {…});           // :75  writes ledger
      // stripe.ts:135 (inside stripeProvider.createPayment)
  pi = await stripeClient(input.stripeMode).paymentIntents.retrieve(intentId);
  - Benchmark: Shopify never holds a DB connection across a gateway call — payment authorization is an async job/step (Stripe webhook-driven state machine); the checkout writes the order, hands off to Stripe, and the confirmation arrives via webhook. Vendure likewise decouples payment settlement from the DB transaction (PaymentState transitions are event-driven). Both treat the gateway RTT as non-DB-holding.
- Fix direction (P0): Move the Stripe retrieve outside the transaction: read the order (short txn) → call Stripe (no DB connection held) → open a second short txn to write the payment + transition + issue licenses, guarded by the processed_event claim. The webhook reconcile path (payment-webhooks.ts) is already pure/in-txn (it uses the event payload, not a fresh retrieve) — that's the correct model; /pay should mirror it. Cap Stripe client timeouts; add a pool acquire timeout so saturation fails fast.
IMPACT: Critical Outbound Stripe refunds.create() executed INSIDE withStore while holding a FOR UPDATE row lock on the order
- Location: src/routes/admin-orders.ts:170–224 (lock at :173, gateway call at :204); src/routes/admin-order-payment-helpers.ts:24–46 (call at :41); network call at src/payments/stripe.ts:145
- Symptom under load: A refund against a slow/Stripe-degraded endpoint blocks all concurrent operations on that order (fulfill, edit, cancel, view) for the full refund RTT, and holds a pooled connection. Under a burst of refunds (e.g. post-incident mass refunds) the pool starves exactly like /pay.
- Root cause: The refund handler locks the order FOR UPDATE (:173), then calls executeGatewayRefund(tx, …) (:204) which calls provider.refundPayment(...) (admin-order-payment-helpers.ts:41) → stripeClient(mode).refunds.create({…}) (stripe.ts:145), an outbound HTTPS call — all inside the same withStore transaction, with the order row lock held the whole time. The code comment (:199–201) shows this was deliberate ("reverse the money at the gateway BEFORE writing the ledger row, so a gateway failure aborts the whole refund") — they traded atomicity for lock duration. That trade is wrong under load.
- Evidence:
    // admin-orders.ts:170
  const res = await withStore(st.storeId, async (tx) => {
    const [o] = await tx.select().from(s.order).where(eq(s.order.code, code)).limit(1).for('update'); // :173 ROW LOCK
    …
    gatewayResult = await executeGatewayRefund(tx, st.storeId, pay.method, pay.providerRef, amount, o.currency); // :204 ← STRIPE HTTPS, in-txn, lock held
    const [refund] = await tx.insert(s.refund).values({…gatewayResult…}); // :211
      // stripe.ts:145 (inside stripeProvider.refundPayment)
  const r = await stripeClient(input.stripeMode).refunds.create({ payment_intent: input.providerRef, amount: input.amount });
  - Benchmark: Same as above — gateways are called outside the row-lock window. The "gateway-failure-aborts-ledger" property is preserved by calling Stripe first (outside any txn), then writing the ledger in a short txn with a FOR UPDATE lock only around the ledger write, and reconciling via the refund.* webhook (which webhook-reconcile.ts already handles idempotently).
- Fix direction (P0): Reverse the order: call refunds.create before opening the transaction (or in its own short txn); then withStore + FOR UPDATE only around the ledger insert + state transition. Failed gateway calls already return {state:'Failed'} — surface that as 502 without ever acquiring the row lock. Idempotency on retry is already covered by the refund.* webhook reconcile path.
---
HIGH
IMPACT: High Connection pool sized max=10 with transaction-per-request and connectionTimeoutMillis=0 (no backpressure)
- Location: src/env.ts:25 (PGPOOL_MAX default 10), src/env.ts:27 (PGPOOL_CONNECTION_TIMEOUT_MS default 0); src/db/client.ts:7–12, 41–56
- Symptom under load: At most 10 store-scoped requests can be in-flight simultaneously. The 11th call to pool.connect() (inside withStore, client.ts:42) blocks indefinitely — connectionTimeoutMillis=0 means "wait forever." There is no queue limit, no 503, no circuit breaker. Under a flash-sale burst the API silently degrades to a hung state rather than shedding load; clients time out at their own (uncontrolled) layers.
- Root cause: Every store-scoped handler is wrapped in withStore, which pool.connect()s and holds that single client for the entire handler (BEGIN → SET LOCAL → handler → COMMIT, client.ts:42–56). Combined with the in-txn Stripe calls above, a handful of slow payments can consume the entire pool. resolveStoreFromCtx (store-context.ts:38) does an additional pool.query per shop request (a second acquire/release) — minor, but it adds connection churn on the hot path.
- Evidence: new Pool({ max: env.PGPOOL_MAX, … connectionTimeoutMillis: env.PGPOOL_CONNECTION_TIMEOUT_MS }) with both defaults = 10 / 0.
- Benchmark: Shopify/Vendure run multiple API instances behind a LB with a pool per instance sized to (2 × cores) + spindle heuristics and hard acquire timeouts + request queue limits that return 503 under saturation. A single-instance max=10 with infinite wait is a dev setting, not a production one.
- Fix direction (P0): (1) Set PGPOOL_CONNECTION_TIMEOUT_MS to a real value (e.g. 2000–5000ms) so saturation fails fast with 503. (2) Raise PGPOOL_MAX only after removing the in-txn Stripe calls (a bigger pool just delays the cliff and stresses Postgres max_connections). (3) Add an HTTP-layer concurrency/queue limit (e.g. semaphore on in-flight store-scoped handlers) that returns 503 + Retry-After. (4) Plan multi-instance horizontal scale (see jobs/rate-limiter findings).
IMPACT: High Background jobs are NOT safe to run on more than one instance — and two of them corruptIMPACT: High Background jobs are NOT safe to run on more than one instance — and two of them corrupt data
- Location: src/jobs/scheduler.ts:30–73 (every() only guards intra-process overlap, running flag); src/jobs/cart-maintenance.ts:22–61; src/jobs/auto-deliver.ts:17–42; src/jobs/release-stale-allocations.ts:29–78; src/jobs/webhook-reaper.ts:27–68; (contrast) src/webhooks/emit.ts:46–64
- Symptom under load: The moment a second API instance is started (the obvious first scale step), the setInterval jobs run on both. There is no leader election, no job-claim row, no SELECT … FOR UPDATE SKIP LOCKED on the order/cart/fulfillment passes. Consequences:
  - releaseStaleAllocations (inventory corruption): both instances select the same stale PendingPayment orders (:42–45, no LIMIT, no lock) and both run allocated = greatest(allocated - rel, 0) (:54–56) → the allocation is subtracted twice → on_hand/allocated accounting goes wrong (double-released stock). Also double audit_log inserts.
  - abandonStaleCarts (duplicate events): both instances select the same stale carts (:27–32, no lock) and both flip status='abandoned' (idempotent value) but both call emitEvent(tx, 'cart.abandoned', …) (:35) → duplicate abandoned-cart webhook/email events (not idempotent).
  - autoDeliver (duplicate audit): both select due Shipped fulfillments (:27–28, no LIMIT, no lock) and both UPDATE → Delivered (idempotent value) but both insert an audit_log row (:32) → duplicate audit entries.
  - cleanupExpiredCarts: accidentally safe (idempotent DELETE, no event).
  - reapStuckWebhooks: mostly safe (single idempotent UPDATE … WHERE status='processing', :53–60; only lastError string could concatenate twice).
  - deliverWebhooks (the one done right): uses FOR UPDATE SKIP LOCKED to claim rows (emit.ts:52–63) — genuinely multi-instance safe for the claim. But it then performs the outbound safeOutboundFetch (10s timeout) inside the same withStore txn, sequentially per row (emit.ts:67–88), holding one connection for up to limit × 10s. With MAX_BATCH_LIMIT=500 per store, a batch of all-timing-out endpoints can hold a connection for ~83 minutes worst case — the same in-txn-network-call anti-pattern, serialized.
- Root cause: every()'s running boolean (scheduler.ts:32–37) only prevents overlap within one process. No cross-process coordination exists for any job except the webhook-delivery claim.
- Evidence: scheduler.ts:34 if (running) return; — process-local only. release-stale-allocations.ts:42 plain select … where(state='PendingPayment', createdAt<cutoff) — no FOR UPDATE, no SKIP LOCKED, no LIMIT.
- Benchmark: Shopify/Vendure use BullMQ/Redis or a DB-backed job queue with row-level claim locks (SELECT … FOR UPDATE SKIP LOCKED) and idempotent, batched, LIMIT-bounded work units. Single-instance setInterval is explicitly a "later scaling option" per the repo's own ARCHITECTURE.md.
- Fix direction (P0 before multi-instance; P1 if staying single-instance): (1) Give every mutating job a SELECT … FOR UPDATE SKIP LOCKED … LIMIT N claim (mirror deliverWebhooks). (2) Add LIMIT + paginated batching to releaseStaleAllocations/autoDeliver (currently unbounded — one giant txn over thousands of DD's historical orders). (3) Make autoDeliver/abandonStaleCarts audit + event writes idempotent (e.g. INSERT … ON CONFLICT DO NOTHING on a natural key, or guard with a WHERE NOT EXISTS). (4) Move the outbound fetch in deliverWebhooks outside the claim txn (claim → release → fetch → short txn to mark delivered). (5) For true HA, add leader election (Redis lock or a job_lease table) so only one instance runs the scheduler.
IMPACT: High Dashboard runs all-time full-table aggregations on every page load — no rollup/materialization
- Location: src/routes/admin-dashboard.ts:27–51
- Symptom under load: Every /v1/admin/dashboard open performs five aggregations that each scale linearly with the store's lifetime order/customer/stock counts: (1) sum(grandTotal), count(*) over all paid orders with no date bound (:27–30); (2) count(*) of Paid orders with a correlated NOT EXISTS (fulfillment Shipped/Delivered) per order (:36–39); (3) count(*) over all customers (:40); (4) count(*) over all stock where on_hand - allocated <= 3 (:41–44, expression predicate → no index); (5) recent-orders top-8 (:45–51). Cost grows forever; at ~50k+ orders the dashboard becomes visibly slow.
- Root cause: Live aggregation, zero materialization. The order_store_state_created_idx (store_id, state, created_at) index helps the state filter but the planner still scans/sorts the entire paid-order set to aggregate. The NOT EXISTS fulfillment probe re-runs per Paid order.
- Evidence: where(state = any(PAID_STATES) and deletedAt is null) with no created_at >= … bound (:30).
- Benchmark: Shopify/Vendure pre-compute dashboard KPIs into rollup/materialized tables refreshed by scheduled jobs (Shopify's analytics pipeline; Vendure's OrderService aggregates against indexed + cached period windows). No production dashboard full-scans the lifetime order table per click.
- Fix direction (P1): (1) Default the revenue/orders KPIs to a bounded window (e.g. last 30/90 days) with a created_at range the (store_id, state, created_at) index serves. (2) Introduce a store_daily_metrics rollup table (revenue, orders, AOV, refunds) refreshed by a job; dashboard reads one row/day. (3) Index pendingFulfillment as a stored flag or a partial index (state='Paid' AND NOT EXISTS fulfillment) instead of a correlated probe. (4) Cache the dashboard response for ~60s (it's admin, low write rate).
---
MEDIUM
IMPACT: Medium Rate limiter is an in-process Map — resets on every restart, not shared across instances
- Location: src/auth/rate-limit.ts:12 (const store = new Map<string, Entry>()), :38 (sweep at size>5000)
- Symptom under load: (a) Every deploy/restart wipes all buckets → an attacker (or a retrying customer) gets a full fresh 8-attempt window immediately after each restart (burst window). (b) With N API instances, the effective limit is 8 × N attempts per IP/identifier (each instance counts independently) → brute-force/card-testing protection degrades linearly with scale. This is the limiter gating /pay (pay.ts:42) and login.
- Root cause: Per-process memory; the code itself says so (rate-limit.ts:3 "Per-process — fine for a single instance; move the store to Redis when running multiple API instances"). Confirmed: no persistence, no cross-process sync. Bounded at ~5000 keys (sweep at :38) so not an unbounded leak, but the bound is only enforced on the write path that crosses 5000.
- Evidence: const store = new Map<string, Entry>() (:12); loginRetryAfter/recordLoginFailure read/write that map only.
- Benchmark: Shopify/Vendure/any horizontally-scaled commerce backend uses a shared store (Redis sliding window / token bucket) for rate limiting so the limit is global per identity. This is table stakes for card-testing protection.
- Fix direction (P1): Move to a shared store (Redis token-bucket / sliding-window). Until then, at minimum set a finite PGPOOL_CONNECTION_TIMEOUT_MS so a rate-limit-allowed flood can't also hang the pool.
IMPACT: Medium Zero caching on the read path — store resolved from DB on every request; catalog/browse hits Postgres every time; no ETags/Cache-Control on API responses
- Location: src/store-context.ts:38 (uncached pool.query per shop request); src/routes/catalog.ts:64–88, 209–230 (every browse/detail = DB txn); manifest staleness src/manifest/generate.ts:85–86
- Symptom under load: Every single storefront request (catalog list, product detail, collection, search, currencies) resolves the store via a live SELECT … FROM store WHERE slug=$1 (store-context.ts:38) with no cache, then opens a withStore txn to read the catalog. The static manifest (generate.ts) exists for the Qwik storefront's browse, but the REST /v1/shop/catalog/* endpoints (used by cart/search/checkout and any non-manifest client) hit the DB fresh every time. No Cache-Control, ETag, or stale-while-revalidate is emitted on any API JSON response (search confirmed across src/routes/**).
- Root cause: No application cache layer (no Redis; no in-process LRU for the store registry; no HTTP caching headers). resolveStore re-queries the store table per request even though store rows change ~never.
- Evidence: resolveStore → pool.query('SELECT … FROM store WHERE slug=$1') (store-context.ts:38–41), called by resolveStoreFromCtx on every shop handler. grep for cache-control|ETag|s-maxage in src/routes/** → only storefront/nginx static-asset headers; nothing on API JSON.
- Benchmark: Shopify serves storefront browse from a CDN/edge cache (Surrogate-Key + Cache-Control); Vendure has a response cache plugin. The store-registry lookup is always cached. SellRight's design intends browse to be static (manifest), but the dynamic REST browse path has no caching at all.
- Fix direction (P2): (1) In-process LRU (5–60s TTL) for resolveStore keyed by slug — store config changes rarely. (2) Emit Cache-Control: public, max-age=60, stale-while-revalidate=300 + ETag on /v1/shop/catalog/* reads; add a Surrogate-Key: store:<slug> for CDN purge on write. (3) If Redis lands (for rate-limit/jobs), use it for store + hot catalog reads.Scope: packages/api money paths, checkout→pay→settle→webhook, refunds/returns, stock, subscriptions, licensing, bulk ops. Read-only; no edits. All line references are to the laptop checkout at the audited commit (25c4b35).
Executive summary
The pure money core is sound: integer-cents everywhere, server-authoritative pricing on every route, discount-before-tax, gift-card-as-tender, atomic conditional stock reservation, and within-path idempotency (checkout key, /pay claim, webhook event.id claim, license per-line shortfall counting). The architecture is materially better than naive WooCommerce and close to Vendure's invariants in spirit.
However, the cross-path settle seam (/pay vs payment_intent.succeeded webhook) and the refund seam (gateway call inside the DB transaction with no Stripe idempotency key) have real money-ledger corruption and double-refund exposures that are not caught by any integration test (the test suite is unit-level on pure functions only). Three of these are migration blockers. The order FSM also has a modeling defect (Paid → Cancelled without refund) that is latent today but is a trap for future code.
---
Findings
SEVERITY: High Duplicate payment ledger row on the /pay vs webhook race (no DB backstop)
- Location: src/payments/settle.ts:31-46; src/routes/pay.ts:55-86; src/routes/payment-webhooks.ts:82-105; src/db/schema-orders.ts:196-207; migration 0007:14; src/db/client.ts:41-57
- What: applyPaymentResult does INSERT payment unconditionally, then checks canTransition(order.state,'Paid'). The only guard against a second settle is a plain SELECT of order.state at the top of each path (pay.ts:58, payment-webhooks.ts:100). withStore runs at READ COMMITTED (plain BEGIN, no SET ISOLATION LEVEL SERIALIZABLE), so that guard is a stale-read-prone TOCTOU. The two paths use different idempotency keys (pay:${code}:${method} vs Stripe event.id), so their processed_event claims do not collide. The payment table has no unique constraint on (store_id, provider_ref) — migration 0007 adds only a non-unique payment_order_idx. License issuance is race-safe (issue.ts:19 SELECT … FOR UPDATE + per-orderLine shortfall count), but the payment row is not.
- Failure scenario: Customer confirms a Stripe PaymentIntent (3DS) client-side. The storefront calls /pay while Stripe fires payment_intent.succeeded ~simultaneously (the common case — the webhook is dispatched on confirmation). Webhook txn: SELECT order reads PendingPayment (before /pay commits) → passes guard → applyPaymentResult INSERT payment (providerRef=pi_xxx, amount=grandTotal) → blocks on the UPDATE order SET state='Paid' row lock held by /pay. /pay commits (one payment row, order→Paid, licenses issued). Webhook unblocks: canTransition('PendingPayment','Paid') is evaluated against the stale in-memory order.state='PendingPayment' → true → overwrites Paid→Paid (idempotent value), issueLicensesForPaidOrder counts existing licenses and issues 0 (safe). Net: two payment rows for one Stripe capture. Revenue/reports double-count by grandTotal per affected order; alreadyRefunded/reconciliation are corrupted; the refund handler picks the latest settled payment (admin-orders.ts:176 orderBy(desc(createdAt))) so refunds link to the duplicate.
- Evidence: settle.ts:31 await tx.insert(s.payment).values({... amount: order.grandTotal ...}) precedes the canTransition guard at :41. payment-webhooks.ts:100 if (!order || order.state !== 'PendingPayment') return; is a non-locked read. No unique index exists (confirmed across all migrations).
- Benchmark: Shopify's Transaction ledger keys refunds/charges on the gateway transaction id and treats the webhook as the source of truth, with /pay-equivalent client confirmation as a retrieval, deduped by the Stripe charge id. Vendure settles on the webhook and treats the client poll as a read; it does not insert a second payment on a redelivery because the order state machine + payment-entity uniqueness reject it.
- Fix direction: Add CREATE UNIQUE INDEX payment_store_provider_ref_uidx ON payment (store_id, provider_ref) WHERE provider_ref IS NOT NULL and make applyPaymentResult INSERT … ON CONFLICT (store_id, provider_ref) DO NOTHING RETURNING (treat 0 rows as "already settled" → skip the transition). Additionally, take SELECT … FOR UPDATE on the order at the top of both /pay and the webhook handler so the second waiter re-reads committed state. Either change alone closes the race; both together match Shopify/Vendure robustness.
SEVERITY: High Refund gateway call runs inside the DB transaction with no Stripe idempotency key → orphan refund + double-refund on retry
- Location: src/routes/admin-orders.ts:170-211 (and the parallel return-approve path :330-343); src/routes/admin-order-payment-helpers.ts:24-46; src/payments/stripe.ts:141-151
- What: The "gateway-before-ledger" ordering is correct in intent — executeGatewayRefund is called before the refund insert, and a gateway failure throws providerfail so the txn rolls back with no ledger row (admin-orders.ts:199-209). But the Stripe HTTP call (stripe.ts:145 refunds.create({ payment_intent, amount })) is executed while the withStore transaction is open, and no idempotencyKey is passed to refunds.create. So: (a) if Stripe succeeds but the txn then fails to commit (connection drop, RLS error on a later write, deadlock, process crash), the refund exists at Stripe with no ledger row — an orphan; (b) a retry of the same admin refund calls Stripe again with no idempotency key → a second re_ refund.
- Failure scenario: Admin refunds a $100 order. `executeGatewayRefund` → `refunds.create` returns `re_A` (succeeded). The subsequent `refund_line` insert hits a connection drop → `ROLLBACK`. Ledger: no refund row, order still `Paid`. Stripe: `re_A` refunded. Admin, seeing a 502/timeout, retries within seconds (before Stripe's `refund.created` webhook arrives). `canTransition('Paid','PartiallyRefunded')` is still true (rolled back) → `refunds.create` again → `re_B` (second $100 refund). Ledger now records re_B, order→Refunded. Customer is double-refunded ($200 on a $100 order). When the refund.created webhook for re_A later arrives, reconcileStripeRefund (webhook-reconcile.ts:83-96) inserts re_A as a third ledger entry — alreadyRefunded now reports $200, reports show negative net revenue.
- Evidence: stripe.ts:145 stripeClient(input.stripeMode).refunds.create({ payment_intent: input.providerRef, amount: input.amount }) — no second arg / no idempotencyKey. admin-orders.ts:204 calls it inside withStore. The self-healing reconcileStripeRefund path exists but cannot prevent the second refunds.create.
- Benchmark: Shopify and Vendure both pass a deterministic idempotency key (derived from order + amount + sequence) to the gateway refund call, and execute the gateway call outside the ledger transaction, writing the ledger row only after gateway success and reconciling via the refund webhook on failure. Vendure's refund process is a saga with a recorded "refund in flight" state.
- Fix direction: Pass idempotencyKey: \refund:${orderId}:${amount}:${attempt}\` to refunds.create (Stripe returns the same re_ for a retry within 24h → no double-refund). Preferably also move the gateway call outside withStore: call Stripe, then open the txn to insert the ledger row; on ledger failure rely on the existing reconcileStripeRefund` webhook to reconcile. The idempotency key alone eliminates the double-refund; both together eliminate the orphan window.
SEVERITY: High Draft / manual "markPaid" orders never issue licenses
- Location: src/routes/admin-order-ops.ts:60-66
- What: The POST /v1/admin/draft-orders handler with markPaid:true inserts the order with state:'Paid', inserts a manual Settled payment, and writes an audit log — but never calls issueLicensesForPaidOrder. Every other Paid transition does: checkout gift-card full-cover (checkout.ts:305), applyPaymentResult (settle.ts:44), and subscription first-cycle (subscriptions.ts:203). issueLicensesForPaidOrder is imported nowhere in admin-order-ops.ts.
- Failure scenario: Operator takes a phone order for a digital/licensed product (fulfillmentType license/digital_download), creates a draft order with markPaid:true. Order becomes `PaidkimiTL;DR verdict
Not ready for a live cutover of all stores today, but the engine is production-grade for a controlled, brand-by-brand migration.
The backend is unusually well-architected for a young system: RLS-enforced multi-tenancy, server-authoritative pricing, idempotent payments, a clean order FSM, and strong digital-goods support. The blockers are not the core engine. They are:
1. Payments breadth — Stripe only; NMI/Sezzle missing, which is required for Damned Designs parity.
2. Storefront cutover — the Qwik storefront is still a cloned Vendure app; dynamic REST is wired, but the Stripe Elements checkout is behind a flag and has not had a live test-card run.
3. Operational scale — no Redis/distributed jobs, no CDN/S3 asset layer, in-process rate limiting, and no structured observability.
4. Growth/compliance apps — no native reviews, loyalty, subscriptions add-ons, EU VAT/MOSS, Avalara, live shipping, or multi-channel.
For a software-only store like RightApps, SellRight is already ahead of the competitors on licensing, downloads, and multi-tenant operations. For a general merchandise store like Damned Designs, it needs the missing payment methods and storefront hardening before it can fully replace Vendure.
---
What I inspected
Layer	Key files reviewed
API entry & routing	packages/api/src/app.ts, src/index.ts, src/env.ts, src/store-context.ts
DB/tenancy	src/db/client.ts, src/db/schema-core.ts, src/db/schema-orders.ts, src/db/schema-content.ts, drizzle/0001_rls_policies.sql, 0002_harden_rls_nullif.sql, 0009_model_completeness.sql, 0034_subscriptions.sql, 0036_harden_subscription_rls.sql
Auth/security	src/auth/cookies.ts, src/auth/session.ts, src/auth/admin-session.ts, src/auth/password.ts, src/auth/rate-limit.ts, src/auth/totp.ts, src/security/outbound-url.ts
Money/pricing	src/money/totals.ts, src/money/coupon.ts, src/money/gift-card.ts, src/money/tax.ts, src/money/fsm.ts, src/money/auto-discount.ts
Commerce flows	src/routes/checkout.ts, src/routes/cart.ts, src/routes/pay.ts, src/routes/payment-webhooks.ts, src/routes/orders.ts, src/routes/catalog.ts, src/routes/auth.ts, src/routes/customer-tokens.ts, src/routes/subscriptions.ts, src/routes/shop-config.ts, src/routes/store-context.ts
Admin operations	src/routes/admin.ts, src/routes/admin-helpers.ts, src/routes/admin-orders.ts, src/routes/admin-order-ops.ts, src/routes/admin-order-payment-helpers.ts, src/routes/admin-assets.ts
Inventory/jobs	src/orders/stock-reservation.ts, src/jobs/scheduler.ts, src/jobs/auto-deliver.ts, src/jobs/release-stale-allocations.ts, src/jobs/cart-maintenance.ts, src/jobs/webhook-reaper.ts, src/cart/ttl.ts
Licensing/downloads	src/licensing/issue.ts, src/licensing/download-url.ts, src/licensing/activations.ts, src/routes/apps.ts
Webhooks/email	src/webhooks/emit.ts, src/email/mailer.ts, src/email/dispatch.ts
Verification	Ran pnpm --filter @sellright/api test (130 passing), pnpm --filter @sellright/api typecheck, pnpm --filter @sellright/shared typecheck
---
## ✅ Real strengths (where SellRight beats or matches the field)
### 1. Multi-tenancy is production-grade
- 40+ store-scoped tables use `FORCE ROW LEVEL SECURITY` with `store_id = nullif(current_setting('app.current_store', true), '')::uuid`.
- The app role is intentionally non-owner; migrations run as owner.
- Every route wraps work in `withStore(storeId, fn)`, which `BEGIN`s, sets `app.current_store` with `SET LOCAL`, and commits.
- Guard scripts (`db:assert-rls`, `db:assert-hand-written`, `assert:shop-isolation`) are wired into `pnpm verify`.
- This is genuinely better than Shopify’s account-per-store model and WooCommerce’s separate WordPress installs.
### 2. Pricing/checkout is server-authoritative and idempotent
- Cart estimate, persisted cart, and checkout all re-price from the DB; client prices are never trusted.
- Stock is allocated atomically with `UPDATE … WHERE (on_hand - allocated) >= qty`.
- Checkout uses a unique `(store_id, idempotency_key)` constraint to prevent double-order creation.
- Payments use `processed_event` idempotency; a deterministic fallback key is derived from `(orderCode, method)` when the client omits one.
- Gift cards, coupons, automatic promotions, and tax zones are all recalculated server-side.
### 3. Stripe integration is hardened
- Dual test/live keys with mode guards (`keyMatchesMode`).
- PaymentIntents are created server-side with amount/currency from the order row.
- Webhooks verify the raw body against both test and live secrets.
- Refund and dispute events reconcile back into the order ledger.
- Subscriptions are anchored to SellRight’s own `subscription` row for tenant resolution, not just Stripe metadata.
### 4. Digital goods are first-class
- Native license issuance, device activation, seat limits, update manifests, and expiring signed download URLs (`src/licensing/download-url.ts`).
- The download route now requires `Authorization: Bearer <licenseKey>` and returns an HMAC-signed 15-minute URL instead of a raw path.
- Shopify/WooCommerce need paid apps (SendOwl, FetchApp, Easy Digital Downloads) for this.
### 5. Security fundamentals are solid
- scrypt password hashing, SHA-256 token hashing, httpOnly session cookies, double-submit CSRF, TOTP for admin 2FA.
- Enumeration defenses on login and forgot-password.
- SSRF protection on outbound webhooks (`src/security/outbound-url.ts`).
- No raw PAN handling; Stripe Elements handles cards.
---
🔴 Security gaps & pressure points
Issue	Severity	Evidence
No CORS / security headers middleware in the API	Medium	app.ts has no cors(), secureHeaders(), bodyLimit(), or helmet equivalent. In production you rely entirely on nginx.
Rate limiting is in-process	Medium-High	src/auth/rate-limit.ts uses a Map. It resets on restart and does not work across multiple API instances. Card-testing and brute-force protection need Redis.
No global request body cap	Medium	admin-assets.ts checks Content-Length, but Hono itself has no bodyLimit; a chunked upload can still exhaust memory.
Admin store selection defaults to first store	Medium	requireStore() in src/routes/admin-helpers.ts falls back to admin.stores[0]?.slug. A missing x-store-slug header silently operates on the wrong store.
No production host-based store resolution	Medium	resolveStore() in src/store-context.ts reads x-store-slug and defaults to damned. Production docs mention host mapping, but the code is not there.
Error exposure leaks in non-prod	Low	app.onError exposes err.message when NODE_ENV !== 'production'. Fine for dev, but staging must be careful.
Audit log is partial	Medium	audit_log covers orders/stock, but not customer edits, staff role changes, settings changes, or login/logout.
RBAC is mostly framework	Medium	requirePermission() exists, but only gift cards and webhooks appear to enforce it; admin routes largely rely on owner/manager/staff/read_only roles.
---
🔴 Performance & scalability gaps
Issue	Severity	Evidence
No Redis / distributed cache	High	Rate limiter, job scheduler, and session store all assume a single process. Horizontal scaling breaks them.
Offset pagination everywhere	Medium	catalog.ts, admin-orders.ts, admin-reports.ts, etc. use LIMIT/OFFSET. Deep pages get slow and inconsistent under writes.
Connection pool is untuned	Medium	src/db/client.ts uses pg defaults (max 10). No statement timeout, no pool metrics.
No search engine	Medium	Product search is backed by GIN trigram indexes (0029_product_search_trgm.sql), which is fine for small catalogs, but no Elasticsearch/Typesense/Meilisearch for large catalogs.
No CDN / object storage	High	Assets are local disk under ASSET_DIR. For a software store, downloads still stream through the Node process.
Webhook delivery is synchronous per row	Low-Medium	deliverWebhooks() loops serially inside a transaction; a slow endpoint can delay the batch.
No structured observability	High	No metrics, tracing, or structured logging surfaced anywhere.
---
🔴 Architecture & flow gaps
Issue	Severity	Evidence
Single /v1 version, no deprecation path	Low-Medium	Good for speed, but public/partner API surface will be hard to evolve.
GraphQL is gone, but storefront still carries Vendure DNA	High	packages/storefront is excluded from the workspace and still has Vendure GraphQL types, fragments, and cache-admin routes.
Checkout still has a feature flag	High	FEATURES.md says Stripe Elements checkout is behind VITE_SR_CHECKOUT and needs a live test-card run before default.
No automatic tax (Avalara/TaxJar/VAT MOSS)	High	src/money/tax.ts only resolves from manual tax_zone rows. EU digital-goods VAT and US sales tax are manual.
No live shipping rates	High	src/shipping/calculator.ts is flat-rate/conditional only. No USPS/UPS/FedEx/DHL integrations.
Payments are Stripe + manual + COD only	High	src/payments/provider.ts lists nmi/sezzle as comments but no provider exists. FEATURES.md calls this a launch gap.
No abandoned-cart recovery job	Medium	cart-maintenance.ts flags abandoned carts and emits events, but no email flow or Listmonk automation is wired.
No reviews, loyalty, bundles, wishlist	Medium	These are “app-store” revenue categories; competitors monetize them heavily.
---
## 🟠 Vendure-specific migration risks
Vendure is the closest architectural incumbent. Selling points of SellRight vs Vendure:
- **REST + OpenAPI** instead of GraphQL.
- **DB-enforced multi-tenant isolation** instead of channel semantics.
- **Smaller operational surface** and no plugin ceremony.
But Vendure still has more mature edge cases:
1. **Data fidelity**: The import scripts (`src/import/catalog.ts`, `customers.ts`, `orders.ts`) read from a Vendure clone. Historical orders, promotions, and custom fields need a full mapping audit.
2. **Order states**: Vendure has a richer fulfillment/order state machine; SellRight’s FSM is intentionally simpler (`PendingPayment → Paid → PartiallyRefunded/Refunded/Cancelled`). If you rely on Vendure custom order states, you’ll lose them.
3. **Payment methods**: Vendure supports more providers via plugins; SellRight only supports Stripe out of the box.
4. **Storefront URLs / SEO**: The Qwik storefront has hardcoded Damned Designs URLs and Vendure GraphQL paths. Redirects, canonicals, and sitemap preservation need a migration runbook.
5. **Plugins**: Any Vendure plugin (e.g., custom tax, email, reviews) must be rebuilt or replaced.
---
🎯 Competitive scorecard
Capability	SellRight	Shopify
Multi-tenant backend	🟢 native	🟡 Plus orgs
Server-authoritative pricing	🟢	🟢
Digital downloads / licensing	🟢 native	🔴 apps
Subscriptions	🟢 Stripe Billing	🟢 native
Payment breadth	🔴 Stripe only	🟢 many
Live shipping rates	🔴 flat only	🟢
Automatic tax	🔴 manual zones	🟢 Avalara
Reviews / loyalty	🔴 none	🟢 apps
Abandoned-cart email	🟡 events only	🟢 native
Multi-channel / POS	🔴 none	🟢 native
EU VAT / MOSS	🔴 none	🟢
GraphQL API	🔴 REST only	🟢
Operations/observability	🔴 minimal	🟢
---
## What would block a live migration right now
1. **Missing payment providers (NMI/Sezzle)** — required for Damned Designs parity.
2. **Storefront checkout not default / not live-tested** — `FEATURES.md` explicitly flags this.
3. **No CDN/object storage** — at scale, local disk assets and Node-streamed downloads will bottleneck.
4. **No distributed rate limit / session store** — moving to multiple API instances is unsafe.
5. **No EU VAT / automatic tax** — if you sell digital goods into the EU, this is a compliance risk.
6. **No live shipping** — acceptable for digital goods, not acceptable for physical stores.
7. **Incomplete observability** — you will be flying blind on the first incident.
---
🗺️ Recommended migration roadmap
Phase 1 — Close hard blockers (do not go live without these)
- [ ] Implement NMI and Sezzle payment providers against src/payments/provider.ts.
- [ ] Complete the storefront rewire and run a live Stripe test-card transaction with VITE_SR_CHECKOUT.
- [ ] Add production host/subdomain → store resolution in src/store-context.ts.
- [ ] Make x-store-slug mandatory for admin mutations; remove the “first store” fallback.
- [ ] Add Hono bodyLimit and CORS/security-headers middleware, or document the nginx equivalents.
- [ ] Back the rate limiter and session store with Redis.
- [ ] Add S3/R2/CDN for assets and downloads; move downloads off the Node process.
- [ ] Run a full Vendure → SellRight import and reconciliation drill on a clone.
Phase 2 — Operational readiness
- [ ] Add structured logging, metrics (Prometheus/OTel), and alerting.
- [ ] Add cursor/keyset pagination for orders/customers/products.
- [ ] Tune pg pool and add statement timeouts.
- [ ] Broaden RBAC keys and audit-log coverage.
- [ ] Add a backup/restore runbook and test it.
Phase 3 — Growth features
- [ ] Abandoned-cart email flow via Listmonk.
- [ ] Reviews/UGC.
- [ ] Loyalty/rewards.
- [ ] Bundles/upsell.
- [ ] EU VAT MOSS / Avalara integration.
---
Bottom line
For RightApps (software sales): SellRight is already the strongest candidate among the evaluated platforms on the dimensions that matter. The core engine, licensing, subscriptions, and multi-tenancy are production-ready. You could migrate a software-only brand once the storefront and payment smoke tests pass.
For Damned Designs / general merchandise: Do not cut over live traffic until NMI/Sezzle, live shipping, automatic tax, CDN asset storage, and the storefront checkout are complete and reconciliation-tested.
Overall: SellRight is a strong, owned commerce engine with a security and isolation posture that matches or exceeds Shopify’s backend. Its gaps are the “everything around the engine” — payment breadth, tax, shipping, growth apps, and scale/observability infrastructure. Treat it as a controlled brand-by-brand migration, not a big-bang switch.deepseekSellRight vs Shopify/WooCommerce: Migration Readiness Assessment

  Security

  ┌───────────────────────────────┬───────────────────────────────┬───────────────────────────────┬───────────────────────────────┐
  │ Area                          │ SellRight                     │ Shopify / WooCommerce         │ Gap Severity                  │
  ├───────────────────────────────┼───────────────────────────────┼───────────────────────────────┼───────────────────────────────┤
  │ Tenant isolation              │ Postgres FORCE RLS,           │ Application-level filtering   │ Better than both              │
  │                               │ fail-closed, CI-enforced      │ (Shopify) / none (Woo)        │                               │
  ├───────────────────────────────┼───────────────────────────────┼───────────────────────────────┼───────────────────────────────┤
  │ Password hashing              │ scrypt, 64-byte,              │ bcrypt (Woo) / proprietary    │ Equivalent                    │
  │                               │ constant-time compare         │ (Shopify)                     │                               │
  ├───────────────────────────────┼───────────────────────────────┼───────────────────────────────┼───────────────────────────────┤
  │ CSRF                          │ Double-submit cookie, bearer  │ Native framework CSRF (Woo) / │ Equivalent                    │
  │                               │ exemption                     │ SameSite (Shopify)            │                               │
  ├───────────────────────────────┼───────────────────────────────┼───────────────────────────────┼───────────────────────────────┤
  │ Rate limiting                 │ In-memory only — per-process, │ Redis/cluster-aware (Shopify) │ HIGH — breaks with >1 API     │
  │                               │ no Redis                      │ / plugin-dependent (Woo)      │ instance                      │
  ├───────────────────────────────┼───────────────────────────────┼───────────────────────────────┼───────────────────────────────┤
  │ Brute-force                   │ 8 failures / 15 min per       │ Built-in (Shopify) / plugin   │ Equivalent                    │
  │                               │ IP+identifier                 │ (Woo)                         │                               │
  ├───────────────────────────────┼───────────────────────────────┼───────────────────────────────┼───────────────────────────────┤
  │ SSRF protection               │ DNS pinning, private IP       │ Varies                        │ Strong                        │
  │                               │ blocklist, no redirect follow │                               │                               │
  ├───────────────────────────────┼───────────────────────────────┼───────────────────────────────┼───────────────────────────────┤
  │ Idempotency                   │ Multi-layer: order, payment,  │ Built-in (Shopify) / none     │ Strong                        │
  │                               │ webhooks                      │ (Woo)                         │                               │
  ├───────────────────────────────┼───────────────────────────────┼───────────────────────────────┼───────────────────────────────┤
  │ Fraud detection               │ None                          │ Shopify Protect / Risk        │ MEDIUM                        │
  │                               │                               │ Analysis                      │                               │
  ├───────────────────────────────┼───────────────────────────────┼───────────────────────────────┼───────────────────────────────┤
  │ PCI compliance                │ No SAQ-A documentation —      │ PCI Level 1 (Shopify)         │ MEDIUM — compliance blocker   │
  │                               │ Stripe handles cards but      │                               │                               │
  │                               │ attestation missing           │                               │                               │
  ├───────────────────────────────┼───────────────────────────────┼───────────────────────────────┼───────────────────────────────┤
  │ CORS configuration            │ Not visible in API layer      │ Configured (Shopify) / plugin │ LOW                           │
  │                               │                               │ (Woo)                         │                               │
  ├───────────────────────────────┼───────────────────────────────┼───────────────────────────────┼───────────────────────────────┤
  │ Session rotation on privilege │ No rotation                   │ Yes (Shopify admin)           │ LOW                           │
  │ change                        │                               │                               │                               │
  ├───────────────────────────────┼───────────────────────────────┼───────────────────────────────┼───────────────────────────────┤
  │ 2FA/TOTP                      │ RFC 6238, replay-guarded, no  │ Built-in (both)               │ Equivalent                    │
  │                               │ external dep                  │                               │                               │
  └───────────────────────────────┴───────────────────────────────┴───────────────────────────────┴───────────────────────────────┘

  Security verdict: The RLS + idempotency story is genuinely better than most platforms. But in-memory rate limiting is a blocker for
   production — it means you can't run >1 API process, which means no zero-downtime deploys and no horizontal scaling. PCI SAQ-A
  documentation is also a compliance requirement.

  ───
  Performance & Scalability

  ┌────────────────────────┬──────────────────────────────────┬─────────────────────────────────┬─────────────────────────────────┐
  │ Area                   │ SellRight                        │ Shopify / WooCommerce           │ Gap Severity                    │
  ├────────────────────────┼──────────────────────────────────┼─────────────────────────────────┼─────────────────────────────────┤
  │ Caching                │ In-memory per-process only — no  │ Redis + CDN (Shopify) / Redis   │ HIGH                            │
  │                        │ Redis, no CDN for API responses  │ plugins (Woo)                   │                                 │
  ├────────────────────────┼──────────────────────────────────┼─────────────────────────────────┼─────────────────────────────────┤
  │ Database reads         │ Single PG instance, no replicas  │ Read replicas (Shopify) /       │ MEDIUM                          │
  │                        │                                  │ optional (Woo)                  │                                 │
  ├────────────────────────┼──────────────────────────────────┼─────────────────────────────────┼─────────────────────────────────┤
  │ Job queue              │ setInterval in-process — no      │ Dedicated queues (both)         │ HIGH                            │
  │                        │ message broker, no persistence   │                                 │                                 │
  ├────────────────────────┼──────────────────────────────────┼─────────────────────────────────┼─────────────────────────────────┤
  │ Search                 │ GIN trigram indexes on Postgres  │ Elasticsearch (Shopify) /       │ MEDIUM                          │
  │                        │ — no Elasticsearch/Meilisearch   │ plugins (Woo)                   │                                 │
  ├────────────────────────┼──────────────────────────────────┼─────────────────────────────────┼─────────────────────────────────┤
  │ Image optimization     │ vite-imagetools + sharp for      │ CDN image transformation        │ Equivalent                      │
  │                        │ AVIF/WebP                        │ (Shopify)                       │                                 │
  ├────────────────────────┼──────────────────────────────────┼─────────────────────────────────┼─────────────────────────────────┤
  │ API design             │ REST-only, no GraphQL —          │ GraphQL (Shopify) / REST (Woo)  │ Medium — trade-off, not gap     │
  │                        │ over-fetching possible           │                                 │                                 │
  ├────────────────────────┼──────────────────────────────────┼─────────────────────────────────┼─────────────────────────────────┤
  │ SSR strategy           │ Qwik resumability — zero         │ Liquid SSR (Shopify) / various  │ Better                          │
  │                        │ hydration, extremely fast TTI    │ (Woo)                           │                                 │
  ├────────────────────────┼──────────────────────────────────┼─────────────────────────────────┼─────────────────────────────────┤
  │ CDN integration        │ Haproxy/nginx, no edge compute   │ Cloudflare/CDN edge (Shopify)   │ MEDIUM                          │
  ├────────────────────────┼──────────────────────────────────┼─────────────────────────────────┼─────────────────────────────────┤
  │ Load testing           │ None performed                   │ Built-in (Shopify Plus)         │ HIGH — unknown capacity ceiling │
  └────────────────────────┴──────────────────────────────────┴─────────────────────────────────┴─────────────────────────────────┘

  Performance verdict: The in-process scheduler and lack of Redis are the two biggest architectural concerns. The job scheduler means
   background tasks compete with API requests for CPU, and a crash loses all pending work. No load testing data means you don't know
  your ceiling.

  ───
  Architecture

  ┌─────────────────────────┬──────────────────────────────────┬─────────────────────────────────┬────────────────────────────────┐
  │ Area                    │ SellRight                        │ Shopify / WooCommerce           │ Gap Severity                   │
  ├─────────────────────────┼──────────────────────────────────┼─────────────────────────────────┼────────────────────────────────┤
  │ Multi-tenancy           │ Database-level RLS — true tenant │ Logical isolation (Shopify) /   │ Better                         │
  │                         │ isolation                        │ multi-site (Woo)                │                                │
  ├─────────────────────────┼──────────────────────────────────┼─────────────────────────────────┼────────────────────────────────┤
  │ Event system            │ Polling-based transactional      │ Webhooks + message queues       │ MEDIUM                         │
  │                         │ outbox — no message broker       │ (Shopify)                       │                                │
  ├─────────────────────────┼──────────────────────────────────┼─────────────────────────────────┼────────────────────────────────┤
  │ Shared package          │ Aspirational only — exists but   │ N/A                             │ LOW — cleanup item             │
  │                         │ unused by consumers              │                                 │                                │
  ├─────────────────────────┼──────────────────────────────────┼─────────────────────────────────┼────────────────────────────────┤
  │ Soft deletes            │ Products, customers, orders      │ Yes (both)                      │ Equivalent                     │
  ├─────────────────────────┼──────────────────────────────────┼─────────────────────────────────┼────────────────────────────────┤
  │ Order snapshots         │ Line items survive catalog       │ Yes (both)                      │ Equivalent                     │
  │                         │ changes                          │                                 │                                │
  ├─────────────────────────┼──────────────────────────────────┼─────────────────────────────────┼────────────────────────────────┤
  │ Feature flags           │ VITE_ env vars — requires        │ Built-in (Shopify)              │ MEDIUM                         │
  │                         │ rebuild, no runtime toggles      │                                 │                                │
  ├─────────────────────────┼──────────────────────────────────┼─────────────────────────────────┼────────────────────────────────┤
  │ Microservices           │ Monolith — one Node process      │ Distributed (Shopify)           │ LOW — valid for this scale     │
  ├─────────────────────────┼──────────────────────────────────┼─────────────────────────────────┼────────────────────────────────┤
  │ Strangler migration     │ Incomplete — dual Vendure +      │ N/A                             │ MEDIUM — tech debt             │
  │                         │ SellRight paths in storefront    │                                 │                                │
  └─────────────────────────┴──────────────────────────────────┴─────────────────────────────────┴────────────────────────────────┘

  Architecture verdict: The monolith is appropriate for the scale, but the polling-based outbox and in-process scheduler are the two
  things that will hurt first at higher throughput. The incomplete strangler migration in the storefront is tech debt that will slow
  velocity.

  ───
  Commerce Features

  ┌─────────────────────────────┬────────────────────────────────────────────────┬────────────────────────────────────────────────┐
  │ Area                        │ SellRight                                      │ Shopify / WooCommerce                          │
  ├─────────────────────────────┼────────────────────────────────────────────────┼────────────────────────────────────────────────┤
  │ Product catalog             │ Variants, options, collections, smart          │ Full                                           │
  │                             │ collections                                    │                                                │
  ├─────────────────────────────┼────────────────────────────────────────────────┼────────────────────────────────────────────────┤
  │ Discounts                   │ Single promotion only — no stacking, no        │ Multiple discounts, automatic + manual combos  │
  │                             │ automatic + coupon combo                       │                                                │
  ├─────────────────────────────┼────────────────────────────────────────────────┼────────────────────────────────────────────────┤
  │ Shipping                    │ Flat-rate only — no carrier APIs (UPS, FedEx,  │ Real-time carrier rates, calculated shipping   │
  │                             │ USPS)                                          │                                                │
  ├─────────────────────────────┼────────────────────────────────────────────────┼────────────────────────────────────────────────┤
  │ Multi-currency              │ Presentment only, charges always in base       │ Full multi-currency with local payment methods │
  │                             │ currency                                       │                                                │
  ├─────────────────────────────┼────────────────────────────────────────────────┼────────────────────────────────────────────────┤
  │ Gift cards                  │ Tender model — well-implemented                │ Built-in                                       │
  ├─────────────────────────────┼────────────────────────────────────────────────┼────────────────────────────────────────────────┤
  │ Subscriptions               │ Yes, Stripe Billing integration                │ Built-in (Shopify) / plugins (Woo)             │
  ├─────────────────────────────┼────────────────────────────────────────────────┼────────────────────────────────────────────────┤
  │ Returns/RMA                 │ Full workflow: request → approve/reject →      │ Built-in                                       │
  │                             │ refund + restock                               │                                                │
  ├─────────────────────────────┼────────────────────────────────────────────────┼────────────────────────────────────────────────┤
  │ Multi-language              │ None — no i18n support                         │ Full (Shopify) / plugins (Woo)                 │
  ├─────────────────────────────┼────────────────────────────────────────────────┼────────────────────────────────────────────────┤
  │ Product bundles             │ None                                           │ Built-in (Shopify) / plugins (Woo)             │
  ├─────────────────────────────┼────────────────────────────────────────────────┼────────────────────────────────────────────────┤
  │ Abandoned cart recovery     │ Webhook event emitted, no built-in recovery    │ Built-in email sequence                        │
  │                             │ email                                          │                                                │
  ├─────────────────────────────┼────────────────────────────────────────────────┼────────────────────────────────────────────────┤
  │ Customer segments           │ None                                           │ Built-in (Shopify)                             │
  ├─────────────────────────────┼────────────────────────────────────────────────┼────────────────────────────────────────────────┤
  │ POS                         │ None                                           │ Built-in (Shopify)                             │
  ├─────────────────────────────┼────────────────────────────────────────────────┼────────────────────────────────────────────────┤
  │ B2B/wholesale               │ None                                           │ Shopify Plus                                   │
  ├─────────────────────────────┼────────────────────────────────────────────────┼────────────────────────────────────────────────┤
  │ Marketplace/vendor          │ None                                           │ Multi-vendor plugins                           │
  └─────────────────────────────┴────────────────────────────────────────────────┴────────────────────────────────────────────────┘

  Commerce verdict: The core commerce loop (catalog → cart → checkout → payment → fulfillment → return) is solid. The biggest feature
   gap for a live store is single promotion model (many stores need coupon + automatic sale stacking) and flat-rate shipping only (no
   real-time carrier rates).

  ───
  DevOps & Reliability

  ┌────────────────────────────┬─────────────────────────────────────────────────┬────────────────────────────────────────────────┐
  │ Area                       │ SellRight                                       │ Assessment                                     │
  ├────────────────────────────┼─────────────────────────────────────────────────┼────────────────────────────────────────────────┤
  │ CI/CD                      │ GitHub Actions — comprehensive verify pipeline  │ Strong                                         │
  ├────────────────────────────┼─────────────────────────────────────────────────┼────────────────────────────────────────────────┤
  │ Database backups           │ Nightly pg_dump + 14-day retention + rclone     │ Good                                           │
  │                            │ offsite                                         │                                                │
  ├────────────────────────────┼─────────────────────────────────────────────────┼────────────────────────────────────────────────┤
  │ Backup restore testing     │ Not automated                                   │ HIGH — untested backups are not backups        │
  ├────────────────────────────┼─────────────────────────────────────────────────┼────────────────────────────────────────────────┤
  │ High availability          │ Single VPS — no failover, no load balancing     │ HIGH — single point of failure                 │
  ├────────────────────────────┼─────────────────────────────────────────────────┼────────────────────────────────────────────────┤
  │ Containerization           │ Available but not primary deployment            │ Low — reasonable for current scale             │
  ├────────────────────────────┼─────────────────────────────────────────────────┼────────────────────────────────────────────────┤
  │ Monitoring/APM             │ None — no Prometheus, Sentry, Datadog           │ HIGH — blind in production                     │
  ├────────────────────────────┼─────────────────────────────────────────────────┼────────────────────────────────────────────────┤
  │ Structured logging         │ None — ad-hoc console.log with prefixes         │ HIGH — hard to debug at scale                  │
  ├────────────────────────────┼─────────────────────────────────────────────────┼────────────────────────────────────────────────┤
  │ Alerting                   │ None                                            │ HIGH — you'll discover issues from customers   │
  ├────────────────────────────┼─────────────────────────────────────────────────┼────────────────────────────────────────────────┤
  │ Circuit breakers           │ None for Stripe/SMTP/Google                     │ MEDIUM — cascading failures possible           │
  ├────────────────────────────┼─────────────────────────────────────────────────┼────────────────────────────────────────────────┤
  │ Graceful shutdown          │ Not visible                                     │ MEDIUM — dropped requests on deploy            │
  ├────────────────────────────┼─────────────────────────────────────────────────┼────────────────────────────────────────────────┤
  │ Zero-downtime deploy       │ Impossible with single process + in-memory rate │ MEDIUM                                         │
  │                            │ limits                                          │                                                │
  ├────────────────────────────┼─────────────────────────────────────────────────┼────────────────────────────────────────────────┤
  │ Disaster recovery          │ No documented RTO/RPO                           │ HIGH                                           │
  └────────────────────────────┴─────────────────────────────────────────────────┴────────────────────────────────────────────────┘

  DevOps verdict: This is the weakest area. You're running a production commerce system with no monitoring, no alerting, no HA, and
  untested backups. This alone would stop me from migrating a live store.

  ───
  Testing

  ┌────────────────────────────┬─────────────────────────────────────────────────┬────────────────────────────────────────────────┐
  │ Area                       │ SellRight                                       │ Assessment                                     │
  ├────────────────────────────┼─────────────────────────────────────────────────┼────────────────────────────────────────────────┤
  │ Unit tests                 │ 35 files — strong coverage on money, licensing, │ Good                                           │
  │                            │ RLS, Stripe verify                              │                                                │
  ├────────────────────────────┼─────────────────────────────────────────────────┼────────────────────────────────────────────────┤
  │ Property tests             │ Discount distribution with 500 random trials    │ Strong                                         │
  ├────────────────────────────┼─────────────────────────────────────────────────┼────────────────────────────────────────────────┤
  │ Integration tests          │ Only 4 route files tested                       │ WEAK                                           │
  ├────────────────────────────┼─────────────────────────────────────────────────┼────────────────────────────────────────────────┤
  │ E2E tests                  │ None                                            │ CRITICAL — no checkout flow tested end-to-end  │
  ├────────────────────────────┼─────────────────────────────────────────────────┼────────────────────────────────────────────────┤
  │ Frontend tests             │ Zero — no admin or storefront component tests   │ WEAK                                           │
  ├────────────────────────────┼─────────────────────────────────────────────────┼────────────────────────────────────────────────┤
  │ Load/stress tests          │ None                                            │ HIGH                                           │
  ├────────────────────────────┼─────────────────────────────────────────────────┼────────────────────────────────────────────────┤
  │ CI-enforced invariants     │ RLS, hand-written migrations, shop isolation    │ Strong                                         │
  ├────────────────────────────┼─────────────────────────────────────────────────┼────────────────────────────────────────────────┤
  │ Coverage reporting         │ Not configured                                  │ LOW                                            │
  └────────────────────────────┴─────────────────────────────────────────────────┴────────────────────────────────────────────────┘

  Testing verdict: The unit tests for business logic are solid, but zero E2E tests means you can't verify the checkout → payment →
  fulfillment pipeline actually works after a deploy. This needs to exist before migrating real money flows.

  ───
  GDPR & Compliance

  ┌──────────────────────────┬────────────────────────────────────────────────┬───────────────────────────────┐
  │ Requirement              │ Status                                         │ Severity                      │
  ├──────────────────────────┼────────────────────────────────────────────────┼───────────────────────────────┤
  │ Self-service data export │ Missing                                        │ HIGH — legal requirement      │
  ├──────────────────────────┼────────────────────────────────────────────────┼───────────────────────────────┤
  │ Account deletion         │ Missing                                        │ HIGH — legal requirement      │
  ├──────────────────────────┼────────────────────────────────────────────────┼───────────────────────────────┤
  │ Consent tracking         │ Missing                                        │ MEDIUM                        │
  ├──────────────────────────┼────────────────────────────────────────────────┼───────────────────────────────┤
  │ Cookie consent banner    │ Missing                                        │ MEDIUM                        │
  ├──────────────────────────┼────────────────────────────────────────────────┼───────────────────────────────┤
  │ Data retention policy    │ Informal (soft deletes)                        │ MEDIUM                        │
  ├──────────────────────────┼────────────────────────────────────────────────┼───────────────────────────────┤
  │ Privacy policy page      │ Exists on storefront                           │ Good                          │
  ├──────────────────────────┼────────────────────────────────────────────────┼───────────────────────────────┤
  │ PCI SAQ-A                │ Missing                                        │ HIGH — compliance requirement │
  ├──────────────────────────┼────────────────────────────────────────────────┼───────────────────────────────┤
  │ Accessibility (WCAG)     │ Manual audit tool only, color-contrast skipped │ MEDIUM                        │
  └──────────────────────────┴────────────────────────────────────────────────┴───────────────────────────────┘

  ───
  What Must Be Fixed Before Migrating a Live Store

  Critical (must fix — can't go live without):

  1. Redis — for rate limiting and caching. Required before running >1 API process.
  2. E2E test suite — checkout flow, payment flow, refund flow must be automated.
  3. GDPR endpoints — customer data export + account deletion.
  4. Production monitoring — at minimum: Sentry for errors + structured logging (pino/winston).
  5. Database backup restore tested — automate and verify in CI.
  6. Alerting — at minimum: API error rate, payment failure rate, DB connection pool saturation.
  7. Load test — know your RPS ceiling before real traffic hits it.

  High (should fix before migration):

  1. Shipping carrier integration — flat-rate only is limiting for physical goods.
  2. Multi-promotion stacking — single discount model limits merchandising.
  3. Abandoned cart recovery emails — webhook exists but no automated email sequence.
  4. Circuit breakers for Stripe/SMTP/Google — prevent cascading failures.
  5. Graceful shutdown — SIGTERM handling to drain in-flight requests.
  6. PCI SAQ-A documentation — compliance requirement even with Stripe Elements.
  7. Zero-downtime deploy strategy — required if you're running a live store.

  Medium (debt to track):

  1. Complete strangler migration — remove Vendure paths from storefront.
  2. Consume @sellright/shared or delete it — aspirational packages confuse.
  3. Structured logging — replace console.log prefixes with pino.
  4. Database read replicas — for scaling reads.
  5. Feature flag service — replace VITE_ env vars with runtime flags.
  6. i18n support — needed if you have non-English customers.
  7. Fraud detection rules — at minimum, velocity checks and AVS/CVC rules.
  8. Cookie consent — GDPR/CCPA requirement.
  9. Admin undo/redo — safety net for operators.

  ───
  Bottom Line

  The security and data model are genuinely excellent — RLS-based tenant isolation, idempotency everywhere, server-authoritative
  pricing, and the two-role database architecture are better than what Shopify or WooCommerce offer architecturally. The core
  commerce engine (order FSM, stock reservation, payment reconciliation, refund flows) is well-built with strong invariants.

  But the operations story is missing: no monitoring, no alerting, no HA, no load testing, no E2E tests, in-process scheduling, and
  in-memory rate limiting. This means even if the code is correct, you can't operate it safely at production scale or recover from
  failures quickly.

  The codebase is closer to "launch-quality" than "migration-quality." A live store migration means you're betting revenue on this
  system, and the operations gaps would make me uncomfortable. Fix the 7 critical items first, then you have a solid foundation.qwen🔒 SellRight API — Penetration-Test-Level Security Audit
Executive Summary
The SellRight backend is exceptionally well-hardened for a commerce platform of its scope. The architecture shows deliberate security engineering: Postgres RLS with FORCE + non-owner role enforcement, token-hash-only storage, constant-time comparisons throughout, HMAC-signed download URLs, in-memory rate limiting, SSRF protection for webhooks, and server-authoritative pricing. The codebase comments reference a formal audit lineage (WP1–WP9, ra-001–ra-017), indicating prior security review cycles.
That said, I found 21 findings across the severity spectrum — including several actionable issues and a few that merit prompt attention.
---
CRITICAL Findings
CRIT-01: Admin Logout Missing CSRF Protection
File: packages/api/src/routes/admin.ts lines 59–70
admin.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/logout', summary: 'Admin logout',
    responses: { 200: { description: 'OK', content: J(z.object({ ok: z.boolean() })) } },
  }),
  async (c) => {
    const token = bearer(c.req.header('authorization')) ?? cookie(c, SESSION_COOKIE);
    if (token) await deleteAdminSession(token);
    clearAuthCookies(c);
    return c.json({ ok: true }, 200);
  },
);
The admin logout endpoint does NOT call csrfValid(c) before destroying the session. Compare with the customer logout in routes/auth.ts line 234 which correctly calls customerCsrfValid(c). An attacker can force-logout an admin by CSRF (e.g., embedding an image tag or form POST to /v1/admin/logout on a malicious page), causing denial of service to the admin and forcing repeated re-authentication.
Impact: Admin session denial via CSRF. Low direct impact but violates defense-in-depth and is inconsistent with the customer logout.
Fix: Add if (!csrfValid(c)) return c.json({ error: 'invalid CSRF token' }, 403); before the session delete, mirroring the customer logout pattern.
---
CRIT-02: Stored XSS via Blog Body/HTML — No Sanitization on Write or Read
File: packages/api/src/routes/admin-content.ts lines 46–47, 89
// Create (line 47):
body: b.body ?? null, bodyHtml: b.body ?? null,
// Update (line 89):
if (b.body !== undefined) { patch.body = b.body; patch.bodyHtml = b.body; ... }
File: packages/api/src/routes/shop-extra.ts lines 60–68 (public read)
// GET /v1/shop/blog/{slug} — returns raw bodyHtml to unauthenticated public
const out = await withStore(st.id, async (tx) =>
  (await tx.select().from(s.blogPost).where(and(eq(s.blogPost.slug, slug)...
The blog body and bodyHtml fields are stored and served with zero HTML sanitization. A compromised or malicious admin account can inject <script> tags, CSP-bypassing payloads, or phishing forms into the public storefront. The public blog endpoint (/v1/shop/blog/{slug}) returns the full row (including bodyHtml) to unauthenticated visitors.
Impact: Stored XSS affecting all storefront visitors reading the blog. If the storefront renders bodyHtml via innerHTML or similar, this is a full XSS chain.
Fix: Sanitize with DOMPurify (server-side) on write, or serve only the body (text) field publicly and strip dangerous tags/attributes.
---
HIGH Findings
HIGH-01: Newsletter Signup SSRF — Unvalidated Listmonk URL from Store Config
File: packages/api/src/routes/shop-extra.ts lines 124–128
const lm = (row?.config as { listmonk?: { url: string; apiUser: string; apiToken: string } } | null)?.listmonk;
if (lm?.url && lm?.apiToken) {
  try {
    const auth = Buffer.from(`${lm.apiUser}:${lm.apiToken}`).toString('base64');
    await fetch(`${lm.url.replace(/\/$/, '')}/api/subscribers`, {
      method: 'POST', headers: { authorization: `Basic ${auth}`, ... },
      body: JSON.stringify({ email, name: name || email, status: 'enabled' })
    });
The listmonk.url is read from the store's config JSONB and used directly in a fetch() call without passing through assertSafeOutboundUrl(). A store admin who sets config.listmonk.url to http://169.254.169.254/latest/meta-data/ (or any internal address) gets an SSRF oracle: the endpoint makes an authenticated HTTP request to that URL. While only admin-controlled, this bypasses the careful SSRF protections in outbound-url.ts.
Impact: Server-Side Request Forgery from the API server to internal network / cloud metadata.
Fix: Run lm.url through assertSafeOutboundUrl() before using it in fetch().
---
HIGH-02: Customer PATCH Allows Setting Arbitrary Fields (Mass Assignment)
File: packages/api/src/routes/admin-reports.ts lines 44–48
async (c) => guard(c, async () => {
    // ...
    const b = c.req.valid('json');
    const ok = await withStore(st.storeId, async (tx) => {
      // ...
      await tx.update(s.customer).set({ ...b, updatedAt: new Date() }).where(eq(s.customer.id, id));
While the Zod schema restricts which fields are accepted (firstName, lastName, phone, tags), the validated body b is spread directly into the .set() call. The Zod schema is:
z.object({ firstName: z.string().nullable().optional(), lastName: ..., phone: ..., tags: ... })
This is currently safe because Zod strips unknown keys by default, but the { ...b } spread pattern is fragile — a future schema change adding a stripeCustomerId or emailVerified field would immediately be writable by any admin. The customer route at routes/account.ts line 240-246 does this correctly with an explicit allow-list loop.
Impact: Potential mass assignment if the Zod schema widens. Currently mitigated by Zod's default strip behavior.
Fix: Use an explicit allow-list loop (same pattern as account.ts line 240) instead of { ...b }.
---
HIGH-03: Admin Session TTL of 14 Days with No Refresh/Rotation
File: packages/api/src/auth/admin-session.ts line 7
const ADMIN_SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
File: packages/api/src/auth/cookies.ts line 19
const MAX_AGE = 14 * 24 * 3600;
Admin sessions have a hard 14-day expiry with no sliding window or token rotation. Once created, a session token is valid for 14 days regardless of activity. Combined with the token being returned in the JSON response body (routes/admin.ts line 55: return c.json({ token, csrfToken: csrf, ... })), the token persists in response logs, browser dev tools, and any intermediary. A stolen token gives 14-day access with no way for the legitimate user to detect or mitigate.
Impact: Extended session hijacking window.
Fix: Implement idle timeout (e.g., 8h of inactivity) alongside the absolute TTL. Consider not returning the token in the JSON body when cookie auth is active (the cookie is already set).
---
HIGH-04: x-store-slug Header Trust in Shop Routes (Store Pivot)
File: packages/api/src/routes/store-context.ts lines 19-21
export async function resolveStoreFromCtx(c: RequestCtx): Promise<StoreCtx> {
  const slug = c.req.header('x-store-slug') ?? DEV_DEFAULT_STORE;
  return resolveStore(slug);
}
Shop (storefront) routes resolve the store entirely from the x-store-slug request header. While resolveStore() validates the slug against the database and RLS enforces isolation, this means:
1. A customer authenticated on Store A can send requests with x-store-slug: store-b and access Store B's catalog, cart, and checkout. Customer sessions are bound to a storeId (via session.storeId), but the session lookup in resolveCustomer doesn't enforce that the session's storeId matches the resolved store's storeId.
2. An attacker can probe all store slugs to enumerate tenants.
Looking at resolveCustomer() (auth/session.ts lines 41-60): the session token hash is the sole lookup key — there is no storeId filter. A customer token from Store A will resolve successfully when the request carries x-store-slug: store-b, granting access to Store B's customer account data.
Impact: Cross-tenant customer session confusion — a customer logged into one store can read their own data under another store's context, and potentially place orders against another store's catalog/pricing.
Fix: Add a storeId check in resolveCustomer() or at the route layer: reject if the resolved session's storeId doesn't match the resolved store context.
---
HIGH-05: Gift Card Balance Enumeration (No Rate Limiting)
File: packages/api/src/routes/shop-extra.ts lines 88–105
shopExtra.openapi(
  createRoute({
    method: 'get', path: '/v1/shop/gift-card/{code}', summary: 'Check a gift card balance',
    // ...
  }),
  async (c) => {
    // No rate limiting, no auth required
    const gc = await withStore(st.id, async (tx) => {
      const [g] = await tx.select({...}).from(s.giftCard).where(eq(s.giftCard.code, code)).limit(1);
The gift card balance endpoint is unauthenticated and has no rate limiting. Gift card codes appear to be short strings (no minimum length enforced in the schema — schema-orders.ts line 301: code: text().notNull().unique()). An attacker can brute-force gift card codes, learning both valid codes and their balances.
Impact: Gift card code enumeration and balance discovery.
Fix: Add rate limiting (reuse the loginRetryAfter infrastructure), require minimum code length/entropy, and consider adding a CAPTCHA.
---
HIGH-06: Order Tracking Endpoint Exposes grandTotal and Order Lines Without Receipt Token
File: packages/api/src/routes/shop-extra.ts lines 13–36
// GET /v1/shop/track?code=X&email=Y — no receipt token required
// Returns: code, state, placedAt, grandTotal, currency, fulfillment, lines
The tracking endpoint requires only code + email — both are relatively low-entropy. Order codes follow the pattern SR + 10 hex chars (checkout.ts line 48), which is ~40 bits of entropy but enumerable with rate-limit-free probing. Unlike the /v1/shop/orders/{code} endpoint (which correctly requires a receipt token), this endpoint leaks grandTotal, order lines, and fulfillment tracking data.
Impact: Order information disclosure via code + email guessing. No rate limiting on this endpoint.
Fix: Add rate limiting keyed on ip + code.
---
MEDIUM Findings
MEDIUM-01: Rate Limiter In-Memory Store — Bypass via Multi-Process/Rollback
File: packages/api/src/auth/rate-limit.ts lines 11–38
const store = new Map<string, Entry>();
The rate limiter is a per-process Map. Comments acknowledge this ("fine for a single instance; move to Redis when running multiple API instances"), but:
1. A restart clears all rate-limit state, allowing a burst of attempts.
2. Multi-process deployments (e.g., PM2 cluster) share no state, letting an attacker distribute attempts across workers.
3. The cleanup at line 38 (if (store.size > 5000)) only triggers at 5000 entries — an attacker can fill the map with 4999 distinct keys, and the oldest entries aren't pruned until the threshold is crossed.
Impact: Rate limit bypass in multi-process deployments or after restarts.
Fix: Use Redis or a shared store for production multi-process deployments.
---
MEDIUM-02: clientIp() Trusts cf-connecting-ip Without Validation
File: packages/api/src/auth/rate-limit.ts lines 50–51
export function clientIp(c) {
  return c.req.header('cf-connecting-ip') ?? c.req.header('x-real-ip') ?? c.env?.remoteAddr ?? 'unknown';
}
If the API is deployed without Cloudflare (direct exposure, or behind a different CDN), an attacker can forge cf-connecting-ip to any value, bypassing all IP-based rate limits by rotating the header value per request. The comment says "set by the Cloudflare edge, unspoofable" — but this is only true if the server is only reachable through Cloudflare.
Impact: Rate limit bypass if Cloudflare is not the sole ingress.
Fix: Validate that the request actually originates from Cloudflare IP ranges before trusting cf-connecting-ip, or use a framework-level trusted proxy configuration.
---
MEDIUM-03: Admin Login Response Leaks Token in JSON Body
File: packages/api/src/routes/admin.ts line 55
return c.json({ token, csrfToken: csrf, admin: { email: u.email }, stores: admin?.stores ?? [] }, 200);
The raw session token is returned in the JSON response body alongside setting the httpOnly cookie. This means the token exists in:
- Browser network inspector / dev tools
- Any HTTP response logging
- Browser memory (accessible to any XSS that bypasses httpOnly)
- CDN/proxy logs if response bodies are logged
This partially negates the httpOnly cookie protection. API clients need the token, but for browser clients the cookie is sufficient.
Impact: Increased token exposure surface.
Fix: Conditionally include the token in the body only when the client signals it's an API client (e.g., no User-Agent browser match, or a specific header).
---
MEDIUM-04: Stripe Webhook Tries Both Test and Live Secrets (Timing Oracle)
File: packages/api/src/routes/payment-webhooks.ts lines 44–57
for (const mode of ['test', 'live'] as StripeMode[]) {
    const secret = stripeCreds(mode).webhookSecret;
    if (!secret) continue;
    try {
      event = verifyStripeWebhook(raw, sig, secret);
      verifiedMode = mode;
      break;
    } catch { /* signature didn't match this mode's secret — try the other. */ }
}
The webhook endpoint iterates through both mode secrets. While this is necessary for dual-mode support, an attacker observing response timing can determine whether test or live mode matched (or neither). This is very low severity since the attacker can't do anything useful with this information, but it's worth noting.
Impact: Theoretical timing oracle on webhook secret mode.
Fix: Use timingSafeEqual or always iterate both modes before returning.
---
MEDIUM-05: Password Reset Token Sent in URL Query Parameter
File: packages/api/src/routes/customer-tokens.ts line 49
const url = `${env.STOREFRONT_URL}/password-reset?token=${raw}`;
The password reset token is placed in the URL query string. This means it appears in:
- Browser history
- Referer headers (if the reset page loads external resources)
- Web server access logs
- Any CDN/proxy logs
While the token is 256-bit random and has a 2-hour TTL, this exposure pattern is well-known.
Impact: Token leakage via browser history and server logs.
Fix: This is a common trade-off; mitigations include ensuring the storefront redirects to strip the token from the URL after reading it, and the 2-hour TTL already limits exposure.
---
MEDIUM-06: unsafeUnscopedDb Used in admin-session.ts for Session Resolution
File: packages/api/src/auth/admin-session.ts lines 3, 53-93
import { unsafeUnscopedDb as db } from '../db/client.js';
// ...
export async function resolveAdmin(token: string): Promise<AdminPrincipal | null> {
  const rows = await db.select({...}).from(s.session)...
The admin session resolution uses unsafeUnscopedDb (no RLS) by design — sessions are cross-store. However, the session table is in the RLS EXEMPT list (assert-force-rls.ts line 20). If an attacker finds a path to write to the session table (e.g., through a migration bug or SQL injection elsewhere), they can create sessions for any admin without RLS protection.
Impact: Design decision with defense-in-depth implications.
Note: This is a documented, deliberate architectural choice. The mitigation is the 256-bit token hash requirement.
---
MEDIUM-07: Customer Registration Doesn't Verify Email Before Session Creation
File: packages/api/src/routes/auth.ts lines 51-90 (registration flow)
// POST /v1/shop/auth/register — creates customer + session immediately
// emailVerified defaults to false, but the customer gets a full session
A customer gets a fully authenticated session immediately upon registration, before email verification. This means:
- An attacker can register with any email and immediately place orders, access the account, etc.
- The isMigrated flag distinguishes migrated accounts but doesn't gate functionality.
Impact: Account creation with unverified emails allows full platform access.
Note: This is a common UX trade-off; the email verification is available but not enforced.
---
MEDIUM-08: Blog Post Body Stored and Served as Raw HTML (Admin → Public XSS)
File: packages/api/src/routes/admin-content.ts line 47
body: b.body ?? null, bodyHtml: b.body ?? null,
The admin's raw input is stored as both body and bodyHtml with no sanitization. The public blog endpoint returns the full row. This is the stored XSS from CRIT-02, but even if the frontend escapes on render, the API serves unsanitized HTML that any client could render unsafely.
---
LOW Findings
LOW-01: check-email Endpoint is a Deliberate Account Enumeration Oracle
File: packages/api/src/routes/auth.ts lines 196-222
// GET /v1/shop/auth/check-email?email= — pre-submit UX ("email already in use").
// WP4a. This is a DELIBERATE account-existence oracle...
The endpoint intentionally reveals whether an email is registered. While rate-limited (8/15min per IP), this allows an attacker with multiple IPs (residential proxy) to enumerate the customer database.
Impact: Email enumeration at scale.
Note: Documented as deliberate; the rate limit mitigates casual abuse.
---
LOW-02: scrypt Without Explicit Cost Parameters
File: packages/api/src/auth/password.ts lines 5-11
const KEYLEN = 64;
export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const dk = (await scryptA(pw, salt, KEYLEN)) as Buffer;
The scrypt call uses Node.js's default N=16384, r=8, p=1 cost parameters (from the crypto.scrypt defaults). While these are adequate, they are not explicitly set, meaning a Node.js version upgrade could change them silently. The hash format scrypt$<salt>$<hash> doesn't encode the cost parameters, so future verification always uses whatever the runtime defaults are.
Impact: If Node.js changes scrypt defaults, old hashes may fail to verify or verify at a different cost.
Fix: Encode N, r, p in the hash string and pass them explicitly.
---
LOW-03: TOTP Replay Protection is In-Process Only
File: packages/api/src/auth/totp.ts lines 48-66
const recentByActor = new Map<string, { step: number; at: number }>();
TOTP replay protection uses an in-memory map, so a server restart clears the replay window. Comments acknowledge this ("a server restart only widens the window to 90s, not 0"). In multi-process deployments, concurrent requests to different workers could both succeed with the same TOTP code.
Impact: TOTP code reuse within the ±1 step window during restarts or across workers.
Note: The 90-second window is narrow; practical exploitability is low.
---
LOW-04: Email Subject Line Injection Partially Mitigated
File: packages/api/src/email/templates.ts line 11
subject: `[${store.name}] ${title}`.replace(/[\r\n]+/g, ' '),
CR/LF stripping prevents header injection in the subject line. However, the store.name comes from the database (admin-controlled), and title can contain caller data. The staffInvite template at line 48 includes data.inviterEmail in the title:
wrap(store, `${data.inviterEmail} invited you to ${store.name}`,
While CR/LF is stripped, special characters in the email could still affect email parsing in edge cases. The .replace(/[\r\n]+/g, ' ') mitigation is solid.
Impact: Minimal — the CR/LF strip is effective.
---
LOW-05: Download Artifact Path Traversal — Mitigated but Redirect Not Validated
File: packages/api/src/routes/apps.ts lines 298-300
if (/^https?:\/\//i.test(artifact.path)) return c.redirect(artifact.path, 302);
When a download artifact has an HTTP(S) path, the endpoint issues a redirect without validating the URL. An admin who sets artifact.path to a phishing URL or internal service gets an open redirect from the API domain.
Impact: Open redirect for admin-configured artifact URLs.
Fix: Validate the redirect URL against assertSafeOutboundUrl() or restrict to known domains.
---
LOW-06: DEV_DEFAULT_STORE Fallback in Production
File: packages/api/src/store-context.ts line 46
export const DEV_DEFAULT_STORE = 'damned';
If no x-store-slug header is sent, requests default to the damned store. In production, if a misconfigured client omits the header, all requests silently route to this store. The slug validation in resolveStore() mitigates this (it'll 404 if the slug doesn't exist), but the default itself is a dev artifact.
Impact: Dev default leaking into production routing.
Fix: Make DEV_DEFAULT_STORE conditional on NODE_ENV !== 'production'.
---
Strengths (Positive Findings)
Area	Assessment
RLS / Tenant Isolation	FORCE RLS on all store-scoped tables, withStore() sets app.current_store via SET LOCAL, non-owner DB role, automated assert-force-rls.ts guard — best-in-class
Password Hashing	scrypt with random salt, constant-time comparison, self-describing hash format — solid
Token Storage	All tokens (session, invite, reset, activation) stored as SHA-256 hashes only — raw tokens never persist — excellent
CSRF	Double-submit cookie with constant-time compare, httpOnly session cookie, SameSite=Lax — solid (except admin logout gap)
Payment Security	Server-side price authority, PaymentIntent verification (verifyIntent binds amount/currency/orderCode), idempotent processing, webhook HMAC verification — excellent
SQL Injection	All queries use Drizzle ORM with parameterized queries; the sql tagged template uses $1-style bind params via Drizzle. The %${q}% patterns in ilike() calls are passed as bind params, not string interpolation. — no SQLi found
Signed Downloads	HMAC-SHA256 signed URLs with expiry, constant-time verification, bindings to (storeId, artifactKey, exp) — excellent
SSRF Protection	Comprehensive outbound-url.ts with DNS rebinding protection (TOCTOU pinned lookup), IPv4/IPv6 private range blocking — excellent (except newsletter gap)
Email Security	HTML escaping in templates, CR/LF stripping in subjects, plain TS templates (no template engine injection surface) — solid
Rate Limiting	Sliding window, per-IP+identifier keying, X-Forwarded-For intentionally ignored, CF-Connecting-IP prioritized — solid
Idempotency	Stripe PaymentIntent creation, checkout, and payment all use idempotency keys with DB-level unique constraints — excellent
File Upload	Re-encodes to WebP (strips hidden payloads), format allowlist, size limit, UUID filenames — excellent
Secrets Management	Zod-validated env, fail-fast boot, optional Stripe/SMTP with graceful degradation, .gitleaks.toml for history scanning — solid
License Issuance	SELECT FOR UPDATE serialization, per-line idempotency counting, seat cap enforcement — excellent
---
Priority Remediation Plan
Priority	Finding	Effort
1	CRIT-01: Add CSRF check to admin logout	1 line
2	CRIT-02: Sanitize blog HTML (DOMPurify)	~30 min
3	HIGH-01: SSRF-guard newsletter Listmonk URL	~15 min
4	HIGH-04: Add storeId check to customer session resolution	~30 min
5	HIGH-05: Rate-limit gift card balance endpoint	~15 min
6	HIGH-06: Rate-limit order tracking endpoint	~15 min
7	HIGH-03: Implement idle session timeout for admin	~2 hr
8	HIGH-02: Explicit allow-list in customer PATCH	~15 minSellRight Deep Performance Audit
Executive Summary
SellRight is a single-instance Node.js + Postgres commerce platform (Hono API + Qwik storefront) with solid architectural foundations: RLS-based multi-tenancy, transactional outbox for webhooks, server-authoritative pricing, and idempotent checkout. However, there are ~30 actionable performance findings across 7 domains, ranging from critical (N+1 in checkout, no connection pooling scaling) to important (missing indexes, sequential job execution) to optimization opportunities (no Redis/cache layer, no CDN).
---
1. Database Performance
🔴 CRITICAL: N+1 Query in release-stale-allocations.ts (Lines 42-60)
// release-stale-allocations.ts:42-60
const stale = await tx
  .select({ id: s.order.id, code: s.order.code, createdAt: s.order.createdAt })
  .from(s.order)
  .where(and(eq(s.order.state, 'PendingPayment'), lt(s.order.createdAt, cutoff)));
// N+1: for EACH stale order, a separate query fetches its lines
for (const o of stale) {
  const lines = await tx.select().from(s.orderLine).where(eq(s.orderLine.orderId, o.id));
  // ... then for each line, a separate UPDATE to stock
}
Impact: With thousands of historical PendingPayment orders (documented in comments), this becomes O(N×M) queries. Each order needs 1 SELECT for lines + 1 UPDATE per line to stock.
Fix: Batch-fetch all lines with WHERE order_id = ANY($1) and group by order. Batch stock updates with a single UPDATE stock SET allocated = allocated - delta FROM (VALUES ...) AS release(variant_id, qty) WHERE stock.variant_id = release.variant_id.
🔴 CRITICAL: Same N+1 Pattern in auto-deliver.ts (Lines 27-33)
// auto-deliver.ts:27-33
for (const f of due) {
  await tx.update(s.fulfillment).set({...}).where(eq(s.fulfillment.id, f.id));
  await tx.insert(s.auditLog).values({...});
}
Fix: Use UPDATE fulfillment SET state = 'Delivered' WHERE id = ANY($1) RETURNING id as a single statement.
🟡 HIGH: Missing Indexes on Frequently-Queried Columns
Table	Missing Index	Query Location
product_variant	(sku, store_id)	checkout.ts:88-95, cart.ts:44-53 (every checkout/cart op)
stock	(variant_id) standalone	stock-reservation.ts:41 (checkout hot path)
cart	(token)	cart.ts:219-221 (every cart read)
customer	(store_id, email)	checkout.ts:150-157 (customer lookup on every checkout)
order	(store_id, code)	checkout.ts:329-334, pay.ts:56 (order-by-code reads)
product_variant	(product_id) WHERE deleted_at IS NULL	catalog.ts:125-128 (product detail)
The stock table PK is variantId (line 364 of schema-orders.ts), which helps, but the stock-reservation UPDATE at checkout also filters on store_id and (on_hand - allocated) >= qty — there's no composite index covering that.
Fix: Add migration 0037_perf_indexes.sql:
CREATE INDEX IF NOT EXISTS variant_store_sku_idx ON product_variant (store_id, sku) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS cart_token_idx ON cart (token);
CREATE INDEX IF NOT EXISTS customer_store_email_idx ON customer (store_id, email) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS order_store_code_idx ON "order" (store_id, code) WHERE deleted_at IS NULL;
🟡 HIGH: Two-Query Pagination Pattern (catalog.ts:65-85)
Every list endpoint runs a separate COUNT(*) query:
// catalog.ts:65-85
const items = await tx.select({...}).from(s.product).where(where).limit(limit).offset(offset);
const totalRows = await tx.select({ total: sql<number>`count(*)::int` }).from(s.product).where(where);
This pattern appears in catalog.ts (product list + search), admin-orders.ts (order list), and admin-dashboard.ts. For large tables, the COUNT query is a full sequential scan.
Fix: 
- Use cursor-based pagination (WHERE id > $last_id ORDER BY id LIMIT $n) instead of offset.
- Or use a window function: count(*) OVER() AS total in the same query (Postgres computes it once).
- For admin dashboards, accept an approximate count from pg_stat_user_tables.n_live_tup.
🟡 HIGH: ILIKE Search Even With Trigram Index (catalog.ts:271)
sql`(${s.product.name} ilike ${like} or ${s.product.description} ilike ${like})`
The trigram GIN indexes (migration 0029) help, but ILIKE with OR across two columns prevents the planner from using a single index efficiently. With %term% patterns, both indexes must be scanned and unioned.
Fix: Add a generated always as search column (to_tsvector('english', coalesce(name,'') || ' ' || coalesce(description,''))) with a GIN index, or use pg_trgm's similarity() for ranked results.
🟡 MEDIUM: Connection Pool Defaults Are Conservative (env.ts:25)
PGPOOL_MAX: z.coerce.number().int().positive().default(10),
PGPOOL_IDLE_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(10000),
PGPOOL_CONNECTION_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(0),
10 connections is low for production. Each withStore() call holds a connection for the entire transaction duration. Checkout alone holds a connection through stock reservation, order creation, payment attempt, and email dispatch (~500ms-2s).
Risk: connectionTimeoutMillis: 0 = infinite wait. Under load, requests queue indefinitely instead of failing fast with a 503.
Fix: 
- Set PGPOOL_MAX to CPU cores × 2 + disk spindles (typically 20-30 for a single instance).
- Set PGPOOL_CONNECTION_TIMEOUT_MS to 5000ms so overload returns 503 instead of hanging.
- Consider PgBouncer in transaction mode for multi-instance scaling.
🟡 MEDIUM: withStore() Wraps ALL Work in a Transaction (client.ts:41-57)
export async function withStore<T>(storeId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  await client.query('BEGIN');
  await client.query("SELECT set_config('app.current_store', $1, true)", [storeId]);
  // ... fn(tx) ... COMMIT/ROLLBACK
}
Every read-only operation (catalog listing, product detail, cart GET) opens a full transaction. For read-only endpoints, this is unnecessary overhead (MVCC snapshot, WAL tracking, lock acquisition).
Fix: Add a withStoreRead() that uses a read-only transaction (BEGIN READ ONLY) or a non-transactional connection with SET LOCAL set before each query. Postgres READ ONLY transactions skip WAL overhead.
🟢 LOW: resolveStore() Hits DB on Every Request (store-context.ts:36-44)
export async function resolveStore(slug: string): Promise<StoreCtx> {
  const r = await pool.query<StoreCtx>(
    'SELECT id, slug, name, currency, tax_rate AS "taxRate"... FROM store WHERE slug = $1 LIMIT 1', [slug]
  );
}
Store metadata (id, name, currency, config) changes rarely but is fetched on every request.
Fix: In-process LRU cache with 60s TTL. Invalidate on admin settings save.
---
2. Caching Strategy
🔴 CRITICAL: No Server-Side Caching Layer
There is no Redis, no in-memory cache, no CDN integration on the API side. Every product list, product detail, catalog search, and stock check hits Postgres directly:
- GET /v1/shop/catalog/products → Postgres (catalog.ts:64)
- GET /v1/shop/catalog/products/{slug} → Postgres (catalog.ts:103)
- GET /v1/shop/catalog/products/{slug}/stock → Postgres (catalog.ts:306)
- GET /v1/shop/catalog/collections → Postgres (catalog.ts:195)
Impact: The storefront's product listing and detail pages are DB-bound. Under traffic spikes (product launch, flash sale), every page view generates 2-3 Postgres queries.
Fix: 
1. Add an in-process LRU cache (e.g., lru-cache) for product listings with 30-60s TTL.
2. Add Cache-Control: public, max-age=30, stale-while-revalidate=60 headers on catalog endpoints.
3. For stock endpoint, use shorter TTL (5s) or WebSocket/SSE for real-time updates.
🟡 MEDIUM: Client-Side Product Cache Is Memory-Only (ProductCacheService.ts)
const cache = new Map<string, CacheEntry<any>>();
const CACHE_TTL = 10 * 60 * 1000;
const MAX_SIZE = 50;
The storefront's ProductCacheService is an in-memory Map with 50 entries and 10min TTL. It:
- Doesn't survive page navigation (Qwik re-serializes module state)
- Can't be shared across tabs/workers
- Uses FIFO eviction (line 27-29: evicts the first key, not the LRU)
Fix: Use localStorage or IndexedDB for persistent caching. The image-cache.ts already demonstrates this pattern with sessionStorage.
🟡 MEDIUM: No CDN or Asset Optimization Headers
The catalog routes return raw JSON with no caching headers. Image paths are stored as plain URLs in the database with no CDN rewrite, no srcset, no responsive sizing.
---
3. API Performance
🟡 HIGH: Checkout Response Reads Back Order in Separate Transaction (checkout.ts:351-379)
After the checkout transaction commits, a second withStore() opens to re-read the order for email dispatch:
// checkout.ts:351 — second transaction just for email data
const email = await withStore(st.id, async (tx) => {
  const [o] = await tx.select({...}).from(s.order)
    .leftJoin(s.customer, eq(s.customer.id, s.order.customerId))
    .where(eq(s.order.code, out.code)).limit(1);
  const lines = await tx.select({...}).from(s.orderLine)
    .leftJoin(s.productVariant, eq(s.productVariant.id, s.orderLine.variantId))
    .where(eq(s.orderLine.orderId, o.id));
  // ...
});
This doubles the database round-trips for every successful checkout.
Fix: Include the email data in the return value from the first withStore() transaction. The email send is already fire-and-forget (line 381: catch + log).
🟡 HIGH: Checkout Transaction Is Too Wide (checkout.ts:140-317)
The checkout withStore() wraps: variant lookup, stock reservation, coupon evaluation, gift card application, order insert, line inserts, promotion usage insert, payment attempt, license issuance, stock movement recording, and audit logging — all in a single transaction holding a connection for 500ms-2s.
Fix: Split into two phases:
1. Phase 1 (must be atomic): variant read, stock reservation, order+lines+promotion insert → COMMIT
2. Phase 2 (can fail independently): payment, email, license issuance
This reduces connection hold time by ~60%.
🟡 MEDIUM: Full Table SELECT in Cart Lines (cart.ts:219)
const items = await tx.select().from(s.cartLine).where(eq(s.cartLine.cartId, c.id));
select() with no column list returns all columns. Cart lines carry id, storeId, cartId, variantId, sku, quantity, createdAt — the storeId and createdAt are never used in cart pricing.
Fix: Select only needed columns: select({ sku, quantity, variantId }).
🟡 MEDIUM: Cart Merge Has O(N×M) Queries (cart.ts:336-353)
const others = await tx.select().from(s.cart).where(...);
for (const o of others) {
  const lines = await cartItems(tx, o.id);
  for (const l of lines) {
    await tx.insert(s.cartLine).values({...}).onConflictDoUpdate({...});
  }
  await tx.update(s.cart).set({...}).where(eq(s.cart.id, o.id));
}
Each "other" cart triggers N+1 queries (fetch lines + insert each line + update cart).
Fix: Batch with INSERT INTO cart_line ... ON CONFLICT DO UPDATE using VALUES list, and UPDATE cart SET status = 'abandoned' WHERE id = ANY($1).
🟢 LOW: No Response Compression or Field Filtering
API responses include all fields. The catalog product list returns slug, name, status, minPrice, image which is already minimal, but the product detail returns full variant arrays with all columns.
---
4. Concurrency & Stock Allocation
✅ GOOD: Stock Reservation Uses Atomic UPDATE (stock-reservation.ts:39-42)
const res = await tx.execute(sql`
  UPDATE "stock" SET allocated = allocated + ${i.quantity}
  WHERE variant_id = ${v.id} AND store_id = ${storeId} AND (on_hand - allocated) >= ${i.quantity}`);
This is correct — the WHERE clause ensures atomic stock checking. However:
🟡 HIGH: Sequential Stock Reservation Loop (stock-reservation.ts:36-43)
for (const i of items) {
  // ... separate UPDATE per item
}
Each cart item gets its own UPDATE statement. For a 10-item cart, that's 10 sequential DB round-trips inside the transaction.
Fix: Single batched UPDATE:
UPDATE stock s SET allocated = s.allocated + r.qty
FROM (VALUES ($v1, $q1), ($v2, $q2), ...) AS r(variant_id, qty)
WHERE s.variant_id = r.variant_id AND s.store_id = $storeId
  AND (s.on_hand - s.allocated) >= r.qty
Then check rowCount against expected count to detect failures.
🟡 MEDIUM: Idempotency Relies on Catching 23505 (checkout.ts:327)
if (idemKey && (e as { code?: string })?.code === '23505') {
  return withStore(st.id, async (tx) => {
    const [o] = await tx.select({...}).from(s.order)
      .where(eq(s.order.idempotencyKey, idemKey)).limit(1);
  });
}
The double-submit protection relies on catching a Postgres unique violation and then re-reading the winner's order. This means the losing transaction's entire work (stock allocation, order creation) is rolled back and must be re-read. Under high concurrency, this wastes resources.
Fix: Use advisory locks (pg_advisory_xact_lock(hashtext(idemKey))) at the start of checkout to serialize concurrent submissions with the same key, preventing the rollback entirely.
🟢 GOOD: Payment Idempotency (pay.ts:62-84)
The payment endpoint uses processed_event as a claim table to prevent double-charging. Declined payments correctly clear the claim for retry.
---
5. Background Jobs
🔴 CRITICAL: In-Process setInterval Scheduler — No Persistence, No Distribution (scheduler.ts)
function every(ms: number, label: string, fn: () => Promise<unknown>): NodeJS.Timeout {
  let running = false;
  const tick = async () => {
    if (running) return; // skip if the previous pass hasn't finished
    // ...
  };
  const t = setInterval(tick, ms);
  t.unref?.();
}
Problems:
1. No persistence: If the process restarts mid-job, the work is lost. The webhook reaper mitigates for webhooks, but cart abandonment and stock release have no such safety net.
2. No distribution: Running multiple API instances means jobs run N times concurrently. The FOR UPDATE SKIP LOCKED in webhook delivery prevents double-delivery, but release-stale-allocations and cart-maintenance have no such protection.
3. Overlap suppression is per-process: if (running) return only prevents overlap within one process.
Fix: Move to BullMQ (Redis-backed) or pg-boss (Postgres-backed). For the current single-instance deployment, pg-boss is ideal — it uses FOR UPDATE SKIP LOCKED natively and needs no Redis.
🟡 HIGH: Jobs Iterate ALL Stores Sequentially (release-stale-allocations.ts:36-74, auto-deliver.ts:23-42, webhook-reaper.ts:34-67, cart-maintenance.ts:25-41)
Every job follows this pattern:
const stores = await pool.query('SELECT id FROM store');
for (const st of stores.rows) {
  await withStore(st.id, async (tx) => { /* work */ });
}
Each store opens a separate transaction. With N stores, this serializes all work.
Fix: For stores with no work, the query inside withStore returns empty quickly, so the overhead is connection acquisition per store. Consider a single transaction with SET app.current_store toggled, or parallelize with Promise.allSettled() (bounded concurrency).
🟡 MEDIUM: Cart Maintenance Emits Events Inside Transaction (cart-maintenance.ts:33-35)
for (const c of stale) {
  await tx.update(s.cart).set({...}).where(eq(s.cart.id, c.id));
  await emitEvent(tx, storeId, 'cart.abandoned', { token: c.token, email: c.email });
}
emitEvent inserts webhook delivery rows in the same transaction. With the ABANDON_BATCH = 500 cap, this can be 500 cart updates + 500×N webhook inserts in a single transaction holding a connection for seconds.
Fix: Batch the updates (UPDATE cart SET status = 'abandoned' WHERE id = ANY($1)), then batch-insert webhook deliveries.
---
6. Image/Media
🟡 HIGH: No Image Processing Pipeline
sharp is listed as a dependency (api/package.json:29) but there's no evidence of an image processing route or middleware. The catalog routes return raw asset.path URLs:
// catalog.ts:71
image: sql<string | null>`max(${s.asset.path})`
The storefront generates preload links for avif and webp formats (product page line 148), but these must be pre-generated or served by nginx.
Fix: Add a Sharp-based image transform route (or middleware) that serves resized/converted images on demand with Cache-Control: immutable, max-age=31536000. Use ?w=400&format=webp query params.
🟡 MEDIUM: Image Cache Is Session-Only (image-cache.ts)
const STORAGE_KEY = 'dd_cached_images';
// Uses sessionStorage — cleared on tab close
The storefront image cache uses sessionStorage (line 15), which is cleared when the tab closes. The MAX_CACHE_SIZE = 100 is reasonable but the FIFO eviction (keep newest half, line 44) is crude.
🟢 LOW: No Lazy Loading Evidence
The product grid renders all ProductCard components eagerly (shop/index.tsx:333-368). With 200+ products, this creates a large DOM. No IntersectionObserver or virtual scrolling is visible.
---
7. Storefront Performance
✅ EXCELLENT: Qwik Framework Choice
Qwik's resumability (no hydration) is ideal for ecommerce. The storefront correctly uses:
- routeLoader$ for SSR data fetching
- useVisibleTask$ only for client-only work (Stripe.js)
- Manifest-based catalog (file reads at SSR, no API call)
🟡 HIGH: Dual API Layer — GraphQL Legacy + REST Migration (api.ts + sellright.ts)
The storefront carries two complete API layers:
1. Legacy Vendure GraphQL (api.ts): requester() → execute() → executeOnTheServer() → Vendure at :3100
2. New SellRight REST (sellright.ts): sr() → fetch to :3300
The GraphQL path adds a server-side proxy hop (server$ on line 65 of api.ts) that:
- Serializes/deserializes through the SSR layer
- Always targets http://localhost:3100/shop-api (hardcoded, line 66)
- Carries the entire GraphQL runtime (~50KB+ of generated types)
Fix: Complete the migration to REST. Remove the GraphQL codegen, generated types, and api.ts requester.
🟡 HIGH: Hardcoded Client-Side Shipping Calculation (checkout/index.tsx:60-78)
const checkoutTotalCents = useComputed$(() => {
  const subtotal = localCart.localCart.subTotal || 0;
  // ...
  if (countryCode === 'US' || countryCode === 'PR') {
    shipping = discountedSubtotal >= 10000 ? 0 : 800;
  } else {
    shipping = 2000;
  }
});
The checkout page duplicates the shipping calculation client-side with hardcoded rates ($8 US, $20 international, free over $100). This disagrees with the server's shipping/calculator.ts which supports zone-based rates, min/max, and exclusions.
Fix: Remove the client-side calculation. Use the server-authoritative cart pricing (already available in ServerCartService).
🟡 MEDIUM: Large Client-Side Cart Service (~386 lines)
LocalCartService.ts is 386 lines of imperative localStorage manipulation, stock validation, and total recalculation — all running on the client. The ServerCartService (387 lines) mirrors it. This doubles the JS bundle for cart functionality.
🟡 MEDIUM: useVisibleTask$ for Stock Refresh on Product Pages
The product detail page uses client-side stock refresh after hydration. While this is a progressive enhancement pattern, it means every PDP load fires an additional API call (/v1/shop/catalog/products/{slug}/stock) after the initial render.
🟢 LOW: Stripe.js Loads on Every Checkout Visit (StripePaymentElement.tsx:37)
const stripe = await loadStripe(props.publishableKey);
loadStripe() loads the full Stripe.js SDK (~40KB gzipped) on every checkout page visit, even if the user hasn't selected Stripe as their payment method.
Fix: Lazy-load Stripe.js only when the Stripe payment option is selected.
---
Priority Matrix
Priority	Finding	Effort	Impact
P0	Add server-side cache for catalog endpoints	2h	10x read throughput
P0	Batch stock reservation UPDATEs	1h	50% faster checkout
P0	Fix N+1 in release-stale-allocations	2h	Prevents job timeout at scale
P0	Add missing indexes (variant SKU, cart token, customer email)	1h	5-50x query speedup
P1	Move jobs to pg-boss or BullMQ	4h	Multi-instance safety
P1	Split checkout transaction into 2 phases	3h	60% less connection hold
P1	Add Cache-Control headers on catalog APIs	30m	CDN-ready responses
P1	Image processing pipeline with Sharp	4h	60-80% smaller images
P2	Connection pool tuning (raise max, add timeout)	30m	Prevents overload hangs
P2	Cursor-based pagination for admin lists	2h	Stable performance at scale
P2	Remove GraphQL legacy layer	4h	Smaller bundle, simpler codebase
P2	Lazy-load Stripe.js	30m	40KB saved on checkout load
P3	Add advisory locks for idempotent checkout	1h	Cleaner concurrency
P3	Store metadata caching	30m	1 query saved per request
P3	Virtual scrolling for product grid	2h	Better mobile UXExecutive Summary
SellRight is a genuinely well-engineered commerce kernel — the multi-tenancy, money path invariants, and security posture are legitimately best-in-class for a self-hosted platform. But it is not yet a production replacement for any of the three reference platforms for general commerce. It is, however, already ahead of all three for the specific use case it was built for: multi-tenant digital software/license sales. The gap is the breadth layer — shipping, payments, operational tooling, and scale infrastructure.
Verdict: Ready for RightApps (digital/software). Not ready for a general merchant migrating from Shopify/WooCommerce without significant investment in the gaps below.
---
1. Multi-Tenancy
What SellRight Has (🟢 Best-in-Class)
Aspect	Implementation
Isolation model	Postgres RLS with FORCE ROW LEVEL SECURITY on 40+ tables. SET LOCAL app.current_store per transaction. Every store-scoped table has store_id + RLS policy referencing app.current_store.
Defense in depth	Non-owner app role (sellright_app), startup assertion (assert-force-rls.ts), table-driven RLS test suite (rls-tables.test.ts) that auto-discovers every store-scoped table and proves the USING clause references both store_id and current_store.
Write isolation	WITH CHECK policies prevent cross-tenant writes (tested: INSERT INTO product ... store_id = B from store A context is rejected).
Fail-closed	Without a current_store context, queries return ZERO rows.
Code isolation	ESLint rule blocks unsafeUnscopedDb imports from route files. An assert-shop-route-isolation.mjs script is wired into pnpm verify.
Audit trail	audit_log table records actor, entity, state transitions per store.
vs Competitors
Platform	Tenancy Model
Shopify	One-store-per-account. Multi-store requires Shopify Plus organizations ($2,300+/mo). No shared-schema isolation.
WooCommerce	Single-store per WordPress install. Multi-store = WordPress multisite (fragile) or separate installs.
Vendure	Channel-based multi-tenancy at the application layer (TypeORM WHERE clauses). No database-level enforcement. A bug in a query can leak cross-channel data.
Data Leakage Risks
- processed_event is in the EXEMPT set (no RLS). It's a global idempotency table keyed on provider event IDs. Low risk (no PII), but a future migration that adds tenant-scoped columns would bypass RLS silently.
- store table is not RLS'd (it's the registry). Correct by design.
- session is exempt (auth lookups before store resolution). Correct.
- ⚠️ Webhook delivery iterates SELECT id FROM store then withStore per store — this is O(n) stores per tick. At 100+ stores, the scheduler becomes a bottleneck.
Verdict: 🟢 STRONGER than all three competitors.
The RLS model is the kind of defense-in-depth that Shopify charges Plus prices for and Vendure can't match. This is a genuine moat.
---
2. Checkout Flow
What SellRight Has
Step	Implementation
Cart → Order	POST /v1/shop/checkout — reads from server cart (fail-closed: empty server cart = 409, not "0 items"). Server-authoritative pricing.
Price authority	Server re-reads every variant, re-selects price (preorder > sale > base), re-validates coupon. Client prices are suggestions only.
Stock allocation	Atomic UPDATE stock SET allocated = allocated + qty WHERE (on_hand - allocated) >= qty inside the same transaction. Rolls back on failure.
Idempotency	Idempotency-Key header + (store_id, idempotency_key) unique constraint. Concurrent double-submit → the loser's txn rolls back and returns the winner's order.
Receipt token	High-entropy token returned by checkout, required for confirmation page read (prevents order enumeration).
Guest checkout	Email on the request body; customer linkage via email match or session.
Promotions	Coupons (percentage, fixed, free_shipping), automatic discounts, SheerID verification-gated discounts, per-customer usage limits, exclusion groups.
Gift cards	Full gift-card tender — balance lookup, drawdown, transaction ledger, balance restore on refund.
Tax	Basis-point rate, tax-inclusive/exclusive modes, per-country tax zones with priority.
Shipping	Server-side rate from shipping_method.calculator JSON. Method eligibility by subtotal range + country allow/block-list.
Confirmation email	Best-effort SMTP send post-checkout (non-blocking — a failed send doesn't roll back the order).
vs Shopify Checkout
Feature	Shopify	SellRight
Cart persistence	Server-side, 14-day TTL	✅ Server cart with TTL + extend-on-activity
Server-authoritative pricing	✅	✅
Stock reservation	At checkout (configurable)	✅ At checkout (transactional)
Discount stacking	Limited (Shopify Scripts for Plus)	Single-coupon v1 (exclusion groups)
Abandoned cart recovery	✅ Built-in email sequences	⚠️ Schema has cart.status = 'abandoned' + email + webhook event, but no email recovery flow
Subscription products	✅ Shopify Subscriptions app	✅ Built — Stripe Billing with license renewal
Gift cards	✅	✅
Shop Pay / accelerated checkout	✅ 1-click with saved details	❌ No Apple Pay, Google Pay, or accelerated checkout UI
Multi-currency	✅ Shopify Markets	⚠️ currency_rate table exists but checkout is single-currency
Edge Cases Handled
- ✅ Double-submit: idempotency key + unique constraint + txn rollback
- ✅ Out-of-stock during checkout: stock reservation fails atomically → 409 with blocked SKUs
- ✅ Shipping unavailable: ShippingUnavailableError → 409
- ✅ Coupon expiry between add-to-cart and checkout: server re-validates at checkout
- ✅ Variant deleted between add-to-cart and checkout: isNull(deletedAt) filter → unavailable
- ✅ Concurrent cart mutation: cart token + server-side reconciliation
Edge Cases NOT Handled
- ❌ Cart item quantity > available stock at add-time: Cart doesn't validate stock at add-time (only at checkout). Customer can add 100 units of a 5-stock item and discover the block only at checkout.
- ⚠️ Pre-order + in-stock mixed carts: Stock reservation loop skips pre-order items, but no test for a cart with both pre-order and in-stock items splitting correctly.
- ❌ Address validation: No address normalization or validation (USPS/Google Maps). normalizeAddress() maps keys but doesn't verify the address exists.
- ❌ Tax by postal code / state: Tax zones match on country only. No state/province or postal-code-level tax rules (critical for US merchants).
Verdict: 🟡 Core checkout is production-grade for digital goods.
The money path, idempotency, and stock allocation are rock-solid. The gaps are operational breadth (address validation, state-level tax, Shop Pay equivalent, abandoned cart email).
---
3. Order Management
Order State Machine
PendingPayment → Paid → PartiallyRefunded → Refunded
                 ↓           ↓
              Cancelled    Refunded
                 ↓
              (terminal)
The FSM is explicit in fsm.ts — canTransition(from, to) gates every state change. recomputeOrderRefundState() aggregates settled refund amounts and derives the correct state.
What's Built
Feature	Status
FSM with explicit transitions	✅ fsm.ts, tested
Refunds	✅ Partial + full, gateway-backed (Stripe), ledgered, order state recomputed
Returns (RMA)	✅ return_request + return_line — request/approve/reject/refund flow with restock
Fulfillment	✅ fulfillment + fulfillment_line — partial fulfillment supported. State: Pending → Shipped → Delivered.
Draft orders	✅ Admin can create draft orders
Soft-delete / trash	✅ deletedAt column, bulk trash/restore, gated purge
Bulk operations	✅ Bulk cancel, trash, restore, purge (with FK-coverage guard test)
Invoice/packing slip	✅ JSON + HTML rendering
Audit log	✅ State transitions logged with actor
Shipping notifications	✅ Email on fulfill
What's Missing vs Shopify/Vendure
Feature	Shopify	Vendure	SellRight
Order editing (post-payment line changes)	✅ Admin can add/remove lines	✅ modifyOrder()	❌ No order editing
Fulfillment service integrations	✅ ShipStation, etc.	Plugin-based	❌ Manual only
Tracking import	✅ Bulk CSV	Plugin	⚠️ Route exists but no carrier tracking URL resolution
Order tags/notes	✅ Internal + customer-visible	✅	❌ metadata JSONB exists but no notes API
Automatic fulfillment for digital	App needed	Plugin	✅ auto-deliver.ts job
Split shipments	✅ (with apps)	Plugin	⚠️ Schema supports multiple fulfillments, no UI
Dispute/chargeback management	✅ Built-in dashboard	❌	⚠️ Logged but no admin UI for responding
Verdict: 🟡 Solid for digital goods, thin for physical commerce.
The FSM, refund path, and RMA flow are well-built. Order editing and carrier integration are the biggest gaps.
---
4. Inventory Management
What's Built
Feature	Implementation
Stock tracking	stock table: on_hand, allocated per (variant, store). Available = on_hand - allocated.
Atomic reservation	UPDATE stock SET allocated = allocated + qty WHERE (on_hand - allocated) >= qty inside checkout txn.
Stock movements	stock_movement audit table with delta, reason, ref order.
Return restocking	On return approval with restock: true, on_hand incremented + movement recorded.
Stale allocation release	release-stale-allocations.ts job — cancels unpaid orders past TTL, releases reservation.
What's Missing
Feature	Shopify	Vendure	SellRight
Multi-warehouse/locations	✅ Locations	✅ StockLocation	⚠️ location table exists but stock is (variant, store) — no per-location stock
Backorder handling	✅ Configurable	✅ trackInventory: false	⚠️ Pre-order skips stock, but no general "allow negative stock"
Low-stock alerts	✅ Email notification	Plugin	❌ No low-stock alert job
Inventory counts/cycle counts	✅ (with apps)	Plugin	❌ Missing
Bundle/kit inventory	✅ (with apps)	Plugin	❌ No bundle composition
Verdict: 🟡 Adequate for single-warehouse digital sales.
Multi-warehouse is the biggest gap for physical-goods merchants. The pre-order mechanism is a creative workaround for digital goods with release dates.
---
5. Payment Architecture
What's Built
Feature	Implementation
Provider interface	Clean PaymentProvider with createPayment() + refundPayment().
Stripe provider	✅ Full — PaymentIntents, 3DS via Stripe.js, server-side verifyIntent(), dual test/live mode.
Manual/COD	✅ Two credential-free providers.
3DS	✅ Stripe.js client-side; server verifies intent status.
Saved cards	✅ payment_method table with gateway vault refs (never PAN).
Refunds	✅ Gateway-before-ledger invariant (provider runs BEFORE ledger write).
Partial refunds	✅ Arbitrary amounts up to refundable balance.
Store credit	✅ Gift cards with transaction ledger.
Stripe dashboard refund reconciliation	✅ Idempotent recording.
Chargeback handling	✅ recordStripeDispute() with audit trail.
Idempotency	✅ Order-level + payment claim level (processed_event).
What's Missing
Feature	Shopify	Vendure	SellRight
Multiple payment providers	100+ gateways	Stripe, Braintree, Mollie	❌ Only Stripe + manual/COD
PayPal	✅ Built-in	✅ Plugin	❌ Missing
Apple Pay / Google Pay	✅ Shop Pay	Plugin	❌ Stripe Payment Element supports these but no explicit UI wiring
Buy now, pay later	✅ Klarna, Afterpay	Plugin	❌ Sezzle dropped
Void/Cancel authorization	✅	✅	❌ Only settle + refund
Verdict: 🟡 Stripe integration is excellent, but single-provider.
For a software store selling to card-paying customers, this works. For any merchant needing PayPal, BNPL, or regional payment methods, it's a blocker.
---
6. Product/Catalog
What's Built
Feature	Implementation
Products + Variants	✅ product + product_variant with options (JSONB), SKU, pricing (base/sale/preorder), fulfillment type, license durations
Collections	✅ Manual + smart collections (rule-based)
Options	JSONB options on variant
Assets/images	✅ asset + product_asset + variant_asset with position ordering. Sharp image processing.
Search	✅ ILIKE + GIN trigram index
Static manifest	✅ generate.ts builds static JSON catalog
Slugs	✅ Unique per-store slugs for products, collections, blog posts
Soft-delete	✅ deletedAt on products and variants
Digital products	✅ fulfillment_type: physical, digital_download, license, update_pass
App licensing	✅ Full lifecycle — issue, activate, device-bound, seats, update eligibility
What's Missing
Feature	Shopify	Vendure	SellRight
Metafields / custom fields	✅ 200+ metafields	✅ Custom fields	❌ No user-defined product fields
Product bundles	✅ (with apps)	Plugin	❌ Missing
Sitemap generation	✅ Auto-generated	Plugin	❌ No sitemap.xml generator
Structured data (JSON-LD)	✅ Built-in	Plugin	❌ No structured data output
Product reviews	✅ (with apps)	Plugin	❌ Missing entirely
Faceted search	✅ Built-in	Elasticsearch plugin	❌ Basic text search only
Weight/dimensions	✅ For shipping calc	✅	❌ No weight/dimension columns
Verdict: 🟡 Strong for digital/software catalogs, thin for physical retail.
The license/digital-fulfillment system is genuinely better than all three competitors. Large physical catalogs need metafields, faceted search, and structured data.
---
7. Customer Management
What's Built
Feature	Implementation
Guest checkout	✅ Email on checkout, no account required
Account management	✅ Register, login, profile, password
OAuth	✅ Google Sign-In
Email verification	✅ Token-based with expiry + one-time use
Password reset	✅ Hashed token, timing-safe compare
Address book	✅ Default shipping/billing flags
Order history	✅ Customer-scoped reads
Customer tags	✅ Text array
SheerID verification	✅ Eligibility-gated discounts
What's Missing
Feature	Shopify	Vendure	SellRight
Customer groups / segments	✅ Built-in	✅ Customer groups	❌ Tags only
Customer notes	✅ Internal notes	✅	❌ Missing
Wishlist	✅ (with apps)	Plugin	❌ Missing
Account deletion (GDPR)	✅	✅	⚠️ Soft-delete only; no hard-delete cascade
Verdict: 🟢 Good for the target use case.
Guest checkout, account, addresses, and order history are all built. Missing operational CRM features (segments, notes, timeline).
---
8. Shipping
What's Built
Feature	Implementation
Flat-rate	✅ flat in calculator JSONB
Free shipping threshold	✅ min + flat: 0
Country zones	✅ Allow-list or block-list by ISO country code
Subtotal-based eligibility	✅ min/max bounds
Free shipping promo	✅ promotion.type = 'free_shipping'
What's Missing (Critical for Physical Commerce)
Feature	Shopify	Vendure	SellRight
Weight-based rates	✅	✅	❌ No weight on variants
Real-time carrier rates	✅ UPS/FedEx/USPS/DHL	Plugin	❌ Not built
Shipping labels	✅ Shopify Shipping	Plugin	❌ Not built
Local pickup	✅	Plugin	❌ Not built
State/province/zip zones	✅	✅	❌ Country-level only
Delivery estimates	✅	Plugin	❌ Not built
Verdict: 🔴 The weakest subsystem.
For digital goods this is fine (no shipping needed). For any physical-goods merchant, this is a migration blocker. Flat-rate + country zones is 2005-era functionality.
---
9. Webhooks/Integrations
What's Built
Feature	Implementation
Outbound webhooks	✅ Transactional outbox, HMAC signature, exponential backoff (30s → 6h), 6 max attempts
Topic subscription	✅ Endpoint with topic array + wildcard
Inbound Stripe webhooks	✅ Signature-verified, idempotent, dual-mode
Retry logic	✅ FOR UPDATE SKIP LOCKED, exponential backoff, processing state for crash recovery
Reaper	✅ Resets stuck processing rows
Batch delivery	✅ Configurable limit (50–500)
What's Missing
Feature	Shopify	Vendure	SellRight
Dead letter / manual retry	✅ Retry button in admin	✅	❌ Failed webhooks stay failed
App marketplace / plugin system	✅ 8000+ apps	✅ Plugin architecture	❌ No plugin/extension system
REST API client libraries	✅ Official SDKs	✅ TypeScript SDK	❌ OpenAPI spec but no generated SDKs
Zapier / Make integration	✅ Native	❌	❌ Not built
Verdict: 🟡 Webhook core is well-built.
The transactional outbox + HMAC + backoff is correct. The gap is the ecosystem layer — no plugin system, no marketplace. This is where Shopify's moat really lives.
---
10. Migration Readiness — What's Missing vs Vendure
Migration Blockers (Hard)
#	Blocker	Impact
1	GraphQL → REST API break	Any Vendure storefront using GraphQL queries needs a full rewrite. Same surface, different shapes.
2	No plugin system	Vendure plugins with custom entities, resolvers, or providers have no home in SellRight.
3	No multi-language (i18n)	Schema has no locale columns. Product names/descriptions/options are single-language.
4	In-process job scheduler	setInterval in the API process. Crash = lost jobs. Multi-instance = duplicate execution.
Migration Blockers (Soft — Workable with Effort)
#	Gap	Effort
5	No Redis / cache layer	Rate limiter is in-process Map. No HTTP response cache.
6	No Elasticsearch / Algolia	Fine for <5K products; painful above that.
7	Single payment provider	Stripe only. Mollie/Braintree/Adyen merchants need new implementations.
8	No faceted search	Browse-heavy stores need collection filters.
9	No customer group pricing	B2B merchants need segment-based pricing.
---
Summary Scorecard
Domain	vs Shopify	vs WooCommerce	vs Vendure	Grade
Multi-tenancy	🟢 Better	🟢 Much better	🟢 Better	A
Checkout flow	🟡 Narrower	🟢 Comparable	🟢 Comparable	B+
Order management	🟡 Narrower	🟢 Comparable	🟡 Narrower	B
Inventory	🔴 Much narrower	🟡 Narrower	🟡 Narrower	C+
Payments	🔴 Single-provider	🟡 Fewer gateways	🟡 Fewer gateways	C+
Product/Catalog	🟡 Narrower	🟢 Comparable	🟡 Narrower	B-
Customer mgmt	🟡 Narrower	🟢 Comparable	🟢 Comparable	B
Shipping	🔴 Much narrower	🔴 Narrower	🔴 Narrower	D
Webhooks/Ecosystem	🔴 No ecosystem	🟡 Fewer plugins	🟡 Fewer plugins	C
Security posture	🟢 Comparable	🟢 Better	🟢 Better	A
Digital/software sales	🟢 Better	🟢 Much better	🟢 Better	A+
Scale infrastructure	🔴 Single-instance	🟡 Comparable	🟡 Narrower	C-
---
## The Bottom Line
**For RightApps (multi-tenant digital software sales):** SellRight is **already better than all three competitors**. The RLS tenancy model, license lifecycle, subscription billing, and server-authoritative money path are genuinely world-class. The "missing" features (carrier shipping, POS, multi-warehouse) don't apply to digital goods.
**For a general merchant migrating from Shopify:** SellRight is **not ready**. Shipping, payment breadth, the app ecosystem, and scale infrastructure are all significant gaps. Shopify's moat is not the engine — it's the 8,000+ apps, the carrier integrations, Shop Pay, and the hosted infrastructure.
**For a Vendure migration specifically:** The blocking gaps are (1) GraphQL→REST break, (2) no plugin/extension system, (3) no multi-language, and (4) no Elasticsearch. If the storefront is being rewritten anyway and the catalog is <5K products in a single language, SellRight is a credible upgrade — particularly for the multi-tenancy and security posture improvements.
---
The Three Highest-Leverage Investments
#	Investment	Impact	Effort
1	Redis + BullMQ	Unlocks horizontal scaling, distributed job locks, response caching. Single change, massive infra impact.	1–2 weeks
2	PayPal provider	The PaymentProvider interface is clean; adding PayPal doubles the addressable merchant base.	2–3 days
3	State/province tax zones	Add provinces column to tax_zone and a state-level matcher. Unblocks every US merchant.	1 day# SellRight Production Readiness Audit
## Executive Summary
SellRight is a well-architected, single-operator ecommerce backend with strong security fundamentals (RLS, CSRF, env validation, SSRF protection). It is production-ready for its current scale (single instance, single box). The main gaps are in **observability**, **graceful shutdown**, and **horizontal scaling readiness** — areas that become critical as traffic or team size grows.
---
1. Error Handling — 🟡 Solid basics, needs classification
Aspect	Status	Detail
Global error handler	✅	app.onError in app.ts:94 catches unhandled errors, hides internals in production
Admin route errors	✅	guard() wrapper in admin-helpers.ts:70 catches HttpError and maps to HTTP status
Domain error types	🟡	HttpError, StockReservationError, ShippingUnavailableError — but no base AppError class or error code taxonomy
Checkout error handling	✅	Idempotency replay on 23505 (duplicate key), stock/shipping/cart errors all mapped to 409
Email failure isolation	✅	Order confirmation email wrapped in try/catch (checkout.ts:381) — never rolls back the order
Job error handling	✅	Scheduler every() catches per-tick so a thrown job doesn't kill the loop
Findings:
- app.onError leaks error messages in non-production (app.ts:97): expose = NODE_ENV !== 'production' — a staging environment would expose internal errors to users. The guard should be NODE_ENV === 'production' → hide, everything else → hide too (or an explicit DEBUG_ERRORS flag).
- No error classification/codes: Errors return { error: string } with freeform text. API consumers (storefront, admin panel) must string-match error messages. Structured error codes (ERR_STOCK_UNAVAILABLE, ERR_COUPON_EXPIRED) would enable proper i18n and programmatic handling.
- Unhandled promise rejections: No process.on('unhandledRejection') handler. An unhandled rejection in the setInterval scheduler or webhook delivery could crash Node 24 with default --unhandled-rejections=throw.
- No 404 handler: Hono returns a default 404 for unmatched routes. No custom not-found handler means no consistent error shape, no request logging for reconnaissance scanning detection.
---
2. Logging — 🔴 Console-only, no structure
Aspect	Status	Detail
Structured logging	🔴	All logging is console.log/console.error with freeform [label] prefixes
Log levels	🔴	No level system — everything is stdout/stderr. Can't filter debug vs info vs warn
Sensitive data in logs	🟡	console.error('[api error]', err) dumps the full error stack including potentially internal paths
Request logging	🔴	No request-level logging middleware (method, path, status, duration, request ID)
Correlation IDs	🔴	No request ID / correlation ID / trace ID in any log line
Log aggregation readiness	🔴	JSON output would be trivially parseable but current format is inconsistent freeform text
Findings:
- Every log line is console.log(m) with freeform strings: [jobs] scheduler on — auto-deliver(apply=...), [auto-deliver] mode=APPLY, [webhooks] <store-id>: N attempted. There's no structured schema (timestamp, level, service, store_id, trace_id).
- No structured logger: No pino, winston, or custom structured logger. For a production system handling payments, this is the single biggest operational gap. You can't answer "how many checkouts failed last hour?" or "what's the p99 latency for /checkout?" from logs.
- Email failures only console.error (checkout.ts:381): A failed order confirmation email is logged but never surfaces in any dashboard or alert.
- Job scheduler logging (scheduler.ts:28): const log = (m: string) => console.log(m) — no timestamp, no structured fields, no level differentiation.
- No audit trail in logs: Audit events are written to the audit_log DB table (good) but not mirrored to structured logs for SIEM ingestion.
Recommendation: Adopt pino with a middleware that adds requestId, method, path, status, duration_ms to every request. Add storeId as a structured field in all store-scoped operations.
---
3. Monitoring — 🟡 Health check exists, metrics absent
Aspect	Status	Detail
Liveness probe	✅	GET /v1/health returns { status: 'ok', version: '0.0.0' }
Readiness probe	🔴	No readiness endpoint that checks DB connectivity, pool exhaustion, or dependency health
Metrics endpoint	🔴	No Prometheus /metrics endpoint, no counters for requests/errors/orders
Alerting hooks	🟡	Audit log rows for payment events; Stripe's dashboard is the webhook alerting surface
Error tracking	🔴	No Sentry, Rollbar, or equivalent integration
Findings:
- Health endpoint returns hardcoded version: '0.0.0' (app.ts:92): The version never changes. It should read from package.json or a build-time injected value so operators can confirm which version is running.
- No readiness probe: The health check doesn't verify that the database is reachable, the connection pool is healthy, or the job scheduler is running. A pod that has lost its DB connection would still report ok.
- No request metrics: No request count, error rate, or latency histogram. The systemd unit (sellright-api.service) has MemoryMax=512M and Restart=on-failure, which is good OS-level monitoring, but application-level metrics are absent.
- Audit log as monitoring surface: Payment webhooks write auditLog rows (noted in architecture docs), and Stripe's dashboard catches webhook failures. This is pragmatic for a single-operator setup but doesn't scale to an on-call rotation.
- No SLI/SLO definitions: No documented targets for availability, checkout success rate, or API latency.
---
4. Deployment — 🟡 Working manual deploy, no CI/CD pipeline
Aspect	Status	Detail
CI pipeline	✅	GitHub Actions verify.yml: build, typecheck, test, migrate, deps audit, deps check — on push/PR
CD pipeline	🔴	No automated deployment. Manual git pull --ff-only + pkill + restart on the server
Migration strategy	✅	Drizzle-Kit migrations with numbered SQL files (0000–0036), run as OWNER role, app runs as non-owner
Rollback capability	🟡	Migrations are forward-only. Some have -- DOWN blocks in comments but no automated rollback
Blue-green/canary	🔴	Single instance, kill-and-restart. Brief downtime on every deploy
Smoke tests	✅	deploy-admin.sh and restart-and-test.sh run post-deploy health + login + order + stock checks
Findings:
- CI is strong: verify.yml runs Postgres 16 in a service container, migrates, runs the full pnpm verify (build + typecheck + tests + RLS assertions + hand-written migration guards + shop isolation checks). Actions are pinned to commit SHAs (supply-chain safe). This is better than most small projects.
- CD is manual: Deploy scripts (deploy-admin.sh, migrate-and-cutover.sh) run on the box via SSH. They git pull --ff-only, migrate, kill the old process, start the new one, and smoke-test. The kill-and-restart pattern (pkill -f 'src/index.ts' → sleep 2 → fuser -k 3300/tcp) creates a 3–7 second downtime window on every deploy.
- No staging environment: Dev is on the laptop (:3300 with sellright_dev), production is on Hetzner. There's no staging environment that mirrors production for pre-deploy validation.
- Process management: The systemd unit (sellright-api.service) is well-configured with Restart=on-failure, RestartSec=5, MemoryMax=512M, TimeoutStartSec=20, and filesystem sandboxing (ReadWritePaths). However, it still runs tsx (dev-mode transpiler) in production instead of the compiled dist/index.js output.
- No containerization: No Dockerfile, no container orchestration. The deploy model is bare-metal/single-VM which is fine for current scale but limits horizontal scaling.
- Backup strategy is solid: backup-db.sh does nightly pg_dump -Fc, 14-day local retention, optional rclone offsite copy. Restore drill documented.
---
5. Configuration — 🟢 Excellent
Aspect	Status	Detail
Env validation	✅	Zod schema in env.ts validates ALL env vars at boot with typed coercion
Fail-fast boot	✅	Server refuses to start on missing/invalid config
Safe defaults	✅	Dev DB port :5433 (never :5432 prod), jobs disabled by default, SMTP no-ops when unconfigured
Feature flags	✅	JOBS_ENABLED, JOBS_AUTO_DELIVER_APPLY, JOBS_RELEASE_STALE_APPLY — safe-by-default toggles
Secret management	🟡	.env file on disk, gitignored. No vault/KMS integration
Findings:
- Best-in-class env validation: 117 lines of Zod schema covering ~50 env vars with defaults, coercion, email validation, enum restrictions, and cross-field transforms (Gmail alias normalization). This is production-grade.
- Dry-run by default: All destructive jobs (auto-deliver, release-stale, webhook-reaper) default to dry-run logging. Apply requires explicit =1 flags. Excellent safety posture.
- TRUNCATE guard: Import scripts require BOTH --force argv AND ALLOW_FORCE_TRUNCATE=1 env to permit mass deletion. Double-gated, documented with ⚠ DANGER.
- Port-based fail-safe: Default DATABASE_URL points to :5433 (dev cluster), never :5432 (prod). An accidental boot without DATABASE_URL set cannot reach production data.
- Minor gap — STOREFRONT_URL default (env.ts:52): Defaults to https://store.example.com. If forgotten in production, email links (password reset, order confirmation) would point to example.com. The Zod schema should require this in production mode.
- Secure cookie gated on NODE_ENV === 'production' (cookies.ts:42): If someone deploys with NODE_ENV=staging, cookies won't have the Secure flag. This is a documented footgun.
---
6. Database Operations — 🟢 Strong
Aspect	Status	Detail
Migration tooling	✅	Drizzle-Kit with 37 numbered SQL migrations (0000–0036)
RLS enforcement	✅	FORCE RLS on all store-scoped tables, asserted by assert-force-rls.ts in CI
Tenant isolation	✅	withStore() sets app.current_store GUC per-transaction, RLS policies enforce isolation
Connection pooling	✅	pg.Pool with configurable PGPOOL_MAX, PGPOOL_IDLE_TIMEOUT_MS, PGPOOL_CONNECTION_TIMEOUT_MS
Transaction safety	✅	Proper BEGIN/COMMIT/ROLLBACK with finally { client.release() }
Non-owner role	✅	App runs as NOSUPERUSER NOBYPASSRLS role; migrations run as owner
Migration guards	✅	assert-hand-written-migrations.ts prevents silent regeneration of hand-written SQL
Findings:
- RLS is production-grade: 40+ tables with FORCE RLS, tenant isolation policies, a dedicated RLS test suite (rls.test.ts, rls-tables.test.ts), and a CI assertion that fails the build if any store-scoped table is missing FORCE RLS. This is ahead of most SaaS products.
- withStore() is the single entry point for all store-scoped work. An ESLint rule (no-restricted-imports) blocks route handlers from importing unsafeUnscopedDb. This is defense-in-depth.
- Connection pool is configurable via env (PGPOOL_MAX=10 default). connectionTimeoutMillis: 0 means wait forever — under load this could cause request queuing rather than fast-failing. A non-zero timeout with proper error handling would be more resilient.
- No connection pool health monitoring: No pool.on('error') handler. If a connection dies, the pool may hand out a dead connection without logging.
- No migration transaction wrapping: Drizzle-Kit runs each migration file individually. A migration with multiple statements that fails mid-way leaves the schema in a partial state. Postgres DDL is transactional, but the migration runner doesn't wrap the entire file in a BEGIN/COMMIT.
- Soft delete for orders (0033_order_soft_delete.sql): Good — prevents accidental data loss.
- Idempotency index on checkout (0007_order_idempotency_and_indexes.sql): Unique (store, idempotency_key) prevents duplicate orders on double-submit. The checkout handler catches 23505 and replays the winner's order.
---
7. Resilience — 🟡 Partial
Aspect	Status	Detail
Webhook retries	✅	Exponential backoff [30s, 2m, 10m, 1h, 6h], max 6 attempts, transactional outbox
Webhook reaper	✅	Recovers stuck processing rows after process crash (5-min interval, 10-min grace)
Job overlap prevention	✅	running flag in every() skips if previous pass hasn't finished
Outbound SSRF protection	✅	safeOutboundFetch with DNS rebinding protection, private IP blocking, pinned lookup
Webhook delivery timeout	✅	AbortSignal.timeout(10_000) on outbound webhook HTTP calls
Rate limiting	🟡	In-memory sliding window for login (8 failures/15 min). Per-process — resets on restart
Circuit breakers	🔴	None for Stripe, SMTP, or any external dependency
Retry with backoff	🟡	Only for webhooks. No retry on Stripe API calls, SMTP sends, or DNS lookups
Graceful shutdown	🔴	No SIGTERM/SIGINT handler. Process just dies
Findings:
- No graceful shutdown: The API has no signal handler. On SIGTERM (systemd stop, deploy kill), in-flight requests are aborted, the pg pool connections are not cleanly released, and any mid-execution job tick is interrupted. The systemd RestartSec=5 papers over this, but it can leave webhook deliveries in processing state (the reaper recovers them, but with a 10-minute delay).
- No circuit breaker for Stripe: If Stripe is down, createPaymentIntent will hang/throw on every checkout attempt with no fallback or degraded mode. Users see a raw 500 from app.onError.
- Rate limiter is in-process memory (rate-limit.ts:12): The Map<string, Entry> resets on every process restart. A deploy or crash clears all rate-limit state. This is acknowledged in the code comment ("move the store to Redis when running multiple API instances"). The opportunistic cleanup at 5000 entries is a good anti-memory-leak measure.
- SMTP failures are fire-and-forget: sendOrderConfirmation is wrapped in try/catch but there's no retry queue. A transient SMTP outage means lost order confirmation emails with no recovery path.
- PGPOOL_CONNECTION_TIMEOUT_MS defaults to 0 (infinite wait): Under connection pool exhaustion, requests queue indefinitely rather than failing fast with a 503. A 5–10 second timeout would prevent cascading slowdowns.
---
8. Testing — 🟡 Good unit/integration, no E2E
Aspect	Status	Detail
Unit tests	✅	32 test files covering: FSM, totals, coupons, tax, gift cards, stock reservations, email, crypto tokens, TOTP, invoices, currency, webhooks, Stripe, entitlements
Integration tests	✅	RLS tests (rls.test.ts, rls-tables.test.ts), checkout-migration, subscriptions, admin-orders bulk, activations — all against real Postgres
Test DB isolation	✅	Tests use the same DB with fileParallelism: false and beforeEach wipe functions
E2E tests	🔴	None. No Playwright/Cypress for the admin panel or storefront
Property-based tests	✅	totals-property.test.ts — 500 random trials for order calculation invariants
Test coverage	🟡	No coverage threshold enforced. No --coverage in CI
Findings:
- 32 test files is strong for this scope: Business logic (totals, FSM, coupons, tax, stock, gift cards, auto-discounts) is well-covered. The RLS test suite is exceptional — it verifies tenant isolation with a non-owner role, cross-store leakage probes, and policy coverage for every table.
- Test split is pragmatic: Fast tests (pnpm test) exclude DB-heavy files; pnpm test:db runs the integration suite separately. This keeps the dev loop fast.
- Real Postgres in CI: The GitHub Actions workflow provisions Postgres 16, migrates, and runs the full suite against it. No SQLite mocks.
- No test coverage reporting: vitest supports --coverage via @vitest/coverage-v8 but it's not configured. There's no way to know if coverage is improving or regressing.
- No E2E tests: The admin panel (React/Vite) and storefront (Qwik) have no browser-level tests. The admin package has qa:browser (Playwright a11y audit) but no functional E2E suite.
- Stripe is mocked in checkout-migration and subscription tests — appropriate for unit testing but means the real Stripe integration is only verified by manual test-mode purchases (documented as "the irreducible human gate").
---
9. Build Pipeline — 🟢 Strong
Aspect	Status	Detail
TypeScript strictness	✅	strict: true, noUncheckedIndexedAccess: true, noImplicitOverride: true
Dead code detection	✅	knip configured with audit:dead-code script
ESLint rules	✅	no-restricted-imports blocks unsafeUnscopedDb in routes
Type-checking in CI	✅	pnpm -r typecheck runs in verify pipeline
Build output	✅	tsc -p tsconfig.json produces dist/ with source maps
Supply chain	✅	Actions pinned to commit SHAs, --frozen-lockfile, deps:audit + deps:check
Duplication detection	✅	jscpd configured via audit:duplication script
Findings:
- TypeScript config is strict: noUncheckedIndexedAccess is the standout — it forces ! or null-checks on every array/object index access, eliminating an entire class of runtime undefined errors. This is rarer than it should be.
- verify is comprehensive: build → typecheck → admin typecheck → admin build → test → assert-rls → assert-hand-written → assert-shop-isolation. Seven gates in one command. This is an excellent pre-merge check.
- Runs tsx in production: The systemd unit starts pnpm exec tsx src/index.ts instead of node dist/index.js. This means the transpiler runs on every boot (slower startup, higher memory) and TypeScript errors that tsc would catch are silently transpiled. The build step exists but isn't used in the deploy path.
- Missing ESLint rules: The config is minimal — only the no-restricted-imports rule for RLS safety. No @typescript-eslint recommended rules, no no-console (for production code), no no-floating-promises, no @typescript-eslint/no-unused-vars. The packages/admin and packages/storefront are entirely excluded from linting.
- No packageManager enforcement gap: packageManager: "pnpm@11.9.0" in root package.json but the CI workflow uses corepack prepare pnpm@10.34.1 — a version mismatch between CI and local. This could cause lockfile drift.
---
10. Scalability — 🟡 Single-instance by design, not yet ready for horizontal
Aspect	Status	Detail
Stateless API	🟡	Sessions in DB (good), rate limiter in-memory (bad for multi-instance)
Session storage	✅	DB-backed sessions (session table), not in-memory
Job scheduler	🟡	In-process setInterval — would double-fire on multiple instances
Connection pool	✅	Configurable PGPOOL_MAX, standard pg.Pool
Caching	🔴	No application-level cache (Redis, in-memory LRU). Every catalog read hits Postgres
Pagination	🟡	OFFSET-based everywhere. Hard-capped at 200 results. No cursor/keyset pagination
Horizontal scaling	🔴	Rate limiter, job scheduler, and webhook delivery are all per-process
Findings:
- Rate limiter is the scaling blocker: The Map<string, Entry> in rate-limit.ts is per-process. Two instances would each have their own counter, effectively doubling the rate limit. The code acknowledges this ("move the store to Redis when running multiple API instances").
- Job scheduler double-fires: startJobScheduler() runs on every index.ts boot. Two instances would both try to run auto-deliver, release-stale, cart-maintenance, and webhook delivery simultaneously. The FOR UPDATE SKIP LOCKED on webhook delivery prevents double-delivery, but the other jobs have no such guard.
- No caching layer: Every product listing, stock check, and cart read goes to Postgres. For a single-instance serving moderate traffic, this is fine (Postgres is fast with proper indexes). But under load, adding a Redis or in-process LRU for catalog reads would be the first performance win.
- OFFSET pagination degrades: At page 100 of a 10,000-row order list, the database skips 9,900 rows before returning 100. This is acknowledged in the gap analysis ("degrades at high page counts"). Cursor-based pagination on created_at or id would fix it.
- sharp for image processing: Image resizing happens in the API process (sharp dependency). Under heavy upload load, this would CPU-starve the request handler. A separate image processing queue would be needed at scale.
- Storefront is SSR (Qwik): The Qwik storefront renders server-side with resumability, which is inherently more scalable than traditional SSR frameworks. The static catalog generation (manifest/generate.ts) pre-builds JSON files for fast browsing.
---
Priority Action Items
Priority	Area	Action	Impact
P0	Logging	Add structured JSON logger (pino) with request middleware	Enables every debugging and alerting scenario
P0	Resilience	Add SIGTERM handler: stop accepting, drain in-flight, close pool	Prevents data corruption on deploy/restart
P1	Monitoring	Add readiness probe checking DB pool health	Prevents routing traffic to a dead instance
P1	Error Handling	Add process.on('unhandledRejection') handler	Prevents silent crashes in Node 24
P1	Build	Switch production from tsx to compiled node dist/index.js	Faster startup, lower memory, catches type errors
P1	Deployment	Fix pnpm version mismatch (CI: 10.34.1, local: 11.9.0)	Prevents lockfile drift
P2	Resilience	Add Stripe circuit breaker (e.g., opossum)	Graceful degradation during Stripe outages
P2	Monitoring	Add /v1/metrics with request/error/order counters	Enables alerting and dashboards
P2	Config	Require STOREFRONT_URL to be set explicitly in production	Prevents broken email links
P2	Build	Add ESLint @typescript-eslint/recommended rules	Catches more code smells
P3	Testing	Add coverage reporting with @vitest/coverage-v8	Visibility into test gaps
P3	Scalability	Move rate limiter to Redis (when multi-instance)	Required before horizontal scaling
P3	Scalability	Add distributed lock for job scheduler	Required before horizontal scaling
---
Scorecard
Area	Score	Notes
Error Handling	🟡 7/10	Good domain errors, needs classification and 404 handler
Logging	🔴 3/10	Console-only, no structure, no correlation IDs
Monitoring	🟡 5/10	Health check exists but no metrics, alerting, or error tracking
Deployment	🟡 6/10	Strong CI, manual CD, good backups, no staging
Configuration	🟢 9/10	Best-in-class env validation with safe defaults
Database Operations	🟢 9/10	RLS, non-owner role, migration guards, idempotency
Resilience	🟡 6/10	Good webhook retry, no graceful shutdown or circuit breakers
Testing	🟡 7/10	Strong unit+integration, no E2E or coverage tracking
Build Pipeline	🟢 8/10	Strict TS, supply chain safety, but runs tsx in prod
Scalability	🟡 5/10	Single-instance by design; known blockers for horizontal scale
Overall	🟡 6.5/10	Production-ready for single-operator; needs observability for team scale# SellRight Frontend — Production Readiness Audit
## Table of Contents
1. [Storefront Architecture (Qwik)](#1-storefront-architecture)
2. [Admin Architecture (React)](#2-admin-architecture)
3. [SEO](#3-seo)
4. [Accessibility](#4-accessibility)
5. [Internationalization](#5-internationalization)
6. [Form Handling](#6-form-handling)
7. [State Management](#7-state-management)
8. [Security (Frontend)](#8-security-frontend)
9. [Mobile Experience](#9-mobile-experience)
10. [Checkout UX](#10-checkout-ux)
---
1. Storefront Architecture
Qwik SSR Setup — ✅ Solid
Aspect	Status	Notes
SSR entry	✅	entry.ssr.tsx — renderToStream with nonce pass-through
Express adapter	✅	entry.express.tsx — proper static asset caching, security headers
Service worker	✅	Registered via ServiceWorkerRegister in root
Build pipeline	✅	Terser compression, Brotli + gzip, vite-imagetools for WebP/AVIF
Hydration Strategy — ✅ Good
- Qwik's resumability model means no traditional hydration — JS loads lazily per-component interaction
- Stripe Payment Element correctly uses useVisibleTask$ (client-only, never SSR)
- useOnDocument('qinit', ...) for cart/address boot — runs after DOM is ready
- Product stock is intentionally excluded from SSR — set to '0' in manifest, populated client-side via refreshLiveStock on qidle/focus/visibility
Component Architecture — ⚠️ Needs Refactoring
Finding	Severity
Massive checkout page component — checkout/index.tsx is ~390 lines with 15+ signals, multiple inline $() handlers, and tightly coupled payment logic	🔴 High
View/logic separation done well — CheckoutPageView, CheckoutPaymentPanel, CheckoutAddressesView split rendering from state	✅
any types in component props — CheckoutPageView declares checkoutState: any, checkoutValidation: any, localCart: any	🟡 Medium
Product page monolith — ProductContent.tsx is ~390 lines with gallery, variant selection, cart, touch handling all in one component	🔴 High
Routing — ✅ Good
- Qwik Router file-based routing with proper catch-all 404 handler
- Legacy redirect handling in [...catchall]/index.tsx with 301 redirects
- Static generation support via onStaticGenerate for product pages
- Route loaders (routeLoader$) for SSR data fetching
Findings:
Finding	Severity
Catch-all swallows non-legacy 404s — status(404) skipped for /order-status prefix but useLegacyRedirects runs unconditionally, creating a race if the redirect fails	🟡 Medium
Slug validation is good — regex ^[a-z0-9][a-z0-9\-_]*$ prevents path traversal	✅
---
2. Admin Architecture
React SPA Setup — ✅ Clean
Aspect	Status	Notes
Entry point	✅	main.tsx — StrictMode, QueryClientProvider, AuthProvider, BrowserRouter, ToastProvider
Routing	✅	React Router v6 with nested protected routes via <Outlet />
Build target	✅	ES2022 — modern, no legacy polyfill burden
Dev proxy	✅	/v1 → API, /assets → image server
State Management — ✅ Pragmatic
- TanStack Query (React Query v5) for server state — staleTime: 15s, retry: 1, refetchOnWindowFocus: false
- React Context for auth state (AuthProvider) and toast notifications (ToastProvider)
- Local component state via useState — no Redux/Zustand overhead
- Store slug persisted in localStorage (sr_admin_store)
- QA mock system gated by VITE_QA_MOCK flag — only mocks GET requests, mutations pass through
API Integration — ✅ Strong
Finding	Severity
CSRF double-submit — reads sr_csrf cookie, echoes in x-csrf-token header for mutations	✅
httpOnly session cookie — credentials: 'include', JS can't read session token	✅
Auto-redirect on 401 — redirects to /login on unauthorized (except from login page itself)	✅
ApiError class with status code — structured error handling	✅
JSON.parse without guard — JSON.parse(text) on line 43 could throw on malformed responses	🟡 Medium
Error Boundaries — 🔴 Missing in Admin
Finding
No React Error Boundary anywhere in the admin app
Individual pages handle their own error from useQuery, but unhandled render errors crash the entire app
onClick uses location.assign on dashboard table rows instead of React Router navigation — bypasses SPA routing, causes full page reload
Admin UI Component Library — ✅ Well-Designed
- ui.tsx — Spinner, Loading, PageHeader, Badge/StatusBadge, InlineAlert, ErrorState, EmptyState, DropdownMenu
- ui-forms.tsx — KpiCard, FormSection, Field, Pagination
- Semantic color tokens: success, warning, danger, info with soft/background variants
- Theme support via ThemeMenu component
Command Palette — ✅ Excellent
- Ctrl+K / Cmd+K global shortcut
- Three-tier results: local commands, remote search (debounced 200ms), recent commands
- Full keyboard navigation (ArrowUp/Down, Enter, Escape)
- Focus restoration on close
- Ignores when focus is in input/textarea (unless Ctrl held)
---
3. SEO
Meta Tags — ✅ Comprehensive
Aspect	Status	File
Title template	✅ "${title} | Damned Designs"	utils/seo.ts:66
Description	✅ Per-page	utils/seo.ts:68
Open Graph	✅ type, title, description, site_name, url, image (1200×630)	utils/seo.ts:69-76
Twitter Cards	✅ summary_large_image	utils/seo.ts:77-80
AI bot directives	✅ noai, noimageai on all pages	utils/seo.ts:88
Canonical URLs	✅ Per-page, fallback to damneddesigns.com${pathname}	head.tsx:137-140
Article meta	✅ published_time, modified_time, section, author, tags	utils/seo.ts:81-85
Structured Data (JSON-LD) — ✅ Well-Implemented
Schema Type	Status	File
Product	✅ With price, availability, images, shipping details, return policy	services/seo-schemas.ts:21-122
BreadcrumbList	✅	services/seo-schemas.ts:8-19
Organization	✅ With address, social links, contact	services/seo-schemas.ts:124-153
WebSite + SearchAction	✅	services/seo-schemas.ts:155-167
Schema validation	✅ validateJsonLdSchema() checks @context, @type	utils/schema-injection.ts:29-53
XSS prevention	✅ JSON escaped for <script> injection	utils/schema-injection.ts:8-23
Sitemaps — ✅ Multi-Sitemap Architecture
Sitemap	Type	File
sitemap.xml	Index (proxies backend)	routes/sitemap.xml/index.ts
sitemap-main.xml	Static pages	routes/sitemap-main.xml/
sitemap-products.xml	Products	routes/sitemap-products.xml/index.ts
sitemap-collections.xml	Collections	routes/sitemap-collections.xml/
sitemap-blog.xml	Blog posts	routes/sitemap-blog.xml/
Findings:
Finding	Severity	File
Sitemap proxy uses hardcoded localhost:3100 — will break if backend port changes	🟡 Medium	routes/sitemap.xml/index.ts:10
Error sitemap leaks error message — ${error.message} in XML response	🟡 Medium	routes/sitemap-products.xml/index.ts:36
Robots.txt proxy also hardcoded localhost:3100	🟡 Medium	routes/robots.txt/index.ts:5
Robots.txt — ✅ Good
- Fallback blocks /admin/, /checkout/, /account/, /api/
- Allows GPTBot, ClaudeBot, PerplexityBot (progressive AI access)
- Blocks AhrefsBot, MJ12bot, SemrushBot, DotBot, MauiBot
- Bingbot crawl-delay: 2
- Sitemap reference included
Missing SEO Items
Finding	Severity
No hreflang tags — only English, no multi-language support	🟡 Medium
lang hardcoded to en-us in SSR entry, lang="en" on body	🟡 Medium
---
4. Accessibility
✅ Strengths
Feature	Implementation	File
Skip-to-content link	✅ href="#main-content" with sr-only class	root.tsx:18-23
Screen reader cart announcement	✅ aria-live="polite" div with sr-only text on add-to-cart	ProductContent.tsx:303-307
Admin toast role="alert"	✅ Error toasts use assertive role, success/info use polite	components/Toast.tsx:161
Admin loading role="status"	✅	components/ui.tsx:17
Admin search aria-label	✅ "Search orders, products, and customers"	components/Layout.tsx:70
Admin mobile drawer	✅ role="dialog", aria-modal="true", aria-label="Navigation"	components/Layout.tsx:233
Admin command palette	✅ Full keyboard support, focus trap, Escape to close	components/CommandPalette.tsx
QA axe-core integration	✅ window.__runA11yAudit() in QA mode	qa-a11y.ts
🔴 Issues Found
Finding	Severity	File
No #main-content target — skip link points to #main-content but no element has id="main-content" in any route	🔴 Critical	root.tsx:19
Breadcrumbs missing aria-label — <nav> has no label for screen readers	🟡 Medium	components/breadcrumbs/Breadcrumbs.tsx:6
Checkout inputs lack <label> elements — all inputs use placeholder as the only label (email, phone, first/last name). placeholder disappears on input, leaving no visible label	🔴 Critical	components/checkout/CheckoutAddressesView.tsx:77-100
No aria-describedby linking inputs to validation errors — validation error messages are rendered as sibling divs but not programmatically associated	🔴 Critical	CheckoutAddressesView.tsx, AddressForm.tsx
autocomplete attributes correct ✅	✅	AddressForm.tsx uses autoComplete="email", autoComplete="tel", autoComplete="postal-code", etc.
Checkout step indicators use inline styles, no aria-current or aria-label — visual-only step progress (Shipping → Payment)	🟡 Medium	CheckoutPaymentPanel.tsx:33-65
Admin color-contrast rule disabled in axe-core audit — 'color-contrast' is in RULES_TO_OMIT	🟡 Medium	qa-a11y.ts:48
SVG icons missing aria-hidden="true" — many inline SVGs in checkout payment panel have no accessibility annotation	🟡 Medium	CheckoutPaymentPanel.tsx:42
Error boundary exposes stack traces in dev — error.value.stack rendered in <pre>	🟢 Low (dev only)	CheckoutErrorBoundary.tsx:119-125
Admin mobile drawer missing focus trap — Escape closes it, but Tab can navigate behind the overlay	🟡 Medium	Layout.tsx:230-246
---
5. Internationalization
🔴 Essentially Non-Existent
Finding	Severity
i18n.ts is a stub — only exports extractBase() returning '/build'. Zero i18n functionality	🔴 High
All strings hardcoded in English — "Skip to main content", "Page Not Found", "Add to Cart", "Checkout", etc.	🔴 High
Currency hardcoded to USD — DEFAULT_CURRENCY = 'USD', formatting uses $ directly	🔴 High
Price formatting inline — '$' + (cents / 100).toFixed(2) with no locale awareness	🟡 Medium
Country detection is geolocation-only — no user-facing language picker	🟡 Medium
Admin has locale-aware currency ✅ — (0).toLocaleString('en-US', { style: 'currency', currency: cur }) for symbol extraction	✅
What's Needed for SellRight Multi-Tenancy
- Extract all UI strings to a locale dictionary
- Add Accept-Language header parsing
- Use Intl.NumberFormat for currency display
- Support RTL layouts
- Admin already handles multi-store with StoreSwitcher — extend to locale/currency
---
6. Form Handling
✅ Strengths
Feature	Implementation	File
Email validation	validator.isEmail() + bogus pattern blocking	utils/validation.ts:31-53
Phone validation	libphonenumber-js with country-aware rules	utils/validation.ts:81-150
Credit card validation	card-validator library for Luhn, CVV, expiry	utils/card-validation.ts
Postal code lookup	Auto-fill city/state from ZIP	utils/postal-lookup.ts
US state validation	us-state-converter for state code/name matching	utils/validation.ts:342-366
Canadian province validation	Hardcoded list of codes and names	utils/validation.ts:369-387
Autocomplete attributes	✅ email, tel, given-name, family-name, street-address, address-level2, address-level1, postal-code	AddressForm.tsx, CheckoutAddressesView.tsx
Touch-to-blur validation	Validates on blur, then re-validates on change once touched	CheckoutAddresses.tsx:205-309
Bogus data detection	Blocks test@test.com, 0000000000, 00000 ZIP, etc.	utils/validation.ts:8-24
🔴 Issues
Finding	Severity	File
Debounced validation timer leaks — validationTimer signal stores setTimeout IDs but cleanup on unmount is not guaranteed	🟡 Medium	CheckoutAddresses.tsx:34, AddressForm.tsx:30
Validation errors are signals, not aria-linked — error messages render as visual siblings but lack aria-describedby or aria-errormessage	🔴 Critical	CheckoutAddressesView.tsx
Admin login form has no autoComplete on email/password inputs	🟡 Medium	pages/Login.tsx:51-55
Admin product edit: no client-side form validation feedback — NaN guard exists but user sees no inline error before submit	🟡 Medium	pages/ProductDetail.tsx:49-52
---
7. State Management
Cart Architecture — ✅ Sophisticated
Aspect	Status	File
Dual-mode cart	VITE_SERVER_CART flag toggles between LocalCartService (localStorage) and ServerCartService	contexts/CartContext.tsx:22-24
Cross-tab sync	storage event listener invalidates cache on vendure_local_cart key changes	services/LocalCartService.ts:26-43
Stock validation	Real-time stock check before add-to-cart and before checkout	services/local-cart-stock.ts
Custom events	cart-updated CustomEvent for header badge updates	contexts/CartContext.tsx:251-254
Coupon support	AppliedCoupon with code, discount, free shipping	contexts/CartContext.tsx:27-34
Guest address persistence	Shipping address saved/restored from localStorage for guests	components/address-form/address-guest-storage.ts
🔴 Issues
Finding
Cart data not encrypted — vendure_local_cart stored as plain JSON in localStorage, readable by any script on the page
No cart expiration — items persist indefinitely in localStorage
Race condition potential — qinit handler reads cart from localStorage, but ServerCartService.refresh() is fire-and-forget with .then()/.catch() — if the server returns stale data after user has already mutated the optimistic cart, server wins and overwrites
Admin auth state uses localStorage for store slug — acceptable for non-sensitive data
---
8. Security (Frontend)
✅ Strong Security Posture
Feature	Implementation
CSP headers	Comprehensive policy with default-src, script-src, style-src, connect-src, object-src 'none'
HSTS	max-age=31536000; includeSubDomains; preload (production only)
X-Frame-Options	SAMEORIGIN
X-Content-Type-Options	nosniff
Referrer-Policy	strict-origin-when-cross-origin
Permissions-Policy	camera=(), microphone=(), geolocation=()
XSS sanitization	DOMPurify with allowlist for HTML tags, attributes; blocks script, iframe, object, embed, event handlers
Inline script sanitization	Blocks eval(), document.write, innerHTML, document.location patterns
CSS sanitization	DOMPurify strips tags from style strings
Admin CSRF	Double-submit cookie pattern (sr_csrf → x-csrf-token header)
Admin session	httpOnly cookie, not readable by JS
Nonce support	CSP nonce passed from Express to SSR render
🔴 Issues
Finding	Severity
CSP script-src 'unsafe-inline' — required by Qwik but weakens CSP significantly. Mitigated by nonce for inline scripts, but the directive allows ALL inline scripts	🟡 Medium
CSP default-src includes 'unsafe-inline' data: https: blob: — extremely permissive, effectively allows any HTTPS source	🔴 High
Preview CSP is stricter than production — preview headers have tighter policy than the Express server	🟡 Medium
dangerouslySetInnerHTML used for JSON-LD — mitigated by escapeJsonForScript() and DOMPurify, but still a risk surface	🟢 Low
Admin has NO CSP headers — the admin SPA index.html has no Content-Security-Policy meta tag or server headers	🟡 Medium
security.txt exists in public dir — good practice for vulnerability disclosure	✅
---
9. Mobile Experience
✅ Strong Mobile Support
Feature	Implementation	File
PWA manifest	name, short_name, start_url, display: standalone, icons at 192×192 and 512×512	public/manifest.json
Touch-optimized gallery	RAF-based swipe detection with configurable threshold	utils/optimized-touch-handling.ts
Sticky mobile CTA bar	Fixed bottom bar with total + PAY button on checkout (safe-area aware)	routes/checkout/checkout-styles.ts:33-86
Mobile navigation drawer	Slide-in sidebar with backdrop, Escape to close, auto-close on route change	components/Layout.tsx:230-246
Viewport meta	width=device-width, initial-scale=1, viewport-fit=cover	head.tsx:20
Apple mobile support	apple-mobile-web-app-capable, apple-mobile-web-app-status-bar-style: black-translucent	head.tsx:25,70
Theme color	Light/dark variants via media queries	head.tsx:22-23
Safe area insets	env(safe-area-inset-bottom) on mobile CTA and toast stack	checkout-styles.ts:47, Toast.tsx:150
Image optimization	WebP/AVIF via vite-imagetools, ?preset=xl for product images	vite.config.ts:98-114
Font preloading	Critical fonts preloaded with fetchPriority="high"	head.tsx:126-129
🔴 Issues
Finding	Severity
PWA manifest missing purpose: "maskable" on icons — causes letterboxing on Android	🟡 Medium
No screenshots in manifest — PWA install prompt lacks preview images	🟢 Low
No offline fallback — service worker registered but no offline page or cache strategy visible	🟡 Medium
Product page min-h-[50vh] error state — not mobile-optimized, no touch-friendly retry button	🟢 Low
---
10. Checkout UX
✅ Strengths
Feature	Implementation	File
Multi-payment support	Stripe (Payment Element), NMI, Sezzle, COD — behind feature flag SR_CHECKOUT_ENABLED	checkout/index.tsx, CheckoutPaymentPanel.tsx
Two-step visual flow	Shipping → Payment with connected progress indicators	CheckoutPaymentPanel.tsx:32-65
Real-time validation	Touch-based validation with visual icons (✓/✗) on each field	CheckoutAddresses.tsx
Guest checkout	No login required, optional sign-in link	CheckoutAddressesView.tsx:58-68
Order processing modal	Blocks UI during payment processing	OrderProcessingModal.tsx
Payment error recovery	Checks if order actually succeeded despite error callback, transitions order back to AddingItems state	checkout-payment-recovery.ts
Empty cart state	Dedicated CheckoutEmptyCart component	CheckoutEmptyPanel.tsx
Promo code	Expandable promo section with coupon application	checkout/index.tsx
Pre-order support	Mixed pre-order detection, consent checkbox, different CTA styling	CartContext.tsx, ProductContent.tsx
🔴 Issues
Finding
No order confirmation email trigger visible — navigation to /checkout/confirmation/${code} but no visible email confirmation step
Stripe confirmPayment uses return_url redirect — on success, Stripe redirects (full page load), losing Qwik state. User sees a full page reload on successful payment
No loading skeleton for checkout — pageLoading signal exists but the loading state shows nothing (blank) until pageLoading.value flips to false
Error display is generic — state.error shown in a styled div but no differentiation between network errors, validation errors, and payment declines
COD (cash on delivery) hardcoded — srPayOrder(created.code, 'cod') for non-Stripe flow with no user-facing selection
formattedTotal computed in cents with manual formatting — $ + toFixed(2) + regex instead of Intl.NumberFormat
Shipping threshold hardcoded — $100 free shipping, $8 domestic, $20 international — not configurable per-store
---
Summary: Production Readiness Scorecard
Area	Score	Verdict
Storefront Architecture	8/10	✅ Solid Qwik SSR setup, needs component decomposition
Admin Architecture	8/10	✅ Clean React SPA, needs Error Boundary
SEO	9/10	✅ Excellent — structured data, sitemaps, robots.txt, OG tags
Accessibility	5/10	🔴 Critical gaps — missing #main-content, no <label> on checkout inputs, no aria-describedby
Internationalization	2/10	🔴 Not implemented — English/USD only
Form Handling	8/10	✅ Strong validation, needs aria-linking
State Management	8/10	✅ Dual-mode cart, cross-tab sync
Security	7/10	✅ Good headers, CSP too permissive on default-src
Mobile Experience	8/10	✅ PWA, touch gestures, safe-area, sticky CTA
Checkout UX	7/10	✅ Multi-payment, needs better error states and loading
Top 5 Blockers for Production
1. #main-content target missing — skip-to-content link is broken
2. Checkout inputs have no <label> elements — WCAG 2.1 failure, screen reader users can't identify fields
3. No React Error Boundary in admin — unhandled render errors crash the entire SPA
4. CSP default-src too permissive — https: wildcard effectively allows any origin
5. No i18n infrastructure — SellRight multi-tenant stores can't be localizedmimo SellRight Pressure Test: Migration Readiness Assessment

  I've traced every layer of this codebase — 42 database tables, 37 migrations, 30+ route files, the full
  payment/order/auth/fulfillment pipeline, testing coverage, and operational posture. Here's my honest assessment against Shopify,
  WooCommerce, and Vendure.

  ───
  Architecture Grade: B+

  The stack choices are strong. Hono + Drizzle + PostgreSQL with typed Zod-OpenAPI contracts is modern, lightweight, and well-suited
  for a multi-tenant SaaS commerce platform. Compared to Vendure's NestJS + TypeORM + GraphQL stack, it's significantly leaner and
  more performant. The architectural decision to go typed REST over GraphQL is the right call for a platform that doesn't need
  client-driven query flexibility.

  What sets it apart:

  - PostgreSQL RLS for tenant isolation is the gold standard — neither Shopify nor WooCommerce do this. Vendure doesn't either.
  - Transactional outbox pattern for webhooks prevents both lost events and ghost deliveries.
  - Server-authoritative pricing on every cart touch — prices can't be manipulated client-side.
  - Two-phase Stripe payment with server-side intent verification — never trusts the client.

  ───
  Security Grade: A-

  This is the strongest area. The security posture exceeds what most self-hosted commerce platforms ship with.

  ┌──────────────────────┬─────────────────────────────┬─────────────────┬───────────────────┬───────────────┐
  │ Feature              │ SellRight                   │ Shopify         │ WooCommerce       │ Vendure       │
  ├──────────────────────┼─────────────────────────────┼─────────────────┼───────────────────┼───────────────┤
  │ Tenant isolation     │ DB-level RLS                │ SaaS (isolated) │ Single-tenant     │ App-level     │
  ├──────────────────────┼─────────────────────────────┼─────────────────┼───────────────────┼───────────────┤
  │ CSRF protection      │ Double-submit + timing-safe │ SaaS-managed    │ Plugin-dependent  │ Built-in      │
  ├──────────────────────┼─────────────────────────────┼─────────────────┼───────────────────┼───────────────┤
  │ Password hashing     │ scrypt (memory-hard)        │ N/A (SaaS)      │ bcrypt (plugin)   │ bcrypt        │
  ├──────────────────────┼─────────────────────────────┼─────────────────┼───────────────────┼───────────────┤
  │ 2FA                  │ TOTP + replay guard         │ Built-in        │ Plugin            │ Plugin        │
  ├──────────────────────┼─────────────────────────────┼─────────────────┼───────────────────┼───────────────┤
  │ SSRF protection      │ Comprehensive blocklist     │ SaaS-managed    │ Plugin            │ None          │
  ├──────────────────────┼─────────────────────────────┼─────────────────┼───────────────────┼───────────────┤
  │ Rate limiting        │ Per-IP sliding window       │ SaaS-managed    │ Plugin            │ None built-in │
  ├──────────────────────┼─────────────────────────────┼─────────────────┼───────────────────┼───────────────┤
  │ Payment verification │ Server-side re-check        │ SaaS-managed    │ Gateway-dependent │ Plugin        │
  └──────────────────────┴─────────────────────────────┴─────────────────┴───────────────────┴───────────────┘

  Gaps to fix before production:

  1. In-memory rate limiting — doesn't survive restarts or scale horizontally. Needs Redis before multi-instance deployment.
  2. No graceful shutdown — SIGTERM kills in-flight requests and open transactions. Critical for zero-downtime deploys.
  3. Missing Retry-After header on 429 responses.
  4. Unbounded address/metadata fields — shippingAddress accepts z.record(z.string(), z.unknown()) with no size limit.
  5. Webhook HMAC secret not redacted from error objects in the delivery transaction.

  ───
  Performance Grade: C+

  This is the weakest area and the biggest risk for migration. The codebase has several patterns that work at low scale but will
  degrade noticeably under real traffic.

  Critical issues:

  ┌──────────────────────────────────────────────────────────────┬──────────────────────────────────────────────────────┬─────────┐
  │ Issue                                                        │ Impact                                               │ Effort  │
  ├──────────────────────────────────────────────────────────────┼──────────────────────────────────────────────────────┼─────────┤
  │ Smart collection browse loads ALL products into JavaScript   │ Catalog death at scale                               │ Medium  │
  ├──────────────────────────────────────────────────────────────┼──────────────────────────────────────────────────────┼─────────┤
  │ Zero caching — resolveStore() hits DB on every request       │ Baseline latency tax on every request                │ Low     │
  ├──────────────────────────────────────────────────────────────┼──────────────────────────────────────────────────────┼─────────┤
  │ Bulk ops use separate transaction per order (N+1 withStore)  │ Bulk fulfill of 100 orders = 100 BEGIN/COMMIT cycles │ Low     │
  ├──────────────────────────────────────────────────────────────┼──────────────────────────────────────────────────────┼─────────┤
  │ Webhook delivery holds DB connection during 10s HTTP timeout │ Pool exhaustion under webhook backlog                │ Medium  │
  ├──────────────────────────────────────────────────────────────┼──────────────────────────────────────────────────────┼─────────┤
  │ Affiliate list N+1 — 3 correlated subqueries per affiliate   │ Linear degradation                                   │ Low     │
  ├──────────────────────────────────────────────────────────────┼──────────────────────────────────────────────────────┼─────────┤
  │ Commented-out customer_token_hash_idx                        │ Seq scan on every password reset                     │ Trivial │
  ├──────────────────────────────────────────────────────────────┼──────────────────────────────────────────────────────┼─────────┤
  │ No connection timeout (PGPOOL_CONNECTION_TIMEOUT_MS=0)       │ Hung requests when DB is unreachable                 │ Trivial │
  ├──────────────────────────────────────────────────────────────┼──────────────────────────────────────────────────────┼─────────┤
  │ CSV exports buffer everything in memory                      │ OOM on large catalogs                                │ Medium  │
  ├──────────────────────────────────────────────────────────────┼──────────────────────────────────────────────────────┼─────────┤
  │ Multiple storefront endpoints lack pagination                │ Unbounded result sets                                │ Low     │
  └──────────────────────────────────────────────────────────────┴──────────────────────────────────────────────────────┴─────────┘

  Compared to competitors:

  - Shopify has a CDN-layer edge cache, built-in Redis, and auto-scaling infrastructure. SellRight has none of that — it's bare
  metal.
  - WooCommerce suffers from similar problems (no caching layer, per-request DB queries) but compensates with WordPress page caching
  plugins.
  - Vendure has similar architecture to SellRight but its TypeORM queries are typically slower than Drizzle's lean SQL generation.

  The performance issues are all fixable — resolveStore() caching alone would cut baseline latency noticeably. But they need to be
  fixed before a live migration.

  ───
  Testing Grade: C

  The unit tests that exist are excellent — the money/totals engine has 500-case property tests, RLS has table-driven isolation tests
   covering every store-scoped table, and the licensing pipeline is thoroughly covered.

  But the critical paths are largely untested:

  ┌────────────────────────────┬───────────────┬───────────────────┐
  │ Untested Area              │ Lines of Code │ Risk              │
  ├────────────────────────────┼───────────────┼───────────────────┤
  │ routes/checkout.ts         │ 22KB          │ Revenue-blocking  │
  ├────────────────────────────┼───────────────┼───────────────────┤
  │ routes/auth.ts             │ 14KB          │ Security-blocking │
  ├────────────────────────────┼───────────────┼───────────────────┤
  │ routes/payment-webhooks.ts │ 8.7KB         │ Revenue-blocking  │
  ├────────────────────────────┼───────────────┼───────────────────┤
  │ payments/settle.ts         │ —             │ Revenue-blocking  │
  ├────────────────────────────┼───────────────┼───────────────────┤
  │ licensing/issue.ts         │ —             │ Revenue-blocking  │
  ├────────────────────────────┼───────────────┼───────────────────┤
  │ Entire packages/storefront │ —             │ UX-blocking       │
  ├────────────────────────────┼───────────────┼───────────────────┤
  │ auth/totp.ts               │ —             │ Security-critical │
  ├────────────────────────────┼───────────────┼───────────────────┤
  │ All 5 background jobs      │ —             │ Operational risk  │
  └────────────────────────────┴───────────────┴───────────────────┘

  Also: The 6 DB integration test files are excluded from CI — pnpm verify only runs unit tests. This means regressions in the
  checkout, subscription, and RLS paths aren't caught in CI.

  Compared to Shopify/Vendure: Shopify has thousands of integration tests. Vendure has ~80% coverage on its core module. SellRight's
  critical revenue paths being untested is the single biggest migration blocker from a confidence standpoint.

  ───
  Observability Grade: D+

  This is a significant gap for production operation. The codebase has:

  - console.log/console.error only — no structured logging
  - No request IDs or correlation IDs
  - No metrics endpoint (no Prometheus, no StatsD)
  - No APM integration
  - No readiness probe (only liveness)
  - No graceful shutdown
  - No alerting rules
  - Email failures silently dropped with no retry or dead-letter

  Compared to competitors:

  - Shopify has full Datadog/PagerDuty integration internally.
  - Vendure has better plugin ecosystem support for logging (Winston, Pino integrations).
  - WooCommerce has logging plugins and WooCommerce Status dashboard.

  You can run this in production without observability — many small stores do — but diagnosing issues under load will be painful
  without adding at minimum structured logging and a readiness probe.

  ───
  Migration Completeness: ~65%

  The storefront is mid-migration from Vendure GraphQL to SellRight REST via strangler flags.

  Fully migrated to SellRight: Catalog, search, collections, auth, customer profile, addresses, orders (read).

  Still on Vendure GraphQL: Order mutations (active cart management), contact form, order tracking, SEO routes (all
  sitemaps/robots.txt hitting localhost:3100), blog/affiliate providers, address sync.

  Both feature flags default to OFF — the legacy Vendure paths are still production-primary. This is fine for a gradual rollout but
  means you're currently running two backends.

  ───
  Blockers for Live Migration

  Must-fix (P0)

  1. Add integration tests for checkout and auth flows — These are your revenue and security critical paths with zero test coverage.
  A regression here means lost orders or compromised accounts.
  2. Add graceful shutdown — SIGTERM handler that stops the scheduler, drains in-flight requests, closes the DB pool. Without this,
  every deploy drops active transactions.
  3. Add a readiness probe — /v1/ready that pings the database. Currently a server with a broken DB connection returns 200 on
  /v1/health.
  4. Cache resolveStore() — Every shop request makes a DB query to resolve the tenant. An in-memory Map with 60s TTL is a 5-line fix.
  5. Fix smart collection browse — Loading all products into JavaScript to evaluate collection rules will collapse under real catalog
   sizes. Push the rules into SQL or paginate.
  6. Uncomment customer_token_hash_idx — This is a commented-out index that causes seq scans on every password reset.
  7. Set PGPOOL_CONNECTION_TIMEOUT_MS to 5000 — The default of 0 (no timeout) means hung connections when the DB is unreachable.

  Should-fix (P1) before go-live

  1. Fix bulk ops N+1 transactions — Wrap in a single withStore() call.
  2. Move webhook delivery HTTP calls outside the DB transaction — 10s HTTP timeouts holding pool connections is a pool exhaustion
  vector.
  3. Add structured logging (pino or similar) with request IDs.
  4. Add email retry/dead-letter — Currently order confirmation emails silently disappear on failure.
  5. Add session and processed_event cleanup jobs — These tables grow forever.
  6. Add missing composite indexes — product(store_id, status, deleted_at), order(store_id, deleted_at WHERE NULL),
  blog_post(store_id, isPublished).
  7. Set pool size to 20-50 for production — Default of 10 is low for concurrent traffic.
  8. Complete storefront migration — Finish the SEO routes, order mutations, contact form, and tracking off Vendure.

  Should-fix (P2) within first month

  1. Add Prometheus metrics or APM — Request latency histograms, error rates, DB pool utilization.
  2. Add CORS headers for the API if storefront will be on a different domain.
  3. Stream CSV exports instead of buffering in memory.
  4. Add Retry-After headers on 429 responses.
  5. Set max-length validation on address fields and other record-type inputs.

  ───
  Bottom Line

  The architecture is solid, the security is strong, and the domain logic is well-designed. The RLS-based multi-tenancy,
  transactional outbox, server-authoritative pricing, and two-phase payment verification are patterns that most commerce platforms
  don't have, even Shopify's internal platform.

  But it's not ready for a live migration today. The combination of untested critical revenue paths, no graceful shutdown, no
  caching, no observability, and an incomplete storefront migration means you'd be migrating into a system where bugs in the checkout
   flow are undetectable in CI, deploys drop active transactions, and you can't diagnose production issues.

  My honest recommendation: fix the P0 list (items 1-7), which is achievable in a focused sprint, then do a staged migration — enable
   the feature flags on a low-traffic store first, run it alongside Vendure for 2-4 weeks, then cut over. The P1 list can be
  addressed during that parallel-run period.