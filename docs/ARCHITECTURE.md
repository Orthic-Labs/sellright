# SellRight Architecture

Last reviewed (Blueprint Phase 1-3): 2026-07-14 · HEAD `6848789` · 58 commits since last reconcile state (bff9e1d).

> ## ⚠️ RECONCILE — 23 DECISIONS NEEDED (blocker)
> The code and the docs disagree on 23 things. You decide how to reconcile each. Nothing else here matters until these are settled.
>
> | # | The doc says | The code actually does | Verdict | Proposed fix | Your call |
> |---|---|---|---|---|---|
> | 1 | "All 12 lanes are merged to origin/main (bff9e1d) and validated on the box: assert-rls OK (" — `docs/plans/BOX-VALIDATION-CHECKLIST.md:3` | git rev-parse HEAD = 6848789. bff9e1d → HEAD has 58 commits. Many §3a BUILD lanes beyond t | **SUPERSEDED-BY** | Mark BOX-VALIDATION-CHECKLIST.md §Validation COMPLETE line as a 2026-07-04 snapshot; add a | ☐ |
> | 2 | "§1 DONE — 12 lanes on main bff9e1d, box-validated (187 non-DB + 88 DB tests)." — `docs/plans/DISPATCH.md:560` | git rev-parse HEAD = 6848789. test:db script lists 23 files. Most §3a BUILD lanes have mer | **SUPERSEDED-BY** | Update the §1 DONE trailer (line 560) to reflect the actual current state (HEAD + lane cou | ☐ |
> | 3 | "Nothing is silently omitted — every audit finding is DONE, refuted, a BUILD lane, or defer" — `docs/plans/DISPATCH.md:566` | Many §3a 'BUILD' rows have actually MERGED: PERF-2 (2c09de3/fbb761d), PERF-12 (c71a24b/654 | **CODE-IS-BETTER** | Recount §3a BUILD: move the merged lanes to the §1 ACTIONED table with their SHAs and box- | ☐ |
> | 4 | "PERF-12 auto-deliver N+1 — apply OPS-2's SKIP-LOCKED + batched-update treatment to auto-de" — `docs/plans/DISPATCH.md:507` | PERF-12 merged: c71a24b perf(jobs): SKIP LOCKED + batched UPDATE for auto-deliver (PERF-12 | **CODE-IS-BETTER** | Move PERF-12 from §3a BUILD to §1 ACTIONED with SHA c71a24b / merge 654d5c4, box-validated | ☐ |
> | 5 | "OPS-2 row in §1 ACTIONED table: MERGED b9a20cc; box 49/49. The row is accurate at line lev" — `docs/plans/DISPATCH.md:475` | OPS-2 correctly listed as MERGED at line 475. The §3a row 'PERF-12 auto-deliver N+1 — appl | **CODE-IS-BETTER** | Recount §3a — both PERF-12 and PERF-14 (OPS-2 follow-ups) should be promoted from BUILD to | ☐ |
> | 6 | "Row 11: OPS-2 job leader-lock + release-stale batch/lock \| multi-instance \| ✅ MERGED b9a" — `docs/plans/DISPATCH.md:40` | OPS-2 SHA b9a20cc is in HEAD; box 49/49 confirmed. The cell itself is accurate; the broade | **SUPERSEDED-BY** | Add a header note to the dispatch table: 'snapshot 2026-07-04; see REMAINING-WORK.md for c | ☐ |
> | 7 | "Migration 0037 (partial unique index) added. Not yet deployed to the box (still runs pre-m" — `docs/COMMERCE-GAP-ANALYSIS.md:29` | 0037 was fixed (c53bda2) to NULL Woo→Vendure 'imported' placeholder refs BEFORE the de-dup | **SUPERSEDED-BY** | Update COMMERCE-GAP-ANALYSIS.md line 29 to: 'Migration 0037 fixed (nulls imported placehol | ☐ |
> | 8 | "Jobs/queues: setInterval scheduler (auto-deliver, release-stale, webhook-reaper), dry-run " — `docs/COMMERCE-GAP-ANALYSIS.md:161` | OPS-2 (b9a20cc) added advisory-lock single-leader + SKIP LOCKED batched stale-release. PER | **CODE-IS-BETTER** | Update row 161 to: 'jobs scheduler + auto-deliver/release-stale/webhook-reaper; advisory-l | ☐ |
> | 9 | "SellRight is code-complete and box-validated: all 12 original lanes + all 21 §3a BUILD lan" — `docs/plans/REMAINING-WORK.md:3` | All 12 original lanes confirmed (verified SHAs are ancestors of HEAD 6848789). 'all 21 §3a | **stale-partial** | Tighten 'all 21 §3a BUILD lanes merged' to 'all 12 original + the merged §3a subset (REL-1 | ☐ |
> | 10 | "main is validated but not live — the box sellright-api still runs pre-merge dist/, and sel" — `docs/plans/REMAINING-WORK.md:8` | MONEY-1 fix (c53bda2) added 0037-nulls-imported so the migration is now safe. 0038 (email  | **verified-partial** | No edit needed — claim is accurate and dated 2026-07-05. Optional: add a 2026-07-14 note t | ☐ |
> | 11 | "mimo \| C+ \| Honest letter-graded readiness call; least evidence-dense and repeated a sta" — `rank.md:16` | Eval was at 2026-07-04 snapshot. The repeated stale finding (customer_token_hash_idx) was  | **stale** | Mark rank.md as a 2026-07-04 historical snapshot. The header already dates it; consider ad | ☐ |
> | 12 | "Stripe provider scaffolded; NMI/Sezzle are planned for DD parity" — `docs/ARCHITECTURE.md:17` | Stripe is fully implemented (createPayment/refundPayment/createPaymentIntent at payments/stripe.ts:122-158). NMI/Sezzle remain absent as doc says. | **CODE-IS-BETTER** | Update L17 to "Stripe implemented; NMI/Sezzle still absent" | ☐ |
> | 13 | "Critique of 20-destination flat nav as a sitemap" — `docs/ADMIN-REDESIGN-PLAN-2026-06.md:89` | Layout.tsx now groups nav into Run store / Catalog / Grow / Optimize. The plan's "sitemap" critique was correct at plan-time; the redesign addressed it. | **CODE-IS-BETTER** | Add a "Status: implemented" note to the §3 critique; the redesign landed (commit f23b7cc family) | ☐ |
> | 14 | "Aspirational quality bar" — `docs/ADMIN-REDESIGN-PLAN-2026-06.md:59` | "Market-leading operating tool" is unmeasurable; no code can prove it. The behavioral spec is buried in §3-§4. | **CODE-FELL-SHORT** | Reword to specific behavioral checks: empty/loading/error/disabled/validation/success/partial states (already listed at L64) | ☐ |
> | 15 | "Validation COMPLETE — all 12 lanes merged to origin/main (bff9e1d)" — `docs/plans/BOX-VALIDATION-CHECKLIST.md:3` | HEAD is 6848789 (58 commits past bff9e1d). MONEY-1 0037 (c53bda2), PERF-14/16, COMP-2 added lanes after this snapshot. | **SUPERSEDED-BY** `docs/plans/DISPATCH.md` | Add a "snapshot 2026-07-04" header to BOX-VALIDATION-CHECKLIST.md and link to DISPATCH.md | ☐ |
> | 16 | "MONEY-2 (0b4dee8) ⏳ pending" — `docs/plans/BOX-VALIDATION-CHECKLIST.md:11` | Merge MONEY-2 = 1947099 already on origin/main | **SUPERSEDED-BY** `docs/plans/DISPATCH.md` | Same: snapshot header + remove ⏳ markers, point at DISPATCH.md row | ☐ |
> | 17 | "MONEY-3 (b195602) ⏳ pending" — `docs/plans/BOX-VALIDATION-CHECKLIST.md:12` | Merge MONEY-3 = 5529ce6 confirmed | **SUPERSEDED-BY** `docs/plans/DISPATCH.md` | Same as #16 | ☐ |
> | 18 | "OPS-1 (bd53f62) ⏳ pending" — `docs/plans/BOX-VALIDATION-CHECKLIST.md:13` | Merge OPS-1 = b739ada confirmed | **SUPERSEDED-BY** `docs/plans/DISPATCH.md` | Same as #16 | ☐ |
> | 19 | "OPS-2 (2bc2f69) ⏳ pending" — `docs/plans/BOX-VALIDATION-CHECKLIST.md:14` | Merge OPS-2 = b9a20cc confirmed | **SUPERSEDED-BY** `docs/plans/DISPATCH.md` | Same as #16 | ☐ |
> | 20 | "SEC-6 (bcd74c1) ⏳ pending" — `docs/plans/BOX-VALIDATION-CHECKLIST.md:15` | Merge SEC-6 = 8e87c65 confirmed | **SUPERSEDED-BY** `docs/plans/DISPATCH.md` | Same as #16 | ☐ |
> | 21 | "SellRight is code-complete and box-validated: all 12 original lanes + all 21 §3a BUILD lan" — `docs/plans/REMAINING-WORK.md:3` | DISPATCH.md:498-521 lists only 12 merged. test:db 131 vs 88 (post-21-merge numbers conflict) | **CODE-FELL-SHORT** | Tighten to "all 12 original + the merged §3a subset (REL-1, PERF-2, PERF-12, PERF-14, OPS-1/2, MONEY-2/3, SEC-6)"; defer the unmerged 13 §3a lanes with explicit IDs | ☐ |
> | 22 | "Not deployed" — `docs/plans/DISPATCH.md:20` | MONEY-1/0037 resolved c53bda2 (added 0037-nulls-imported); migration now safe | **SUPERSEDED-BY** `docs/plans/REMAINING-WORK.md` | Replace "Not deployed" with "MONEY-1 resolved c53bda2; 0038 (email_outbox) and the box deploy remain hook-gated to Adrian" | ☐ |
> | 23 | "12 lanes on main bff9e1d 187/88 tests" — `docs/plans/DISPATCH.md:560` | REMAINING-WORK.md:3 has newer 131/215 numbers; HEAD is 6848789 (58 commits past bff9e1d) | **CODE-FELL-SHORT** | Update §1 DONE trailer to current HEAD + actual merged §3a subset | ☐ |
>
> **Authority order:** executable proof > current code > canonical docs > historical docs.
>

SellRight is an owned, multi-tenant commerce backend. It is designed to replace one-backend-per-brand ecommerce stacks with one TypeScript service, one admin, one Postgres schema, and a documented REST contract.

## Core Shape

| Layer | Choice |
|---|---|
| API | Hono + `@hono/zod-openapi`; versioned REST under `/v1`; OpenAPI at `/v1/openapi.json` |
| Runtime | Node.js, TypeScript, pnpm workspace |
| Data | Postgres + Drizzle, integer cents for money |
| Tenancy | `store` root entity, store-scoped tables, Postgres RLS via `app.current_store` |
| Admin | React + Vite + Tailwind/shadcn-style components |
| Storefront | Qwik SSR consumer; static catalog manifest plus dynamic REST |
| Payments | `PaymentProvider` interface; Stripe provider scaffolded; NMI/Sezzle are planned for DD parity |
| Email | Nodemailer SMTP with optional per-app sender and storefront URL routing |
| Jobs | In-process scheduled jobs today; Redis/BullMQ is a later scaling option |

## Repository Layout

```text
packages/
  api/         Hono API, Drizzle schema, migrations, jobs, imports, OpenAPI
  admin/       React admin SPA
  shared/      shared money primitives and types
  storefront/  Qwik SSR storefront consumer
docs/          product documentation
```

## Request Model

Every store-scoped request resolves a store, then runs database work through `withStore(storeId, fn)`.

`withStore` opens a transaction and sets `app.current_store` with `SET LOCAL`. RLS policies use that session value to confine reads and writes to one store. Route code must not import the unscoped database client for store-scoped tenant queries; the unscoped export is named `unsafeUnscopedDb`. An ESLint `no-restricted-imports` rule in `eslint.config.mjs` blocks it from route files. The legitimate unscoped callsites are: the global admin/ACL/Session tables, which are deliberately NOT store-scoped (they gate access TO stores). Those reads live in `packages/api/src/auth/admin-staff.ts` so route files stay as thin shells that import only `withStore` and helper functions; the Stripe webhook tenant-resolver (`payments/webhook-reconcile.ts`), which must look up the owning store from a PaymentIntent/subscription id *before* any store context exists (it returns only validated UUIDs, and subscription/invoice events that can't be resolved are retried, not silently scoped).

This gives SellRight two layers of tenant isolation:

1. Route-level store resolution.
2. Database-level RLS enforcement.

The verification gate includes `db:assert-rls`, `db:assert-hand-written`, and `assert:shop-isolation` so new store-scoped tables, drift on hand-written migrations, and public shop routes cannot silently bypass the model.

## API Surface

SellRight is REST-first, not GraphQL-first.

Main route groups:

| Area | Examples |
|---|---|
| Health and contract | `/v1/health`, `/v1/openapi.json` |
| Catalog | products, collections, search, stock, static manifest generation |
| Cart and checkout | cart rows, server-priced checkout, shipping/tax/promo validation |
| Payments | payment intents, `/pay`, Stripe webhook receiver |
| Auth/account | register, login, Google auth, sessions, password reset, email verification, customer profile, addresses |
| Orders | customer orders, admin order operations, draft orders, refunds, returns |
| Admin | catalog, customers, staff, settings, reports, tax, locations, gift cards, webhooks, affiliates, blog, assets |
| App licensing | app license activation, update manifests, licensed downloads |

## Data Model

The schema is a full commerce schema rather than a thin catalog API. It includes:

- Store registry and admin-user-to-store membership.
- Catalog: products, variants, options, collections, assets, inventory, locations.
- Customers: identity, sessions, addresses, customer tokens.
- Orders: order snapshots, lines, payments, refunds, returns, fulfillments.
- Commerce rules: promotions, gift cards, shipping methods, tax zones, currency rates.
- Operator tools: blog posts, webhooks, affiliates, reports, staff invites, activity.
- Software sales: licenses, activations, app releases, download artifacts.

Most business tables are store-scoped. Shared registry tables that intentionally cross stores are documented and excluded from FORCE RLS only when needed.

## Money Path

The money path follows five rules:

1. Store money as integer cents.
2. Compute totals server-side.
3. Treat client prices, shipping, discounts, and tax as suggestions only.
4. Use idempotency keys around payment-sensitive operations.
5. Record state changes and side effects so retries do not double-charge, double-refund, or double-issue.

Current money modules cover totals, tax, discounts, gift cards, currency rates, order state, invoice generation, and stock reservation.

## Catalog Read Path

The preferred browse path is a static catalog manifest:

- `shop-catalog.json` for listing/search primitives.
- Per-product detail files for product pages.
- Dynamic REST remains available for account, checkout, live stock, and admin.

This keeps storefront browsing cheap and fast while preserving a transactional backend for money and account flows.

## Security Model

Built-in controls:

- Postgres RLS with FORCE assertions.
- Dedicated non-owner app role support.
- Admin and shop CSRF guards for cookie-backed mutation requests.
- Rate limiting for sensitive auth and checkout paths.
- Password reset and email verification token tables.
- TOTP replay guard.
- Webhook idempotency.
- Import TRUNCATE guard.
- No raw card handling in the intended payment architecture.

## Deployment Model

SellRight can run as one API process plus one static admin build. The current production-oriented deployment path uses:

- compiled API entrypoint from `packages/api/dist`;
- environment files outside git;
- PM2 or systemd-compatible scripts;
- nginx in front of API/admin;
- Postgres on the native service port for SellRight databases;
- backup scripts and restore drills as a launch gate.

Email is configured in `packages/api/.env`; see [Email Delivery](EMAIL.md) for
SMTP, Vendure Gmail aliases, and shared-store per-app sender routing.

## Verification Gate

After API changes, run:

```bash
pnpm verify
```
The gate builds all packages, type-checks, runs API tests, asserts FORCE RLS coverage, asserts hand-written-migration markers, and checks shop-route isolation.

## Migrations

See [runbooks/migrations.md](runbooks/migrations.md) for the rule on
hand-written migrations (currently `0032_cart_ttl.sql`,
`0034_subscriptions.sql`, `0036_harden_subscription_rls.sql`). The
`db:assert-hand-written` script enforces the rule in CI.

Postgres runtime-role timeouts and per-service `application_name` configuration
are maintained in [runbooks/postgres-app-role.md](runbooks/postgres-app-role.md).

---

# Blueprint Phase 2-3 Output

## Verified Facts (Phase 2)

_17 claims verified against code with file:line evidence (28 of 97 total claims had verifiable code refs). The other 69 are plans/aspirations — unverifiable from code alone._

### docs/ADMIN-REDESIGN-PLAN-2026-06.md

- L64: EmptyStateActionPanel/Loading/ErrorState/Spinner/Skeleton+InlineAlert tones cover empty/loading/error; success tone + bulk-result panel; disabled attr on btns.

### docs/ADMIN-THEME-SYSTEM.md

- L36: No hardcoded bg-red-50/amber-50/emerald-50/amber-100 in candidate files; only bg-gray-50 neutrals remain. (ErrorBoundary.tsx:17 still has bg-red-50 — low-traffic, as doc says.)
- L38: 6 WOFF2 files present (3 families × latin + latin-ext); fonts.css declares them as self-hosted; tailwind.config.js:31-33 wires all three families.

### docs/ARCHITECTURE.md

- L43: The verify script invokes all three named assertion gates.

### docs/plans/2026-06-20-cart-architecture.md

- L118: 0032 is a custom hand-written migration with the required marker and documented snapshot-drift rationale.

### docs/plans/2026-06-20-checkout-migration.md

- L33: Server-priced cart-token checkout, Stripe Payment Element, idempotent PI, and webhook-authoritative flow are implemented.

### docs/plans/2026-06-20-order-management-bulk-ops.md

- L3: Admin exposes bulk cancel, trash, restore, and permanent purge with shared per-order results.
- L36: All four layered operations exist; order.deletedAt is implemented in schema-orders.ts:67.
- L37: Purge unlinks gift-card, stock, cart, and newer subscription back-refs; FK coverage guard exists at bulk test line 337.

### docs/plans/2026-06-20-subscriptions.md

- L35: onInvoicePaid dispatches to settleFirstCycle (existing applyPaymentResult path); routes/subscriptions.ts:72-80 creates backing PendingPayment order with subscription metadata.
- L86: Hand-written 0034 creates TYPE subscription_status, subscription table with FORCE RLS + tenant_isolation policy + product_variant stripe_price_id/billing_interval columns. Journal entry present, HAND-
- L193: onInvoicePaid findSubBySubId then creates row from invoice.subscription_details.metadata if absent — never assumes checkout.session.completed ran first. Test subscriptions.test.ts:240 confirms.
- L230: resolveStoreIdForSubscriptionEvent is DB-primary: tries subscription row by stripeSubscriptionId BEFORE subscription_details.metadata (bonus). payment-webhooks.ts:72 returns 503 on unresolvable subscr
- L232: settleFirstCycle writes auditLog action 'subscription_amount_mismatch' when invoice.amount_paid != null && invoice.amount_paid !== order.grandTotal; data carries invoiceId, amountPaid, grandTotal.

### docs/runbooks/admin-a11y.md

- L75: axe runs WCAG 2.0/2.1 A+AA and best-practice tags, covering the stated accessibility-rule classes.
- L76: The general axe rules remain enabled, while color-contrast is explicitly omitted through RULES_TO_OMIT.
- L77: The selected WCAG and best-practice axe rules include dialog/focus and image-alt checks unless explicitly omitted.


## Contradictions (Doc-vs-Code Traps)

_4 stale findings — the highest-value signal blueprint produces. These are docs that claim X while the code does Y; the next agent that reads the doc and trusts it will get it wrong._

- **docs/ADMIN-REDESIGN-PLAN-2026-06.md:89** — Doc describes pre-redesign flat nav as a 'sitemap'; Layout.tsx now groups into Run store/Catalog/Grow/Insights/Configuration — the violation no longer exists.
- **docs/ARCHITECTURE.md:17** — PaymentProvider and Stripe are fully implemented, not merely scaffolded; NMI/Sezzle remain absent.
- **docs/plans/2026-06-20-cart-architecture.md:255** — Both phases now exist: backend Phase A and flagged Phase B server-cart UX swap are implemented.
- **docs/plans/2026-06-20-order-management-bulk-ops.md:369** — Implementation is complete, but endpoints moved to admin-order-ops.ts and purge now also handles subscription; the plan's file claim is outdated.


## Coverage Gaps (missing or partial flows)

| Flow | Status | Impact | Existing primitives | Handoff |
|---|---|---|---|---|
| cart-add (server-cart UX) | partial | Cart UX does not always reflect server authoritative price/stock until checkout; potential pre-checkout price drift | packages/storefront/src/services/ServerCartService.ts; routes/cart.ts priceCart | architect |


## Top Health Findings

| Rank | Area | Finding | Evidence |
|---|---|---|---|
| 1 | tests | Sequential awaits inside checkout.ts withStore transaction â€” Promise.all opportunity in 8 independent reads | packages/api/src/routes/checkout.ts:168,187,197,214,258,310,347,351 |
| 2 | size | 8 admin-order routes in one 401-LOC file (admin-orders.ts); pairing with admin-order-ops.ts (377 LOC) creates a 778-LOC split | packages/api/src/routes/admin-orders.ts:46..381 + packages/api/src/routes/admin- |
| 3 | duplication | Three checkout forms (AddressForm 416 / BillingAddressForm 406 / Shipping 407 LOC) share the same sequential qinit pattern (perf-10) | packages/storefront/src/components/address-form/AddressForm.tsx + packages/store |
| 4 | size | admin.ts (384 LOC) mixes auth bootstrap (login/logout/me) with order lifecycle â€” three responsibilities in one file | packages/api/src/routes/admin.ts:23,60,77,92,130,169,251,350 |
| 5 | tests | Discounts/coupons pure helpers (money/coupon.ts, money/auto-discount.ts) sit at the money/* edge with thin tests; coupon.ts itself has no colocated test | packages/api/src/money/coupon.ts + packages/api/src/money/auto-discount.test.ts  |
| 6 | error-handling | Stripe SDK has no explicit per-call timeout â€” outage hangs request threads (perf-17) | packages/api/src/payments/stripe.ts:1 + packages/api/src/routes/checkout.ts Stri |
| 7 | size | apps.ts (390 LOC) carries RightApps distribution cross-venture surface in product repo per split rule | packages/api/src/routes/apps.ts:71,169,221,330,372 (5 routes) |
| 8 | tests | Licensing issuance seam (licensing/issue.ts) has no dedicated test despite being a critical boundary | packages/api/src/licensing/issue.ts (sibling files activations.test.ts / tokens. |
| 9 | size | admin-catalog.ts (388 LOC, 15 routes) still bundles products/variants/inventory/options after admin-products.ts split | packages/api/src/routes/admin-catalog.ts:12,34,58,73,97,154,179,213,232,245,264, |
| 10 | performance | Missing partial indexes on webhook_delivery + email_outbox scheduler tables (perf-04) â€” outbox pattern degrades linearly | packages/api/src/db/schema-orders.ts:282 + :302 |


## Security Synthesis

**Trust boundaries:** 7 (admin auth, storefront public, Stripe webhook, license-gate download, app-update, RLS row-scope, unscoped-db escape hatch)
**Secrets tracked (redacted):** 16
**Injection surfaces defended:** 18
**Authz surfaces:** 13
**Data protection entries:** 15
**Dangerous patterns flagged:** 12

**Posture:** Stripe-only payment path with Payment Element (PCI SAQ-A delegated to Stripe.js); cookie-based admin/customer auth layered with httpOnly session + non-httpOnly double-submit CSRF + TOTP 2FA + 8-fail/15-min login throttle + per-IP payment rate limit; RLS on ~40+ store-scoped tables (ENABLE + FORCE) with `SET LOCAL app.current_store` per request and a documented unsafeUnscopedDb escape hatch lint-blocked from src/routes; import scripts guarded by DB-name check + --force + ALLOW_FORCE_TRUNCATE=1; Stripe webhooks HMAC-verified with mode-bind and processed_event idempotency claim; outbound HTTP/SSRF mitigated by safeOutboundFetch (no private/loopback DNS, no credentials, no redirects); licensed downloads gated by bearer license-key in Authorization header (NOT query) with short-lived HMAC-signe


## Maturity Verdict

**Overall:** B+ — current HEAD `6848789`

**Solid scorecard:**

| Dimension | Weight | Score | Rationale |
|---|---|---|---|
| observability | 5 | 4 | pino + requestId + readyz + audit_log are all wired and gate-covered; only gap is multi-instance in-memory throttles. |
| resilience | 5 | 5 | FORCE RLS + withStore txn + idempotency keys + SKIP-LOCKED + advisory lock + partial unique index = the money path is hardened end-to-end. |
| config-env | 4 | 5 | zod fail-fast parse at module load; documented dev-vs-prod defaults; no defaults pointing at prod. |
| testing | 5 | 5 | Two-lane vitest + three custom verify gates + RLS table-driven loop + checkout/idempotency tests; box-validated 215+88 green. |
| ci-cd | 4 | 4 | verify.yml runs full verify + dep audits; admin/storefront pnpm audit; pinned action SHAs. No matrix OS, no deploy step (out of scope here). |
| performance | 3 | 4 | Static manifest + PERF-2 cache + SKIP-LOCKED batching + pinned DNS lookup; cursor pagination deliberately YAGNI. CDN/signed-URL gap is produ |
| scalability | 3 | 3 | OPS-2 makes the scheduler multi-instance-safe, but rate-limit + login throttle + store-context cache + TOTP replay are per-process Map; expl |
| data-lifecycle | 4 | 5 | Hand-written-migration marker enforced in CI; TRUNCATE guarded by both URL regex and env+flag; transactional outbox for email + webhooks. |
| onboarding | 3 | 4 | CLAUDE.md/AGENTS.md/ARCHITECTURE.md/runbooks are all present and current; the dispatch ledger accounts for ~150 audit findings explicitly. |
| accessibility | 2 | 3 | axe is wired with WCAG 2.0/2.1 A+AA tags + best-practice; gated to QA mode + runbook documented. Still no automated CI gate and color-contra |
| licensing | 2 | 4 | LICENSE file present, deps audited in CI via shared tooling; no automated SPDX SBOM step yet. |

**Human gates remaining:** box deploy (sellright_dev 0037 + journal drift), RightApps merge (10 conflicts)

_All 5 Phase-2 dimensions complete. 14 flows classified, 1 coverage gap, 8 capability coverage rows. Last refreshed: 2026-07-14T13:55:00Z_
