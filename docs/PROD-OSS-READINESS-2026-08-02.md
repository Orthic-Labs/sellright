# Production + Open-Source Readiness — 2026-08-02

Scope: deep analysis of the 2026-08-01 MiniMax audit (`.audit/2026-08-01T07-19-52-627Z/` + the `.agent/` cortex refresh), fresh verification at HEAD `fda6fc9`, basic-flow completeness check, and an ad-hoc platform comparison. Fixes ranked Critical → Low at the end.

---

## 1 · What the MiniMax audit actually was (and wasn't)

Two artifacts, very different quality:

**A. `.audit/2026-08-01…/audit-report.md` — scanner-only, INCOMPLETE.** Its own header says so: reasoning lenses never ran, health score withheld. Root cause: `node_modules` was absent, so tsc/eslint/knip/build all skipped, and `pnpm audit` errored because `pnpm@11.12.0` is a broken release (no binary). What *did* run was clean: gitleaks 0 secrets, actionlint 0, jscpd 2 candidates, semgrep 7 candidates, swiftlint 75 (all style). **Do not treat that report as an audit verdict — it proved almost nothing either way.**

**B. `.agent/` cortex refresh — genuinely good.** A full blueprint-treesitter regeneration at HEAD (gen `910b4a72…`, clean source state): 129 doc claims re-grounded, 63 entry points / 200 flows mapped, and detailed health/security synthesis in `understanding.json`. Its security posture section is accurate (I spot-verified its load-bearing claims against code). The `.agent/graph/graph.json` deletion is the blueprint→cortex format migration, not damage — I rebuilt the graph (`graph.db`, 7,819 nodes / 2,564 edges) and it regenerates cleanly.

**MiniMax's uncommitted working-tree changes, triaged:**

| Change | Verdict |
|---|---|
| `packageManager` pnpm 11.12.0 → 11.18.0 (3 package.json files) | **Correct** — 11.12.0 is a broken release; keep this. |
| `.github/workflows/verify.yml` DELETED, nothing replacing it | **Regression** — that workflow was the entire CI (install/migrate/deps-audit/verify/typecheck/test on Postgres 16, SHA-pinned actions) and the basis of the "supply chain: actions pinned" clean mark. Restore it (with the pnpm pin updated). |
| `.agent/*` + `.blueprint/manifest.json` refresh | Keep — legitimate cortex migration output. |

**Re-verification I ran today (post `pnpm install`):** typecheck ✅ 0 errors · API unit suite ✅ 41 files / 222 tests · full workspace build ✅ exit 0 · cortex graph rebuild ✅. Semgrep triage: 6 of 7 findings are the two deliberately-deferred pnpm supply-chain settings (`minimumReleaseAge`, `trustPolicy` — documented in root `pnpm-workspace.yaml` comments), 1 is a false positive (`ws:` inside the dev CSP string). SwiftLint: all 75 are style; zero touch Keychain/APIClient/auth/crypto paths.

---

## 2 · Basic-flow completeness (the checklist you asked for)

| Area | State | Evidence |
|---|---|---|
| Products / catalog | ✅ Complete | catalog routes (`catalog.ts`), admin CRUD, variants/options/collections/smart collections, trigram search |
| Customers / accounts | ✅ Complete | register/login/Google/2FA/reset/verify, profile + addresses, GDPR endpoints (`account.ts`) |
| Sign-in security | ✅ Complete | scrypt, hash-only tokens, double-submit CSRF, TOTP, enumeration defenses, sliding-window login throttle |
| Orders | ✅ Complete | FSM transitions, drafts, returns/RMA, partial refunds, bulk cancel/trash/purge with FK-coverage guard |
| Checkout + payments (API) | ✅ Complete | server-priced, stock reservation `FOR UPDATE`, idempotency, advisory locks, mode-bound Stripe webhooks, `(store_id, provider_ref)` unique (0037) |
| Checkout (storefront) | ⚠️ **Flag off** | `VITE_SR_CHECKOUT=0` default (`.env.example:19`) — Stripe Elements path built but still pending its live test-card run; the flag stands between you and the Vendure cutover |
| Turnstile | ❌ **Not validated anywhere in the API** | zero hits in `packages/api/src`; storefront `check-email.ts:6` says the token is "kept for call-site compatibility" — bot protection was deliberately dropped, leaving only IP rate-limits |
| Redis | ❌ None (by design) | no redis dep; login limiter + store-context cache are per-process Maps (`rate-limit.ts:3-5`); jobs use Postgres advisory leader-locks instead — multi-instance-safe **except** the limiter/cache |
| DB pooling | ✅ Configured | `PGPOOL_MAX=10`, idle 10s, connect-timeout 5s, fail-fast (`env.ts:25-30`) |
| DB indexes | ✅ Present | pg_trgm GIN search (0029), `customer_token(token_hash)` UNIQUE + index (0023), licensing indexes (0028), provider_ref unique (0037), outbox autovacuum tuning (0040); 41 migrations, RLS asserted at boot |
| HTTP caching | ❌ None | no Cache-Control/ETag on catalog routes; no Redis/HTTP cache layer; static catalog manifest is the fast-path mitigation |
| Pagination | ⚠️ Offset everywhere | fine at your volumes; degrades at high page counts |
| Jobs | ✅ Multi-instance safe | advisory-lock leader election per tick (`leader-lock.ts`), SKIP LOCKED batching |
| Email | ✅/⚠️ | transactional outbox + retries ✅; `cart.abandoned` event emitted (`cart-maintenance.ts:35`) but **no recovery-email flow consumes it** |

So: the engine flow is complete and well-hardened. The three real holes are storefront-checkout-still-flagged-off, no server-side bot protection, and no caching layer.

---

## 3 · Ad-hoc platform comparison

Grounded in the repo's researched teardown (`docs/COMPETITORS.md`, `docs/COMMERCE-GAP-ANALYSIS.md`, June 2026) plus today's code verification. Engine claims about SellRight are code-verified; competitor columns are from that research.

**Security** — SellRight is *ahead* of self-hosted peers. FORCE RLS multi-tenancy with a non-owner DB role + boot assertion is something Vendure, Medusa, and WooCommerce simply don't have; server-authoritative pricing, idempotent money paths, mode-bound webhooks, DNS-pinned SSRF guard, signed download URLs, and double-submit CSRF put the backend at Shopify-discipline level. All 11 previously-verified security claims re-verified clean at HEAD today, zero regressions. Gaps vs Shopify: no WAF/bot layer (Turnstile hole above) and RBAC keys enforced on only a few actions.

**Performance** — parity for single-instance, behind at scale. Disciplined indexes, tuned pool, static catalog manifest ≈ Vendure-class. No Redis, no HTTP cache, offset pagination, local-disk assets = a documented single-instance ceiling; Shopify/BigCommerce (hosted) and Medusa (Redis-native) win beyond one box. For DD/RH volumes this ceiling is nowhere in sight.

**Basic features** — complete commerce core (catalog/cart/checkout/orders/refunds/customers/promotions/gift cards/tax zones/subscriptions/affiliates/licensing/webhooks/blog). Ahead of everyone on digital/licensing + true multi-tenancy. Behind on payment breadth (Stripe-only), live shipping rates, automatic tax/EU VAT, reviews/loyalty/upsell, and the app ecosystem — none of which block DD/RH/RightApps.

**Bottom line vs Vendure specifically:** you lose GraphQL and the plugin ecosystem; you gain RLS multi-tenancy, native licensing/subscriptions, a leaner REST contract, and code you own. For your stores this is a net upgrade — the migration risk is operational (cutover), not architectural.

---

## 4 · Verdicts

**Open source: NO — not yet.** The code is not the problem; the packaging is, and 6 of the 7 blockers from the 2026-07-17 readiness audit are still open (verified today). Publishing now ships DD's brand, real customer reviews, your competitive strategy docs, and a license that forbids using the code.

**Migrate prod off Vendure: NOT YET — but close.** The backend is migration-ready (tests green, money paths hardened, box runbooks exist). What stands between you and cutover: storefront checkout flag still off pending the live test-card run, no bot protection on a storefront that currently has Turnstile under Vendure, and CI currently deleted in the working tree.

---

## 5 · Ranked fixes

### CRITICAL — before any commit / cutover / publish

| # | Fix | Evidence |
|---|---|---|
| C1 | **Restore `.github/workflows/verify.yml`** (uncommitted deletion; repo currently has zero CI). Update its corepack pnpm pin to 11.18.0 while restoring. | `git status`: `D .github/workflows/verify.yml`; `.github/` now empty |
| C2 | **Run the live test-card transaction and flip `VITE_SR_CHECKOUT` default on** — the single gate between the storefront and Vendure retirement. | `useCheckout.ts:16`, `.env.example:19`, `docs/FEATURES.md` "pending one live test-card run" |
| C3 | **License decision (yours, not automatable):** current LICENSE says "All rights reserved… no permission to copy/modify/distribute" — publishing under it is self-defeating. MIT/Apache for adoption, BSL/Elastic if you fear a hosted reseller. | `LICENSE:1-8` |
| C4 | **Strip DD brand + real customer data from the public cut:** `damned-designs-storefront` package identity, `trustpilot.json` real reviews (real names), DD copy, Vendure-era `graphql-shop*.ts`, and `packages/admin/vite.config.ts:33` proxying `damneddesigns.com`. Genericize into a demo store or exclude the package. | `storefront/package.json:2-5`, `src/data/trustpilot.json`, `admin/vite.config.ts:33` |

### HIGH — before prod migration (or first public release)

| # | Fix | Evidence |
|---|---|---|
| H1 | **Server-side bot protection**: validate Turnstile (or equivalent) on register/login/check-email/contact/newsletter/checkout. Vendure-era storefront had it; SellRight dropped it — card-testing and signup spam hit day one on a live store. | zero `turnstile` hits in `packages/api/src`; `check-email.ts:6` |
| H2 | **Untrack internal strategy docs** (MOAT, GTM, COMPETITORS, MARKET-PLACEMENT, COMMERCE-GAP-ANALYSIS, ADMIN-*-PLAN, docs/plans/, rank.md, .agent/) and trim README's links to them. | all still tracked; `README.md:43-46` |
| H3 | **Move/genericize `packages/api/scripts-deploy/`** — box-specific nginx/systemd + `adrdsouza@gmail.com` hardcoded in 3 scripts (incl. `deploy-rightapps-tls.sh:14`). | scripts-deploy/* |
| H4 | **Vendor or drop `deps:*` scripts** — they call `../tools/right-release/deps.mjs`, which no cloner has; CLAUDE.md/AGENTS.md also describe your private workspace. Rewrite as public contributor docs. | root `package.json:20-23` |
| H5 | **Document the single-instance ceiling loudly in README** (in-process rate limiter + store-context cache, local-disk assets) so self-hosters don't horizontal-scale into it. Redis adapter itself can wait. | `rate-limit.ts:3-5`, `store-context.ts` |

### MEDIUM

| # | Fix | Evidence |
|---|---|---|
| M1 | Abandoned-cart recovery email flow — the `cart.abandoned` event fires but nothing consumes it; cheapest high-demand revenue feature, data already captured. | `cart-maintenance.ts:35`; no `abandon` in `email/templates.ts` |
| M2 | Real OpenAPI metadata — "Commerce Platform API" v0.0.0 is the published contract of the product. | `app.ts:254-257` |
| M3 | pnpm supply-chain settings (`minimumReleaseAge`, `trustPolicy: no-downgrade`) — deliberately deferred pending lockfile rebuild; do the rebuild and enable. | root `pnpm-workspace.yaml` comments; semgrep 6/7 findings |
| M4 | HTTP caching on public catalog reads (Cache-Control/ETag or CDN in front) — zero cache headers today. | no hits in `catalog.ts`/`app.ts` |
| M5 | Test coverage for the untested surfaces cortex flagged (~23 files incl. `settle.ts`, `licensing/issue.ts`, `coupon.ts`, `session.ts`, `password.ts`, `orders.ts`, `apps.ts`) — money/auth files with no direct test sibling. | `understanding.json` health.untested |
| M6 | Sync stale docs — 7 stale claims + 39 missing references (COMMERCE-GAP-ANALYSIS still describes pre-hardening state in places; DISPATCH ledger rows superseded). | `.agent/stale.json` |
| M7 | Refund quantity over-clamp: per-line qty exceeding refundable is `Math.min`-clamped instead of rejected — ledger can record a truncated quantity. Money safe, ledger honesty isn't. | `admin-orders.ts:218-219` (07-17 audit, still open) |

### LOW

| # | Fix | Evidence |
|---|---|---|
| L1 | Decompose the 9 oversized runtime files (checkout.ts 440, admin-orders.ts 442, admin-marketing.ts 466, schema-orders.ts 439, 5 storefront components >400 LOC). | audit facts.json |
| L2 | Dedupe AddressForm vs BillingAddressForm (~410 LOC near-twins) and the 3 cart-pricing implementations (server `priceCart` / `ServerCartService.recalc` / legacy `LocalCartService`). | `understanding.json` health.duplication |
| L3 | Remove dead weight: `baseLogger`, `isAbandonable`, unused `@sellright/shared` re-export. | health.deadWeight |
| L4 | SwiftLint style pass (75 findings, all cosmetic — line length, identifier names, trailing commas). | swift_lint.log |
| L5 | Commit the cortex migration state coherently: `.agent/` refresh + `.blueprint/manifest.json` + graph.db story in one commit so the graph.json deletion is documented as a format change. | working tree |

---

## 6 · Suggested sequence

1. Restore verify.yml, commit MiniMax's pnpm bump + cortex refresh (C1, L5).
2. H1 Turnstile server-side validation (small: one verify helper + 5 route call sites).
3. C2 live test-card run → flip the checkout flag → begin the Vendure cutover per the box runbooks.
4. Then the open-source pass as its own project: C3 license (your call) → C4 brand strip → H2/H3/H4 packaging.
