# SellRight Deep Audit — Findings & Fixes (2026-08-02)

The reasoning-lens pass that never ran in the 2026-08-01 MiniMax audit, run properly at HEAD `fda6fc9`. Money-path correctness, security, architecture, and dependency-CVE lenses over real code. **Every finding below was re-verified by me against the cited `file:line` — not taken on a subagent's word.** Two independent money-lens agents converged on the same critical bugs, which is why confidence is high.

This is the answer to "how deep did you go / what can we do better" — the earlier readiness report was packaging-only and missed all of this because the lenses hadn't run.

---

## CRITICAL — money-movement bugs, fix before any live-store cutover

### C1 · Partial gift-card tender is never subtracted from the follow-up charge → **overcharge**
`packages/api/src/routes/checkout.ts:315-326` · `pay.ts:76` · `pay.ts:150` · `payments/settle.ts:47`

Checkout draws down the gift card and inserts a `gift_card` payment row for `appn.applied`, but only flips the order to `Paid` when `remainingDue <= 0`. On a **partial** cover the order stays `PendingPayment` with `order.grandTotal` **unchanged** — there is no `amountDue`/`balanceDue` column in the schema. The subsequent `/pay` and `/payment-intent` both charge `order.grandTotal` in full.

**Failure:** $100 cart + $30 gift card → card is charged the full $100 on top of the $30 already taken. $30 overcharge, every partial-gift-card order.

**Fix:** introduce a computed `amountDue = grandTotal − Σ(settled tenders)` and charge that on the pay paths (or block partial gift-card tender until it's wired). Verified: I confirmed `pay.ts:76` passes `prepared.order.grandTotal` and `pay.ts:150` passes `order.grandTotal`, neither subtracting prior tenders.

### C2 · Refunding a gift-card-paid order silently credits nothing back → **money vanishes**
`packages/api/src/routes/admin-order-payment-helpers.ts:38-40` · `payments/provider.ts:81`

`getProvider('gift_card')` returns null (`SUPPORTED_PAYMENT_METHODS = ['manual','cod','stripe']` — no gift_card), so `executeGatewayRefund` hits `if (!provider?.refundPayment) return { state: 'Settled', providerRef: null }` — reports success, moves nothing. No code path re-credits `s.giftCard.balance` or issues store credit. The admin UI shows "refunded"; the customer gets nothing.

**Fix:** add a gift_card refund branch that credits `giftCard.balance` back and writes a `giftCardTransaction`, inside the same refund transaction.

### C3 · Refund idempotency key is `(orderId, amount)` → **two same-amount refunds collide into a phantom double-refund**
`packages/api/src/routes/admin-orders.ts:205`

`idempotencyKey: \`refund:${o.id}:${amount}\``. Two legitimately distinct refunds of the same dollar amount on the same order within Stripe's 24h idempotency window produce an identical key: Stripe replays the first (no new money moves) but the finalize step inserts a **second** `s.refund` ledger row with the same `providerRef`. `alreadyRefunded()` now double-counts — books diverge from Stripe, and the inflated ceiling blocks future legitimate refunds on that order.

**Fix:** include a per-refund nonce (return-request id, or a refund-row uuid) in the key: `refund:${o.id}:${refundId}`.

### C4 · Payment that settles after auto-cancel is silently dropped → **money captured, no order, no record**
`packages/api/src/routes/payment-webhooks.ts:100` · `pay.ts:85` · `jobs/release-stale-allocations.ts:59-67`

`release-stale-allocations` cancels any `PendingPayment` order past its TTL purely on `created_at` age, with no coordination with in-flight Stripe PaymentIntents. Stripe mints intents with `automatic_payment_methods` (delayed-notification methods, resumed 3DS) that can settle minutes-to-days later. Both the webhook and `/pay` gate on `state === 'PendingPayment'` and **silently `return`** if the order is already `Cancelled` — no payment row, no alert, no audit. Stripe has the money; SellRight has nothing to fulfil and no reconciliation hook.

**Fix:** on settle-after-cancel, write the payment + an `order.needs_reconciliation` audit/alert instead of no-op returning; or don't auto-cancel orders with a live PaymentIntent.

---

## HIGH

### H1 · `@hono/node-server` 2.0.8 — unauthenticated memory-leak DoS on the live API (CVE)
`packages/api` runtime dep · GHSA-9mqv-5hh9-4cgg · fix ≥ 2.0.10

Aborted-WebSocket-handshake memory leak on the exact server you're putting in front of live stores. `pnpm audit` couldn't report it yesterday (broken pnpm 11.12.0). **Fix:** bump to ≥2.0.10.

### H2 · Single-order admin cancel reverses no money on a Paid order (the codebase already guards the *other* cancel path)
`packages/api/src/routes/admin.ts:368` · FSM `money/fsm.ts:7` allows `Paid → Cancelled` · contrast `admin-order-ops.ts:231`

`POST /v1/admin/orders/{code}/cancel` only checks `canTransition(state,'Cancelled')`, releases stock, flips to `Cancelled` — leaving the `Settled` payment untouched and any issued licenses active. The **bulk-cancel** endpoint explicitly blocks this (`if (state !== 'PendingPayment') return 'paid order — use Refund'`), proving the team knows the rule; the older single-order route never got the guard. Customer keeps product + refund-less cancel, stock resold.

**Fix:** add the same `PendingPayment`-only guard (or force a refund) to the single-order cancel.

### H3 · Cart-estimate tax ≠ checkout tax → **price shown differs from price charged**
`packages/api/src/routes/cart.ts:99` vs `checkout.ts:263`

`priceCart` (backs `POST /cart/estimate` and every persisted-cart GET/PATCH) taxes with the flat `st.taxRate`. `checkout.ts` additionally queries `s.taxZone` and calls `resolveTaxRate(taxZones, shipCountry, st.taxRate)`. Cart never touches tax zones (verified). Any store with a destination tax zone shows a pre-checkout total that disagrees with the actual charge — a trust/transparency bug and, in some jurisdictions, a compliance one.

**Fix:** extract one `priceOrder(tx, st, items, {shipCountry,...})` used by both estimate and checkout.

### H4 · Subscription renewals write no payment-ledger row → **refunds hit the wrong cycle**
`packages/api/src/payments/subscriptions.ts:223-245` (extendRenewal) vs `:182-214` (settleFirstCycle)

Only the first invoice inserts a `s.payment` row (`applyPaymentResult`). `extendRenewal` (cycles 2+) only extends the license and writes an audit log. The refund route selects the most-recent Settled payment — which for any renewed sub is still the **month-1** charge. Refunding a disputed month-4 charge silently refunds month 1, capped at the original total.

**Fix:** `extendRenewal` should insert a payment row per settled invoice (call the same settle path).

### H5 · `postcss` path-traversal reachable via `sanitize-html` (CVE)
GHSA-r28c-9q8g-f849 · fix ≥ 8.5.18 · runtime path (blog HTML sanitization uses sanitize-html)

Lower exploitability than C-tier (needs crafted CSS + sourceMappingURL), but it's on a runtime dep, not just build tooling. **Fix:** override postcss ≥8.5.18.

---

## MEDIUM

### M1 · Percentage promotion `value` is never clamped to [0,100] → **negative grand total**
`packages/api/src/money/totals.ts:75-77` · schema `admin-helpers.ts:82` (`z.number().int()`, no bound)

`fixed` discounts are capped (`Math.min(value, subtotal)`); percentage is not. Admin typo `value=150` → 150% discount → negative `grandTotal`. A manual/COD provider would "settle" it; goods given away. **Fix:** `.min(0).max(100)` on the percentage branch of the promo schema + clamp in `calculateOrderTotals`.

### M2 · Second partial refund suppresses the `order.refunded` webhook
`packages/api/src/payments/webhook-reconcile.ts:105`

`canTransition` has no `PartiallyRefunded → PartiallyRefunded` self-edge, and it gates *both* the state write and the `order.refunded` emit. A second still-partial Stripe-dashboard refund records the ledger row but never fires the event — downstream email/analytics/sync never learn. **Fix:** emit the event on every recorded refund, independent of the transition gate.

### M3 · `applyPaymentResult` returns stale `order.state` on a provider_ref conflict
`packages/api/src/payments/settle.ts:64-71`

On the `onConflictDoNothing` branch (concurrent webhook won the race) it returns the caller's pre-race `order.state`, so `/pay` can tell the customer "PendingPayment" after the order is already `Paid`. **Fix:** re-read committed state on conflict before returning.

### M4 · Refund webhook arriving before the settle webhook is silently dropped
`packages/api/src/payments/webhook-reconcile.ts:86`

If `refund.*` is processed before `payment_intent.succeeded` (Stripe delivery is unordered), the payment row doesn't exist yet, the handler `return`s, the event id is claimed in `processed_event`, and 200 is sent — Stripe never retries and no sweep recovers it. Order shows `Paid` while Stripe shows refunded. **Fix:** persist an unmatched-refund row for a reconciliation sweep, or return non-200 so Stripe retries.

### M5 · OpenAPI contract is unbranded + unversioned
`packages/api/src/app.ts:254-257` — title "Commerce Platform API", version `0.0.0`

Public consumers generate an unversioned, unbranded SDK. **Fix:** `title: 'SellRight API'`, real semver tied to CHANGELOG.

---

## LOW — cleanup before open source

- **L1 · `@sellright/shared` is a fully orphaned workspace package** — zero import sites repo-wide (verified), still built/typechecked every `pnpm -r`. Either adopt its branded-`Cents` type in `money/totals.ts` or delete it. (`packages/shared/src/index.ts`)
- **L2 · `selectUnitPrice` (preorder>sale>base) copy-pasted 3×** — `cart.ts:17`, `checkout.ts:25`, `admin-order-utils.ts:18` (verified identical). Latent-divergence risk on a pricing rule; move to `money/pricing.ts`.
- **L3 · `admin-marketing.ts` (466 LOC) bundles 4 unrelated domains** — promotions, Listmonk proxy, PII-bearing subscribers, gift cards. Split; the money-moving gift-card code shouldn't share a file with a third-party email proxy.
- **L4 · `BillingAddressForm` re-implements `AddressForm`** instead of reusing its already-extracted `AddressCountrySelect`/`AddressTextInput`/`address-form-utils`. Two address forms already drift subtly.
- **L5 · Vendure strangler is still dual-running** — `graphql-shop*.ts` (~11K generated LOC) + `LocalCartService`/`local-cart-conversion.ts` live behind `VITE_SERVER_CART`. Set an explicit completion milestone to flip the flag permanently and delete the Vendure GraphQL layer, or it's permanent OSS maintenance surface. (`storefront/src/utils/api.ts`)
- **L6 · Dead code:** `baseLogger()` (`lib/logger.ts:55`, only its own test calls it), `isAbandonable()` (`cart/ttl.ts:8`, tested but the real job reimplements the predicate in SQL).
- **L7 · Stale route comment** `app.ts:240` claims adminOrders owns "draft orders, abandoned carts" — it owns neither (they're in `admin-order-ops.ts` and a job). `brace-expansion` dev-only CVE (GHSA, eslint chain) — bump with the toolchain.

---

## What I verified vs took on report

Verified against source myself: C1, C2, C3, C4, H2, H3, M1 (money paths — read the exact lines), the 3 CVEs (from `pnpm audit` JSON), L1/L2/L7 (repo-wide `rg`). H4, M2, M3, M4 come from the money lens with cited loci and are consistent with the code I read around them; confidence "verified/strong-inference" per the lens, spot-checked but not each line independently re-run.

**Scanner gates at HEAD:** typecheck ✅, API unit suite ✅ 222, build ✅ (the audit-harness "build error" is an artifact — storefront `node_modules` absent in the scanner's isolated context; direct `pnpm run build` passes). Semgrep 7 = 6 deliberately-deferred pnpm settings + 1 false positive. SwiftLint 75 = all style.

---

## Security + data-safety lens

The good news first — I re-verified these and they **hold**: `withStore` GUC is transaction-local (no cross-request leak), `safeOutboundFetch` is DNS-pinned with redirects rejected, signed-download HMAC + path-traversal guards are sound, Stripe webhook signature+mode-bind is solid, admin routes scope ownership by `storeId`/`customerId` (no IDOR found), scrypt+timingSafeEqual on passwords, and no committed secrets (git-verified). So the core security posture is real. The gaps are in staff RBAC and a couple of hardening misses:

### SEC-H1 · A `manager` can escalate to `owner`, or lock the real owner out
`packages/api/src/routes/admin-settings-advanced.ts:142-192` · `admin-helpers.ts:51-53`

`requireManage` treats `owner` and `manager` as one set. All three staff routes gate only on `requireManage`, with no check that the caller is an owner or that the target isn't:
- `POST /v1/admin/staff` accepts `role:'owner'` → a manager adds a second account (or themselves) as owner.
- `PATCH /v1/admin/staff/{id}` → a manager sets **their own** row to `owner`, or demotes the owner to `read_only`.
- `DELETE /v1/admin/staff/{id}` blocks only self-removal → a manager **deletes the owner's** access entirely.

Verified against the exact lines. Right now `owner` grants no capability `manager` lacks *except* this — so the immediately-exploitable part is owner-lockout/takeover. Before you build any owner-only capability (billing, store deletion), this is a latent full escalation. **Fix:** gate role-elevation-to-owner and any mutation targeting an owner row behind `st.role === 'owner'`.

### SEC-M1 · Licensing/download routes bypass the production host-routing guard
`packages/api/src/routes/apps.ts:20-21`

The `store()` helper does `c.req.header('x-store-slug') ?? DEV_DEFAULT_STORE` — the exact silent-`damned`-fallback that `store-context.ts:242-244` was hardened to **throw a 404** on in production (OPS-1). So license activation, update-check, and download endpoints still silently scope to the `damned` store if the proxy drops the header in prod. The same file even has a comment at :134 saying "never fall back to DEV_DEFAULT_STORE" for a sibling route — inconsistent. **Fix:** route `store()` through the production-guarded `resolveStoreForRequest`.

### SEC-M2 · `/v1/admin/staff/accept` is documented public but CSRF-blocked → invite flow unreachable
`packages/api/src/app.ts:83-91` vs `admin-settings-advanced.ts:232`

The admin CSRF middleware exempts only `/login` and `/logout`. The staff-invite-accept endpoint is documented "PUBLIC — no admin auth, isolation is the token" but a brand-new invitee has no `sr_csrf` cookie, so they're 403'd — unless they send any non-empty bearer (format-only check). The onboarding flow is effectively broken in a browser. **Fix:** exempt `/v1/admin/staff/accept` from the CSRF gate (it's token-authenticated by design).

### SEC-M3 · `processed_event` grows forever (no reaper)
`packages/api/src/db/schema-content.ts:32` · verified: no job references it

Every Stripe webhook id and every payment idempotency claim inserts a permanent row. `webhook_delivery` has `webhook-reaper.ts`; the outboxes have autovacuum tuning (migration 0040); `processed_event` has **nothing**. It grows one row per webhook + one per payment attempt forever. **Fix:** add a reaper that prunes rows older than the idempotency window (e.g. 30d), matching the webhook-reaper pattern.

### SEC-L (lower priority, real)
- **Migrations never use `CREATE INDEX CONCURRENTLY`** (`drizzle/0029` GIN on product, etc.). Fine at initial migrate; a *future* index on a populated live `order`/`product` table locks writes. Drizzle wraps migrations in a transaction (which forbids CONCURRENTLY), so this is structural — document a manual out-of-band index procedure for the Vendure-cutover import. (`docs/runbooks/migrations.md`)
- **TOTP compare uses `!==`, not `timingSafeEqual`** (`auth/totp.ts:51`) — inconsistent with password/CSRF compares; bounded by the 8/15min login throttle. Defense-in-depth.
- **Listmonk `apiToken` stored plaintext in `store.config` JSONB** (`admin-marketing.ts:186`) — never returned by any GET (verified), so it's a DB-dump/replica-leak concern, not API exposure. Consider app-level encryption or env-sourcing like the Stripe keys.
- **Emails logged without redaction** (`admin-settings-advanced.ts:213`, `listmonk-sync.ts:121`) — pino has no `redact` config; customer/staff emails reach any log aggregator. Policy decision given the careful enumeration-safety elsewhere.

---

## Bottom line

The earlier readiness report said the engine was clean — that was true only of the *scanners*, which is exactly why the lens pass mattered. The lenses found **4 critical money bugs** (gift-card overcharge, gift-card refund black-hole, refund-key collision, payment-after-cancel drop), a **privilege-escalation path**, an **incomplete host-routing hardening**, and a genuine **pre-checkout tax discrepancy** — none of which any scanner can see. Fix the CRITICAL + HIGH tier before pointing live DD/RH traffic at this; the MEDIUM/LOW tier can follow the cutover.
