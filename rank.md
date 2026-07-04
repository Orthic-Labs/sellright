# Model Ranking — SellRight Migration-Readiness Audit (2026-07-04)

Six models (deepseek, qwen, kimi, minimax, glm, mimo) each audited this repo for live-store migration readiness. This ranks them **on the quality of that audit**, not on general reputation. The grade is `correctness × depth × novelty × actionability`, measured by re-verifying their load-bearing claims against the actual code at commit `25c4b35`.

Verification is the key input: 22 of their most load-bearing claims were checked line-by-line. **20 confirmed, 1 partial (a HIGH that RLS actually blocks), 1 largely refuted (3 of 4 "missing" indexes exist).** Which model made the wrong claims is what separates the top from the middle.

## Ranking

| # | Model | Grade | One-line skill profile |
|---|---|---|---|
| 1 | **glm** | A | The auditor's auditor — verified the repo's own gap-doc against code, found the subtle money-path races nobody else did, zero false positives. |
| 2 | **minimax** | A− | Best-structured readiness call — clean A1–A4 blocker framing, honest tiers, benchmark discipline, every finding correct. |
| 3 | **qwen** | B+ | Highest yield of *novel real* bugs (admin-logout CSRF, blog XSS) and the only one to audit the frontend — docked for two over-claims. |
| 4 | **kimi** | B | Strong honest synthesis + competitive scorecard; accurate; lighter on original bug-finding. |
| 5 | **deepseek** | B− | Comprehensive comparison matrices and the only real GDPR/PCI-compliance lens; accurate but tabular, shallow on code. |
| 6 | **mimo** | C+ | Honest letter-graded readiness call; least evidence-dense and repeated a stale finding already fixed in a migration. |

---

## Why, in detail

### 1. glm — A

The only model that **treated the repo's self-authored `COMMERCE-GAP-ANALYSIS.md` as hypotheses and re-verified each against code** rather than trusting it. That single move is what a real auditor does.

Depth wins: glm's money-path agent found the two subtle, genuinely dangerous bugs that most models missed —
- **Duplicate payment-ledger row on the `/pay` vs webhook race** (`settle.ts:31` inserts the payment row *before* the `canTransition` guard at `:41`, and there is **no unique index on `(store_id, provider_ref)`** anywhere in `drizzle/`). Verified: confirmed.
- **`refunds.create` with no `idempotencyKey`** (`stripe.ts:145`) → double-refund on retry. Verified: confirmed (the paymentIntent path at `:169` *does* pass one; the refund path does not).
- **Draft `markPaid:true` never issues licenses** (`admin-order-ops.ts:64` inserts a Settled manual payment but never calls `issueLicensesForPaidOrder`). Verified: confirmed. A silent, high-value bug for a software store.

Its security agent produced the deepest SSRF write-up — the newsletter Listmonk path (`shop-extra.ts:128`) bypasses `safeOutboundFetch`, framed correctly as **DNS-rebinding + credential exfil + unauthenticated amplification**, not just "unvalidated URL." It also independently found the cross-store idempotency-key collision (M-1) and the RBAC-only-2-of-N gap (H-3), both confirmed.

Crucially, glm made **none of the false-positive claims** the perf-focused models made. Its verdict ("GO-WITH-CONDITIONS" gated on four specific hard blockers) is precise and defensible.

### 2. minimax — A−

The best-*organized* audit and the one I'd hand to a stakeholder. Its A1–A4 hard-blocker framing (host routing, CORS, multi-instance rate-limiter, checkout-behind-flag) maps exactly to reality — all four verified confirmed:
- **A1 host routing** — `store-context.ts` literally comments "in production this maps a host/subdomain to a store" but the code just does `header ?? 'damned'`. Confirmed, no such code exists.
- **A2 CORS** — zero matches for `cors|Access-Control` in `packages/api/src`. Confirmed.
- **A3 in-process rate-limiter + `setInterval` scheduler** — confirmed.
- **A4 `VITE_SR_CHECKOUT` defaults off, storefront `package.json` still says "built with Vendure"** — confirmed verbatim.

It practices **benchmark discipline** — every gap is stated against Shopify/Vendure behavior, which makes the severity calls credible. It found the idempotency collision and the Stripe-webhook tenant-trust nuance. Slightly less deep on the concurrent money-path races than glm (it flagged the pool/lock exposure but glm nailed the exact duplicate-row mechanism), which is the only reason it's second.

### 3. qwen — B+

Ran the widest sweep — a pentest-style security pass **plus** performance **plus** a full **frontend** audit (the only model to look at the storefront/admin UI, a11y, i18n, CSP). It produced the **most novel true-positives of any model**:
- **CRIT-01: admin logout has no CSRF check** (`admin.ts` logout vs `auth.ts:234` customer logout which *does* call `customerCsrfValid`). Verified confirmed — **nobody else caught this.**
- **CRIT-02: blog body stored into `bodyHtml` unsanitized, served to public** (`admin-content.ts:47,89`). Verified confirmed.
- Frontend a11y depth (missing `<label>`s in checkout, broken skip-link) that no other model attempted.

Docked from the A tier for **two over-claims** — exactly the kind an auditor must not make:
- **HIGH-04 "cross-tenant customer session confusion"** — claimed a Store-A token under `x-store-slug: store-B` grants access to Store B. **Refuted:** `resolveCustomer` (`session.ts:41`) has no `storeId` filter (literally true), *but* its `innerJoin` to the RLS-scoped `customer` table (`:54`) returns zero rows under the wrong store's context, so the token resolves to null (guest), not cross-tenant access. RLS is the backstop qwen missed. Calling this HIGH is a false alarm.
- **The "Missing Indexes" table** — claimed `cart(token)`, `customer(store_id,email)`, `variant(store_id,sku)` all missing. **Refuted:** all three exist (`0005_cart_tables.sql`, `0000`, `0000`). Only `order(store_id,code)` is genuinely absent. 3 of 4 wrong.

Elite bug-finding, let down by insufficient verification of its own claims.

### 4. kimi — B

A clean, honest synthesis with a genuinely useful competitive scorecard (per-domain A–D grades vs Shopify/Woo/Vendure) and a correct "controlled brand-by-brand migration, not big-bang" verdict. Everything it asserted checked out. It reads more like an experienced consultant *summarizing* the landscape than an auditor *finding* new defects — it re-surfaced the known gaps (Stripe-only, in-process rate-limit, storefront DNA) accurately but contributed little that the repo's own gap-doc didn't already have. Solid, safe, less incisive.

### 5. deepseek — B−

The most comprehensive *comparison matrices* (Security / Performance / Architecture / Commerce / DevOps / Testing / GDPR) and the **only model to seriously raise compliance** — GDPR data-export/deletion endpoints and PCI SAQ-A attestation, both real and both genuinely missing. That compliance lens is its unique contribution. But the body is tabular and generic: it rarely cites `file:line`, leans on "Shopify has X, SellRight doesn't" checklists, and does little code-level bug discovery. Accurate breadth, thin depth.

### 6. mimo — C+

Honest and well-shaped — letter grades per area (B+/A−/C+/C/D+) with a P0/P1/P2 action list, and a correct "not ready for a full cutover" call. But it's the **least evidence-dense** (grades over quotes), largely re-derives what the stronger models and the gap-doc already established, and it **repeated a stale finding**: "`customer_token_hash_idx` commented out → seq scan on every password reset." **Refuted** — it was re-added in migration `0023_customer_tokens.sql`. Auditing against a snapshot the code had already moved past is the exact failure mode that drops it to last.

---

## Verification ledger (the 22 load-bearing claims)

| # | Claim (abbrev.) | Verdict | Evidence |
|---|---|---|---|
| 1 | Newsletter Listmonk fetch bypasses SSRF guard, no rate-limit | ✅ CONFIRMED | `shop-extra.ts:128` raw `fetch`, no `safeOutboundFetch`; route `:110` no `clientIp` |
| 2 | `clientIp` trusts `cf-connecting-ip` unconditionally | ✅ CONFIRMED | `rate-limit.ts:51` |
| 3 | `requirePermission` enforced at only 2 sites | ✅ CONFIRMED | `admin-marketing.ts` (giftcards), `admin-settings-advanced.ts` (webhooks) |
| 4 | `/pay` claimKey lacks storeId; global RLS-exempt PK | ✅ CONFIRMED | `pay.ts:65`; `schema-content.ts:33` `id: text().primaryKey()`; `assert-force-rls.ts:20` exempt |
| 5 | `createPayment` awaited inside `withStore` txn | ✅ CONFIRMED | `pay.ts:55`→`:73` |
| 6a | Refund path holds row lock across gateway call | ✅ CONFIRMED | `admin-orders.ts:173` `.for('update')` → `:204` gateway |
| 6b | Return-approve path takes no lock | ✅ CONFIRMED | `admin-orders.ts:309` `.limit(1)` no `.for('update')` |
| 7 | `refunds.create` passes no idempotencyKey | ✅ CONFIRMED | `stripe.ts:145` (vs `:169` which does) |
| 8 | `settle` inserts payment before FSM guard; no unique `(store_id,provider_ref)` | ✅ CONFIRMED | `settle.ts:31` before `:41`; no unique index in `drizzle/` |
| 9 | Draft `markPaid` never issues licenses | ✅ CONFIRMED | `admin-order-ops.ts:64` |
| 10 | No host→store routing; falls back to `'damned'` | ✅ CONFIRMED | `store-context.ts` |
| 11 | No CORS middleware | ✅ CONFIRMED | zero `cors\|Access-Control` in `packages/api/src` |
| 12 | Admin logout lacks CSRF check | ✅ CONFIRMED | `admin.ts:61` logout vs `auth.ts:234` customer |
| 13 | Blog HTML stored/served unsanitized | ✅ CONFIRMED | `admin-content.ts:47,89` |
| 14 | Cross-tenant customer session access | ⚠️ PARTIAL | `session.ts:41` no storeId filter (true) BUT `:54` customer RLS join blocks the exploit (conclusion refuted) |
| 15 | `csrfValid` bypassed by any `authorization` header | ✅ CONFIRMED | `cookies.ts:57,81` |
| 16 | `Secure`/error-expose gated on `NODE_ENV` | ✅ CONFIRMED | `cookies.ts:42,68`; `app.ts:97` |
| 17 | `release-stale` no locks + N+1 line reads | ✅ CONFIRMED | `release-stale-allocations.ts:45,48` |
| 18 | 4 missing indexes (cart token / order code / customer email / variant sku) | ❌ MOSTLY REFUTED | cart(token) `0005`, customer(store,email) `0000`, variant(store,sku) `0000` all EXIST; only `order(store_id,code)` missing; `customer_token_hash_idx` re-added in `0023` |
| 19 | Download 302-redirects to arbitrary `artifact.path` | ✅ CONFIRMED | `apps.ts:300` |
| 20 | pnpm version mismatch root vs CI | ✅ CONFIRMED | `package.json` `pnpm@11.9.0` vs CI `corepack prepare pnpm@10.34.1` |
| 21 | `VITE_SR_CHECKOUT` off by default; storefront still "Vendure" | ✅ CONFIRMED | `providers/shop/checkout/checkout.ts`; `package.json:3` |
| 22 | `withStore` READ COMMITTED; pool max 10; connect timeout 0 | ✅ CONFIRMED | `client.ts:44`; `env.ts:25,27` |

**Bottom line:** on this task, glm and minimax are the two you'd trust to sign off a migration. qwen is the one you'd want *also* in the room for the novel bugs — but with a second pass to strip its false alarms.
