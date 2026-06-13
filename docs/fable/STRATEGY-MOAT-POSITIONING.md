# SellRight — Strategy, Decision Record & Positioning (2026-06-10)

**Status answer (Adrian, 2026-06-10): internal now, product later.** This doc is therefore internal-first — decision record, TCO, risk register, cutover criteria — with a productization section (§6) that activates only after all four brands run on it.

---

## 1. Decision record — why not Vendure / Medusa / Saleor / Shopify

| Option | License | Why rejected |
|---|---|---|
| **Vendure** (incumbent) | GPLv3 core (moved from MIT in 2.x; commercial license sold separately) | GraphQL-only API tax on every storefront interaction; cart-is-an-order-in-`AddingItems` model fights real cart semantics; deep-query overhead; GPLv3 forecloses the "product later" path without paying Vendure; customization lives in their plugin model, not ours. |
| **Medusa** | MIT | Tried pre-Vendure; bad experience (docs/STATE-AND-ROADMAP-v1.md §0 locked decisions). v2 rewrite churn; module abstraction depth means debugging their framework, not your store. |
| **Saleor** | BSD-3 | GraphQL-first (same API tax), Python/Django stack (everything else in the portfolio is TS), cloud-first gravity. |
| **Shopify** | Proprietary SaaS | Per-store fees ×4 brands, checkout lock-in, no data-model control, hostile to the kind of customization DD already needed in Vendure. |
| **SellRight** (build) | Owned | Full control of data model, money path, multi-tenant model, and license. One backend, four brands, zero per-store platform fees. The "product later" option stays open. |

Research backing: `docs/research/ecom-backend-research-2026-06.md` §2 ("composable regret" — teams that assembled composable platforms report the integration burden exceeds the build burden for small surface areas). License facts verified 2026-06-10 ([PkgPulse 2026 comparison](https://www.pkgpulse.com/blog/medusa-vs-saleor-vs-vendure-headless-ecommerce-2026), [Linearloop](https://www.linearloop.io/blog/medusa-js-vs-saleor-vs-vendure)).

**What the decision actually buys (be honest):** the win is not "better than Vendure at everything." It is: typed REST + static manifests (storefront perf), one multi-tenant DB with FORCE RLS instead of 4 separate Vendure instances (ops consolidation: one process, one schema, one upgrade), owned money path with cent-perfect import parity, and an unencumbered license. The cost is owning every future commerce edge case yourself — see risk register.

## 2. TCO argument (internal)

- **Today (Vendure ×4):** 4 DBs, 4 admin processes, 4 store processes on the Hetzner box; every Vendure major upgrade ×4; plugin/custom-field maintenance per brand; GraphQL codegen churn in each storefront.
- **Target (SellRight):** 1 API process, 1 admin, 1 Postgres cluster (5433), N storefronts on static manifests + one REST contract. Marginal cost of brand #5 ≈ one `store` row + storefront skin.
- **Build cost already sunk:** schema (52 tables), RLS model, money core, import parity, admin SPA (~30 pages) — the remaining spend is storefront rewire, live gateway e2e, and ops floor, not architecture.
- **Counter-cost to keep honest:** SellRight's maintenance has no community. Every tax rule, carrier API, and payment quirk is in-house forever. The TCO win holds only while the commerce surface stays as narrow as the four brands' actual needs. Scope discipline IS the TCO argument.

## 3. Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| **Bus factor = 1** (Adrian + AI sessions; no second maintainer) | HIGH | Docs-as-you-go discipline (STATE-AND-ROADMAP, this folder); typed OpenAPI contract makes the surface legible; keep Vendure warm until each brand passes its cutover gate. |
| **Security regression in owned auth/payments code** (no framework community patching) | HIGH | `pnpm verify` gate incl. RLS invariant; audit §4 security batch before cutover; periodic re-audit (this doc's cadence). |
| **From-scratch edge cases** (tax jurisdictions, partial fulfillment, exchanges, chargebacks) | MEDIUM | Shopify-parity surface already mapped (migrations 0011–0021); add features only when a brand actually needs them. |
| **Hybrid limbo** — storefront half on Vendure GraphQL for an extended period | MEDIUM | §3.9 rewire is on the critical path (audit §5 step 5); each flow cut over individually with Regime-A rollback. |
| **Data loss** — no backups today | HIGH | Launch gate: nightly pg_dump + tested restore before first real order (audit §3 Tier 1 #7). |
| **Maintenance drag steals time from revenue work** (the Graphify lesson: elaborate scaffolding nobody uses) | MEDIUM | Minimum-mechanism rule; no feature without a brand needing it this quarter. |
| **Vendure rollback becomes impossible** after real orders flow (Regime B) | MEDIUM | Build the SellRight→Vendure reconciliation exporter before first live order, or accept forward-fix-only and say so. |

## 4. Cutover criteria — per brand

A brand cuts over only when ALL of (from audit §5 + STATE-AND-ROADMAP §3A):
1. Real payment gateway live in sandbox + one cent-perfect end-to-end test order (charge → refund).
2. Email: order confirmation, shipping notification, password reset all sending.
3. Storefront auth/account/search on SellRight REST, browser-QA'd per flow.
4. Non-owner DB role in use; security batch (CSRF, mandatory idempotency, IP priority, sealed `db` export) merged.
5. Ops floor: systemd, nginx'd admin behind Cloudflare Access, backups with a tested restore, uptime alert.
6. Rollback regime declared (A: per-flow revert to Vendure; B: exporter built) and tested.
7. For DD additionally: parity-replay gate (historical inputs through SellRight money core == Vendure grand totals), NMI/Sezzle vault-ref continuity, asset migration.

**Order: RH → DD → TS → SS.** RH is greenfield (zero SellRight orders, Stripe-simple). DD is the proof-of-scale. TS/SS follow as near-free marginal tenants.

## 5. Positioning (one paragraph, internal)

SellRight is the portfolio's owned commerce engine: one multi-tenant TypeScript backend with database-enforced tenant isolation, an integer-cents money core with cent-perfect Vendure import parity, and a typed REST contract that any of the brand storefronts can consume. It exists to delete four Vendure instances and the GPLv3 ceiling above them.

## 6. Productization section (dormant until all 4 brands are live on it)

**Trigger to activate:** four brands in production ≥ one quarter, support burden known, security re-audit passed. Do not market a backend you haven't finished dogfooding — DD's order history is the credential.

If activated, the moat shape vs the field:
| Axis | SellRight | Medusa | Saleor | Vendure |
|---|---|---|---|---|
| API | Typed REST + OpenAPI + static manifests | REST, module framework | GraphQL | GraphQL |
| Multi-tenancy | First-class, Postgres FORCE RLS | DIY | Cloud/multi-channel, not multi-tenant OSS | Channels (soft) |
| License | Owned / commercial (see LICENSING.md) | MIT | BSD-3 | GPLv3 + commercial |
| Money | Integer cents, tested core, import parity tooling | Framework-dependent | Mature | Mature |
| Ops weight | Single process + Postgres | Multi-service gravity | Heavy (Python/celery) | Node + worker |

The honest wedge: **"the multi-tenant brand-portfolio backend"** — operators running 2–10 small brands who today pay Shopify ×N or run Vendure ×N. Nobody serves that operator specifically. Defer everything else (sales motion, pricing, hosted tier) to activation time; competitor claims must be re-verified then.

## 7. Review cadence

Re-audit (audit doc + this one) after: each brand cutover, any auth/payments/RLS change batch, or 6 months — whichever first.
