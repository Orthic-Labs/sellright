# SellRight Deep Audit — Function-by-Function + Competitive Gap (2026-09-05)

> **Point-in-time snapshot.** Superseded where it conflicts with
> `.audit/2026-09-17-launch/audit-report.md` and the launch-remediation work that
> followed it — most notably, NMI and Sezzle are now implemented providers, and
> refund/webhook handling has been reworked. Provider and readiness claims below
> describe the `1b5042a` checkout, not current state.

Audited at HEAD `1b5042a` (`orthic-labs/sellright`), after the 2026-06→09 hardening
 commits. Scope: every core commerce surface — catalog, pricing, coupons, cart,
checkout, payments, customers, orders, admin UI, dashboard, storefront, DB layer —
read at the route/schema/engine level, plus a Vendure/Medusa/Saleor comparison.
Supersedes the 2026-08-02 findings (all four of that audit's CRITICALs are verified
fixed — see Appendix A).

## Verification evidence (all re-runnable)

| Check | Result |
|---|---|
| `pnpm typecheck` (all packages) | ✅ pass |
| Unit lane `pnpm --filter @sellright/api test` | ✅ 46 files / 258 passed (5 skipped) |
| DB lane on fresh CI-identical DB (drop → create → `db:migrate:runtime` → grants → `test:db`) | ✅ 29 files / 195 passed (1 skipped) |
| GitHub CI on `orthic-labs/sellright@main` (CI + CodeQL) | ✅ green at 20:14Z 2026-09-05 |
| `pnpm run deps:audit` | ⚠️ 7 advisories (1 high, 6 mod/low) — see H4 |
| CI packaging lane (compose + images + readyz) | ✅ green (CI run 33989527873) |

**Verdict: zero critical, release-blocking defects found at this depth.** The money
paths (checkout, pay, webhooks, refunds, gift cards) now hold up under adversarial
reading. The gaps that remain are **breadth gaps vs the market**, not correctness
gaps — with the one exception of dependency hygiene (H4).

---

## CRITICAL (release-blocking)

**None found.** Specific money-integrity checks that came back clean:

- Checkout re-prices server-side; client `unitPrice` is not even in the request schema.
- Idempotency: unique `(store, idempotency_key)` index + replay path on 23505;
  `/pay` claim key is store-scoped; Stripe refund keys include `priorRefunded` so two
  same-amount refunds can't collide.
- MONEY-3: webhook + `/pay` verify against `amountDueForOrder` (grandTotal − settled
  tenders), so partial gift-card orders can't overcharge.
- Settle-after-cancel on `/pay` and webhooks no longer silently drops money.
- Single-order cancel is `PendingPayment`-only (bulk-cancel's guard now applied there).
- Gift-card refunds credit the balance back with a ledger row
  (`admin-order-payment-helpers.ts:56-68`).
- Promotion percentage clamped at the totals core; per-customer + global usage limits
  take `FOR UPDATE` row locks; RLS `FORCE` + non-owner role asserted by dedicated
  scripts and a test lane.

---

## HIGH

### H1 · Payment gateway breadth: Stripe is the only shopper-capable gateway
`packages/api/src/routes/pay.ts:9` — `method: z.literal('stripe')`. The registry
(`payments/provider.ts`) supports Stripe + gift-card tender; manual/COD deliberately
fail closed. Consequence: **no PayPal, no Klarna/Afterpay/BNPL, no SEPA/iDEAL,
no offline/check payment**. Wallets (Apple Pay/Google Pay/Link) do come free through
Stripe Elements, but "Stripe-or-nothing" is the single biggest competitive gap for an
OSS commerce backend — every comparable platform (Vendure's plugin list, Medusa's
payment module, Saleor's gateways) treats PayPal as table stakes, and DD parity
explicitly needs a second gateway (FEATURES.md "Launch Gaps" #3).

**Action:** implement 1–2 providers against the existing `PaymentProvider` interface
(PayPal is the highest-demand; a proper COD lifecycle would unlock regional markets).
The interface already fits — `requiresRedirect` exists for exactly this.

### H2 · Tax is manual zones only — no automatic/VAT/compliance story
`tax_zone` (country-list → flat basis-points rate) is the whole model. No Avalara/
TaxJar-style jurisdiction lookup, no VAT MOSS/OSS, no tax-ID collection for B2B, no
per-product tax categories, no evidence of tax-inclusive display rules beyond the
store flag. Vendure/Medusa/Saleor all ship a tax-provider abstraction. Fine for the
current US flat/zone use-case; a blocker for EU/UK sellers.

**Action:** extract a `TaxProvider` interface (mirroring `PaymentProvider`) with the
zone system as the default implementation; add tax classes on variants (column +
selector) before adding any external provider.

### H3 · Shipping is flat/conditional only
`shipping/calculator.ts` supports subtotal thresholds and exclusions; the file's own
comment names weight tiers/per-item/carrier API as future work. `product_variant.
weightG` and `dimensions` exist but are dead weight for rates. No carrier rates, no
labels, no multi-package. Physical-goods sellers with >1 SKU class will bounce.

**Action (cheap win first):** add the weight-tier calculator to the existing JSONB
`calculator` shape (the engine already dispatches on shape), so heavy-item stores can
price without carrier integrations.

### H4 · Dependency advisories on production deps (audit exits 1)
`pnpm audit --prod`: 1 high (`nanoid` custom-generator loop), 5 moderate (4× hono —
CORS ReDoS, memo SSR cross-request leak, Language middleware DoS; 1× sanitize-html
stored-XSS), 1 low (hono proxy headers). sanitize-html runs on the blog-HTML path;
the hono memo advisory is a cross-request leak class on the live API server. None are
trivially exploitable here (memo() usage and Language middleware may not even be
imported), but CI's supply-chain check passes while `pnpm audit` fails — a split
signal that erodes trust in the green checkmark.

**Action:** `pnpm up -r` hono/`@hono/node-server` past the fixed versions, override
nanoid, re-run `deps:audit` to zero; consider making `deps:audit` part of `verify`.

---

## MEDIUM

### M1 · Variant creation has no option-matrix generator
Schema supports option groups + `variant_option` links, and the admin has an
OptionsEditor — but variants are created **one at a time** by hand
(`ProductDetail.tsx` "Add variant"). Vendure/Medusa/Saleor all generate the full
matrix from option groups. For any sized/shaped product this is minutes-vs-seconds
and the #1 admin-UX gap.

### M2 · Search is a single ILIKE term
`catalog.ts` search = name+description trigram ILIKE, collection + in-stock filters,
name-asc order. No facets (Vendure's core concept), no relevance ranking, no typo
tolerance, no price/attribute filters. Acceptable at small-catalog scale; the
pluggable-search seam (Vendure's `SearchService` pattern) is the missing architecture
piece.

### M3 · Offset pagination everywhere
All list endpoints use limit/offset. Fine below ~100k rows; keyset pagination is the
standard at scale and was previously scoped out as YAGNI. Revisit before any large
catalog migration (the Vendure import path is the likely first candidate).

### M4 · No order/customer notes, no customer groups
Schema has `customer.tags` but no admin surface; there is no order-note entity at all
(grep: zero hits). Order timelines exist via the audit log only. CS operators use
notes daily; every competitor has them. **Cheap, high-value add:** `order_note` +
`customer_note` tables + audit-log timeline merge in the admin.

### M5 · Multi-currency is display-only
`currency_rate` converts prices for presentment; settlement is always store base
currency (`schema-orders.ts` comment is explicit). No region-based price books, no
per-currency payment settlement. Medusa/Saleor do true multi-currency checkout. Fine
for the current single-brand focus; document the limitation on the storefront currency
switcher so shoppers aren't surprised by the charge currency.

### M6 · No abandoned-cart recovery
Abandoned carts are tracked (`admin-order-ops.ts`, TTL jobs, dashboard) but nothing
emails the shopper. This is the highest-ROI automation in commerce and is native in
Shopify/Medusa ecosystems. The email outbox + templates infra makes this a small
feature: a scheduled job + one template + admin toggle.

### M7 · Assets are local-disk only
`admin-assets.ts` writes to `ASSET_DIR` on local disk (sharp → webp, no S3 driver).
Docker just shipped; any multi-replica or rebuild-without-volume deployment loses
uploads. An `AssetStorage` interface with disk + S3 implementations is a day of work
and removes the ops foot-gun.

### M8 · Extension surface is a single interface
For OSS adoption: the only extension point is `PaymentProvider`. Vendure is
plugin-first, Medusa is module-first, Saleor has apps/webhooks-as-platform. SellRight
has webhooks + metafields + the provider interface — a workable v1 story, but the
README/docs should state the extension model explicitly, and internal services
(tax, shipping, storage — H2/H3/M7) should get provider interfaces as they're touched.
Strategically this is the biggest long-term gap vs the market even though it's not a
"basic function."

---

## LOW

- **L1** Repo hygiene for OSS: `admin.log` / `api.log` / `rank.md` / `.blueprint/`
  committed at root; internal strategy docs (`GTM.md`, `MOAT-AND-DISRUPTION.md`)
  published. Decide what the public repo should carry.
- **L2** License framing: README says "open-sourced" but BSL 1.1 is source-available;
  GitHub will show license "Other". Add a CONTRIBUTING note clarifying contribution
  licensing + the 25-Covered-Person rule so nobody wastes a PR.
- **L3** `engines` pin `node >=24.7 <25` locked out Node 22 dev environments (this
  box until today). Node 24 is current LTS so the pin is defensible — add a note to
  CONTRIBUTING, and let `engines.node` breathe to `>=24.7 <26` if CI allows.
- **L4** Public product list endpoint sorts name-asc only and lacks the in-stock
  filter that search has; add `sort` + `inStock` params for parity.
- **L5** No observability seam: pino logs only. An OpenTelemetry hook (optional dep,
  disabled by default) is what self-hosters ask for first after install.
- **L6** Email templates are code-only (`templates.ts`); no admin preview/edit. Fine
  for v1; note it.

---

## Competitive position (core basics, vs Vendure 3.x / Medusa 2.x / Saleor)

| Basic function | SellRight | Vendure | Medusa 2 | Saleor | Verdict |
|---|---|---|---|---|---|
| Products / variants / options | ✅ | ✅ + matrix generator | ✅ + matrix | ✅ + matrix | Parity minus M1 |
| Collections (manual + rules) | ✅ SQL rules engine | ✅ facet filters | ✅ | ✅ | Parity |
| Sale prices / compare-at | ✅ price, salePrice, compareAt, preOrder | ✅ | ✅ | ✅ | Parity |
| Coupons / promotions | ✅ %, fixed, free-ship, auto+code, limits, conditions | ✅ | ✅ strong engine | ✅ | Parity for basics |
| Gift cards / store credit | ✅ ledger + partial tender | ✅ | ✅ | ✅ | Parity+ (partial tender is MONEY-3-correct) |
| Cart | ✅ server-authoritative, TTL, fail-closed checkout read | ✅ | ✅ | ✅ | Parity+ |
| Checkout correctness | ✅ idempotent, row-locked, server-priced | ✅ | ✅ | ✅ | Parity+ (outbox + FSM + RLS are ahead) |
| Payments | Stripe only | ~20 plugins | module + plugins | several | **Behind (H1)** |
| Tax | manual zones | ✅ + tax plugins | ✅ module | ✅ | **Behind (H2)** |
| Shipping | flat/conditional | ✅ flat + plugins | ✅ + providers | ✅ | **Behind (H3)** |
| Customers | profiles, auth (incl. Google), addresses, verification | ✅ + groups | ✅ + groups | ✅ + groups | Parity minus M4 |
| Orders / fulfillment / returns / refunds | ✅ FSM, partial refunds, RMAs, bulk ops, invoices | ✅ | ✅ | ✅ | Parity+ (purge/restore + FK guard test is ahead) |
| Admin dashboard | ✅ KPIs, trend, ops cards, onboarding, activity, command palette | ✅ (Angular) | ✅ (Next) | ✅ (React) | Parity; smaller but modern |
| Subscriptions | ✅ Stripe Billing, license-linked | plugin | ✅ module | ✅ | Parity |
| Digital / licensing / downloads | ✅ native, seat+activation+updates | plugin | plugin | plugin | **Ahead** (category lead) |
| Multi-store / tenancy | ✅ RLS-enforced, one DB | channel-only | multi-region/store | channel/warehouse | **Ahead** (true tenant isolation) |
| Search | ILIKE trigram | default + Elastic plugin | MEILIS/plugin | Postgres/search apps | Behind at scale (M2) |
| Webhooks / events | ✅ outbox, HMAC, retry | ✅ | ✅ | ✅ | Parity+ |
| i18n / translations | ❌ | ✅ | ✅ | ✅ | Behind (not yet a basic for your market) |
| Extensibility | provider interface only | plugin-first | module-first | apps | **Behind strategically (M8)** |

**Where SellRight is genuinely ahead:** tenant isolation (RLS is real, tested,
asserted — none of the three do DB-level multi-tenancy), digital licensing, checkout
integrity machinery, and the deploy story (compose + smoke-tested images at this repo
size). **Where it's behind:** payments/tax/shipping breadth, admin convenience
(variant matrix, notes), search, extensibility. That matches the engine-vs-ecosystem
verdict in `COMMERCE-GAP-ANALYSIS.md` and is the right trade for now — the list above
is the ordered queue.

## Recommended order of work

1. H4 (deps) — hours; restores audit/CI signal agreement.
2. M4 (order/customer notes) + M1 (variant matrix) — the two admin gaps every user
   hits in week one.
3. H1 (PayPal provider) — the most-demanded OSS integration; interface is ready.
4. H2/H3 (TaxProvider seam, weight-tier shipping) — unlock physical-goods sellers.
5. M6 (abandoned-cart email) — small feature, visible ROI.
6. M7/M2/M8 as scaling demands.

---

## Appendix A · Disposition of the 2026-08-02 audit's findings (all re-verified at HEAD)

| Prior | Status at `1b5042a` | Evidence |
|---|---|---|
| C1 partial gift-card overcharge | ✅ fixed | `payments/settle.ts` `amountDueForOrder`; checkout + `/pay` + webhooks all charge `amountDue` |
| C2 gift-card refund vanishes | ✅ fixed | `admin-order-payment-helpers.ts:56-68` credits balance + ledger row inside the refund txn |
| C3 refund idem-key collision | ✅ fixed | `admin-orders.ts:210` key now includes `priorRefunded`; return path keys on `returnRequest.id` |
| C4 settle-after-cancel dropped | ✅ fixed | `payment-webhooks.ts:109` + `pay.ts:102` handle Cancelled-but-settled with amountDue verification |
| H1 node-server DoS CVE | ✅ fixed | `@hono/node-server` 2.0.10 in `packages/api/package.json` |
| H2 unpaid-only single cancel | ✅ fixed | `admin.ts:371` PendingPayment-only guard |
| H3 cart-estimate vs checkout tax | ✅ fixed | MONEY-5 test asserts exact agreement (`checkout.route.test.ts`) |
| H4 renewal payment ledger | ✅ fixed | `subscriptions.ts:203` settles renewals through `applyPaymentResult` |
| H5 postcss traversal CVE | ✅ no longer reported by `pnpm audit --prod` |
| M1 percentage clamp | ✅ fixed | `money/totals.ts` clamps [0,100] + floor-at-zero grand total |

---

## Appendix B · Performance + business-logic/math pass (second pass, same day)

Full reads added after the main report: `money/fsm.ts`, `auto-discount.ts`, `currency.ts`,
`tax.ts`, `gift-card.ts`, `shipping/calculator.ts`, `orders/stock-reservation.ts`,
`totals-property.test.ts`, plus index/pool/scheduler/rate-limiter review.

### Business logic & math verdict

- **FSM** (`fsm.ts`): explicit transition table; `Refunded`/`Cancelled` terminal; no
  `Paid → PendingPayment` escape hatch. Correct and minimal.
- **Totals math**: line-level rounding + largest-remainder distribution is the right
  algorithm; property tests assert the exact-sum invariant including the classic
  $7/$11/$13 audit case. Inclusive-tax extraction formula is correct.
- **Stock reservation**: single conditional `UPDATE … SET allocated = allocated + qty
  WHERE (on_hand - allocated) >= qty` per line — atomic, no read-modify-write race;
  failure collects blocked SKUs and throws inside the txn (full rollback). Correct.
- **Auto-discount**: deterministic best-pick (priority desc → discount desc);
  ranking-only use of rounded discount is sound.
- **Tax resolve / currency convert / gift-card tender**: all pure, integer, small,
  correct. Gift-card full-coverage-only invariant is conservative and refundable.
- **F1 (low, test hygiene)**: `totals-property.test.ts`'s `distribute()` helper
  *re-implements* the algorithm it tests instead of calling it — the impl could drift
  and the mirrored cases would still pass. The `via calculateOrderTotals` cases are
  the real coverage; make all cases go through the public API.

### Performance findings

| ID | Severity | Finding | Action |
|---|---|---|---|
| P1 | **medium** | Checkout `items` array is unbounded (`checkout.ts:84` has `.min(1)`, no `.max()`) and `reserveStockOrThrow` runs one UPDATE **per line** in-sequence inside the txn — a 10k-line request = 10k sequential UPDATEs holding row locks. Same shape in draft orders (admin-only, lower risk). | Add `.max(200)` (or 500) to the items array; switch reservation to one set-based `UPDATE … FROM (VALUES …)` per checkout. |
| P2 | low | Customers list runs two correlated subqueries per row (order count + spend). Indexed and 25/page today; ceiling ~100k customers. | Aggregate-join or keyset pagination when it hurts (ties to M3). |
| P3 | low | Rate limiter + scheduler leader-lock are per-process/in-memory. Correct for the documented single-instance deploy — the file header says so — but a multi-instance rollout silently loses throttling. | Redis-backed limiter before any horizontal scale. |
| P4 | low | Auto-discount re-evaluates every eligible automatic promo per checkout. N is small; fine. | None needed. |

**Verified-good perf posture:** static catalog manifest keeps browse off the API;
trigram GIN backs search; hot tables carry composite indexes (`order(store,state,created)`,
`order(store,placed_at)`, `product(store,name)`, `stock(store)`,
`promotion_usage(promo,customer)`, `cart(store,status)`); pool max=10 with a ≤4
internal pool and 5s connect timeout; scheduler claims work with `FOR UPDATE SKIP
LOCKED` under a single-leader advisory lock. No runtime/profiling pass was run —
static analysis only, consistent with the main report's honesty note.

---

## Appendix C · Absorption map — what to take from each OSS peer

Compared this session against Vendure 3.x, Medusa 2.x, Saleor (docs + architecture
research). Prior internal comparisons (Shopify/Woo/BigCommerce) live in
`docs/COMMERCE-GAP-ANALYSIS.md`; this maps the OSS peers' patterns onto the
findings above.

### From Vendure (closest architectural cousin: TS, entities, channels)

| Pattern | Fixes | Note |
|---|---|---|
| Plugin/strategy seam (`AssetStorageStrategy`, `SearchService`, tax zone/rate model) | M8, M7, H2 | SellRight's JSONB shipping `calculator` is already ~80% of Vendure's `ShippingCalculator`/`EligibilityChecker` split — formalize the same split as provider interfaces |
| Facet/facet-value system + denormalized `search_index` table with a pluggable provider | M2 | Start with a Postgres-backed index, keep the seam so Meilisearch/Elastic can drop in later. Highest effort-to-impact of the three |
| Admin variant matrix generation from option sets | M1 | UX pattern, no schema change needed |

### From Medusa 2.x

| Pattern | Fixes | Note |
|---|---|---|
| Promotion-engine depth (product/customer-group targeting, application methods, combinability rules) | extends coupons | Extend the existing `promotion.conditions` JSONB DSL — do not replace it |
| Region model (currency + tax + shipping bundled per geography) | H2, M5 | The right container when adding TaxProvider / real multi-currency, instead of bolting both onto `store` |
| Workflow concept for long-running flows | M6 | Abandoned-cart recovery = scheduled job + email step; the outbox + scheduler already provide ~70% of the machinery |

### From Saleor

| Pattern | Fixes | Note |
|---|---|---|
| Typed attributes with definitions | M2 (alternative) | Lighter than full facets; maps cleanly onto existing `metafields` JSONB |
| App/token-scoped API credentials | post-M8 | Webhooks are already at parity; per-integration tokens are the later add |

### Deliberately NOT absorbed

- Saleor's GraphQL-first API — REST/OpenAPI is a deliberate differentiator.
- Medusa's module-repo machinery — the `packages/*` split is simpler and sufficient.
- Vendure's Angular admin — the React admin is modern and staying.

### Sequencing (unchanged from "Recommended order of work")

H4 → M4 + M1 → H1 (PayPal) → H2/H3 seams → M6 → M7/M2/M8. The three
"absorb" builds with best effort-to-impact: search index seam (M2), variant
matrix (M1), TaxProvider seam (H2).
