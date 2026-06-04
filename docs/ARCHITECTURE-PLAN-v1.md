# Owned Commerce Backend — Architecture Plan (Pass 1 / draft for critique)

**Goal (your words):** remove the Vendure dependency, own the backend, keep it clean / simple / maintainable. Rebuild with a clean (non-GraphQL) API and a full admin. RH first, then DD and SS.

**Status:** Draft for your critique. Grounded in: live inspection of your server (3 Vendure stores, ~25 RH plugins, ~40-op storefront API surface) + two web-grounded benchmarks (Shopify/world-class; Vendure license + base; Medusa/Saleor peers). Citations at the end.

---

## 0. TL;DR

- **You're right that 80% of a commerce backend is trivial** — products, variants, collections, customers, addresses, and their relationships are plain CRUD over Postgres.
- **The risk is a narrow ~6-item "money path"** (order totals/tax, payment idempotency, inventory race-safety, refunds, promo stacking, order state machine). Both benchmarks independently rate every one of these **"buy, not build"** — 4–8 engineer-months to reach tested parity from scratch, with a long tail of correctness bugs that cost real money.
- **Your real driver is independence, not a feature gap.** That eliminates Shopify (max lock-in) and reframes the choice as: *own a from-scratch backend* vs *own an MIT, self-hosted, clean-REST-API base that already solved the hard 20%.*
- **Recommendation: build on Medusa v2.** It satisfies **every** requirement you stated — own it (MIT, forkable, self-hosted), clean REST API (not GraphQL), full self-hosted React admin, same Node/TS/Postgres stack you already run — while the money path comes pre-solved and tested. It *is* "your own backend, not Vendure," just not from zero.
- **If you still want from-scratch, it's designed below in full** — with the hard 20% isolated into one small tested core. The honest cost: 4–8 months and *permanent* sole ownership of payment correctness across your 9 ventures.
- **One decision needed from you** (§7). Everything downstream — schema, migration, the cent-perfect parity test — is identical either way.

---

## 1. Correction to something I told you

Earlier I said "Vendure is MIT open-source." **That's wrong for your version** — I asserted it from memory without checking. The fact:

- Vendure relicensed **MIT → GPLv3 in v3.0 (July 2024)**. Your 3.6.4 is **GPLv3**. v2.3 was the last MIT release.
- **It doesn't change the ownership story, and arguably helps it:** GPL triggers on *distribution*, not *running*. Serving a website is not distributing. Self-hosted, you can fork, patch, and freeze 3.6.x **forever with zero obligation to publish anything**; custom plugins are explicitly GPL-exempt. The license only bites if you package and *sell* a Vendure-derived product to third parties.

So "I depend on a third party" is much weaker than it feels: the code is on your disk, GPL, forkable. It cannot be taken away or changed without your consent. That's a different risk class from a Shopify-style hosted API.

---

## 2. Where Vendure actually stands (honest)

**Dead complaints (no longer true):**
- *Angular admin* — gone. v3.5+ ships a **React + Tailwind + Shadcn** dashboard (Angular admin EOL July 2026). Your `ddadmin/rhadmin/ssadmin` already run it.

**Real, specific weak spots (these are legitimate reasons to dislike it):**
- **GraphQL-only primary API.** REST is a bolt-on via NestJS controllers in a plugin. This is likely the core of your "could be simpler" feeling.
- **Deep-query performance** — nested GraphQL can get expensive; query-cost limits aren't on by default.
- **No native subscriptions / no RMA module / code-only email templates** (copy changes need a redeploy).
- **Plugin boilerplate** — a small feature touches SDL + service + resolver + entity + migration + codegen. High ceremony.
- **Smaller community** than Medusa (~6–8K vs ~27K stars).

**What Vendure is genuinely good at (the parts you'd be re-earning):** configurable order state machine, pluggable shipping/tax/payment strategies, strongly-typed plugin system, worker/job queue, multi-channel, 7 years of discovered edge cases in the money path.

**Shopify as ceiling, not option:** it's world-class operationally (PCI offload, fraud ML, 99.99% SLA, tax jurisdictions) but it is the *opposite* of your independence goal — proprietary SaaS, lock-in, per-transaction fees on external gateways. Use it only as a "what good looks like" benchmark. **Eliminated.**

---

## 3. The hard 20% — what actually earns engineering care

Everything else is CRUD. These are the subsystems that cause silent revenue loss if done naively. Both benchmarks rate all of them "buy, not build":

| Subsystem | Failure mode if wrong | The known fix |
|---|---|---|
| Order state machine | Zombie orders, double-fulfillment | Explicit state enum + allowed-transition table + audit row per transition |
| Money & tax math | Books don't reconcile; wrong tax remittance | Integer cents only; one pure total function; decide per-line vs per-document rounding and never mix |
| Payment idempotency | Double-charge / double-ship on webhook retries | Unique `event_id` table written *before* side effects; respond 200 then process async; Stripe idempotency keys |
| Inventory race | Two buyers, one last unit → −1 stock | Atomic decrement under `SELECT FOR UPDATE`; soft-reserve + expiry for flash sales |
| Refunds | Negative tax remittance, un-restocked stock | Per-line refund ledger; proportional tax/shipping; restock toggle |
| Promotion stacking | Margin destruction, promo abuse | Explicit priority + exclusion groups; server-side re-validation (you already do this) |
| PCI / card data | Audit failure, breach liability | **Never build** — Stripe tokenization, raw cards never touch your server |

This is the entire risk surface. It's finite and well-understood — not rocket science — but it's the 20% that is unforgiving, and it's identical work whether you build from scratch or adopt a base (a base just ships it pre-tested).

---

## 4. What your system actually is today (the real spec)

From live server inspection:

- **3 stores**, one VPS: DD (`vendure_db`), RH (`rotten_db`), SS (`stunning_db`) — each Vendure 3.6.4 + Qwik SSR store + React admin, on pm2 + nginx + dockerized Postgres + Redis. TS is separate.
- **Storefront API surface: ~40 real operations** (catalog, local-cart + checkout, Stripe payment intents, customer/auth incl. Google OAuth, blog, contact/newsletter). Small and clean — the new API is not a sprawl.
- **Local-cart pattern already in use** — cart lives client-side; the order is only created at checkout. This shrinks the risky surface further.
- **Custom fields are tiny:** `ProductVariant.salePrice`, `Customer.listmonkSubscribedAt`, Stripe customer id.
- **~25 RH plugins, but most are NOT money-path** and port easily or move out of the backend entirely: blog, SEO, listmonk sync, contact-form, google-auth, order-tracking, product/order export, cache-invalidation. The money-path ones are: stripe-payment, variant-pricing, custom-shipping, coupon-validation, the order-* set.

**Implied data model (~15 tables):** `product, product_variant, product_option, collection, collection_product, customer, address, order, order_line, payment, refund, fulfillment, shipping_method, promotion, stock_level` + `audit_log` + `processed_event` (idempotency).

---

## 5. Target architecture (the from-scratch design you asked for)

Designed so the hard 20% is quarantined and everything else stays boring.

```
┌─────────────────────────────────────────────────────────────┐
│  Qwik storefront (rebuilt against clean API)                  │
└───────────────┬───────────────────────────────────────────────┘
                │  typed REST  (or tRPC)  — ~40 operations
┌───────────────▼───────────────────────────────────────────────┐
│  API layer  (Fastify + zod, or tRPC)                           │
│   thin controllers → services. No business logic here.         │
├────────────────────────────────────────────────────────────────┤
│  CRUD services (the trivial 80%)   │  MONEY CORE (the 20%)      │
│  catalog, collections, customers,  │  pure functions, isolated: │
│  addresses, content                │   • totals/tax (int cents) │
│                                    │   • Order FSM              │
│                                    │   • inventory (atomic)     │
│                                    │   • refund ledger          │
│                                    │   • coupon re-validation   │
│                                    │  → 100% unit-tested        │
├────────────────────────────────────────────────────────────────┤
│  Stripe adapter (PaymentIntents + webhook idempotency)         │
│  Job queue (BullMQ/Redis): emails, listmonk, exports, indexing │
│  Audit log + structured logs (trace id at payment boundary)    │
├────────────────────────────────────────────────────────────────┤
│  Postgres (Drizzle or Prisma)  — ~15 tables + audit + idemp.    │
└────────────────────────────────────────────────────────────────┘
                │
┌───────────────▼───────────────────────────────────────────────┐
│  Admin SPA  (React + Tailwind/Shadcn + TanStack Table/Query)   │
│  products · orders · customers · fulfillment · promotions      │
│  talks to the SAME REST/tRPC API (admin-scoped)                │
└─────────────────────────────────────────────────────────────────┘
```

**Stack choices (reuse what you run):** TypeScript end-to-end · Fastify+zod or tRPC for the typed clean API · Postgres via Drizzle (lean) or Prisma (batteries) · BullMQ/Redis for jobs · Stripe for all payment/PCI · React/Shadcn admin. No new languages, no GraphQL, no codegen-before-server dance.

**The one rule that makes this safe:** all money logic lives in the money-core module as **pure functions with no I/O**, called by services. That's the only code that needs exhaustive tests. The CRUD never touches totals.

---

## 6. Migration plan — RH first (identical for build-it or Medusa)

1. **Stand up the new backend beside Vendure** — new DB, zero disruption to live stores.
2. **Port the ~15-table schema; one-time ETL from `rotten_db`** — products, variants, collections, customers, addresses, historical orders (read-only). **Preserve Stripe customer IDs** — required to refund old orders.
3. **Build the ~40-op API to the storefront contract; rebuild the Qwik store** against it.
4. **Cent-perfect parity gate (the critical risk control):** replay a sample of *real* RH orders through the new totals/tax/discount functions and **diff against Vendure's stored totals to the cent.** No cutover until this is clean. Applies to both options.
5. **Shadow → cutover → rollback window:** run new stack on read traffic, cut RH over, keep Vendure `rotten` as instant rollback for a few weeks.
6. **Repeat ETL + cutover for DD then SS** — schema already proven on RH.

Non-money plugins (blog, SEO, listmonk, exports, OAuth, tracking) port after the core is live; several stop being backend concerns at all.

---

## 7. Recommendation + the one decision I need

**Risk-adjusted recommendation: build on Medusa v2.** It hits every box you set — own it (MIT, self-hosted, forkable — *more* independent than your current GPLv3 Vendure), **clean REST API + JS SDK (not GraphQL)**, **full self-hosted React admin**, same Node/TS/Postgres stack, RH-first migratable, 27K-star community — and the hard 20% ships pre-solved with saga workflows that specifically handle idempotency and order-state rollback. This is genuinely "your own backend, Vendure gone," without re-earning the money path. It directly cures your actual gripes (GraphQL, plugin weight) while removing the dependency.

**The from-scratch build (above) is fully viable** and gives you ownership of every line — but the honest price is **4–8 months to tested parity** and **permanent, solo ownership of payment correctness** across 9 ventures. Your own rule #10 (minimum mechanism — "no elaborate scaffolding only you maintain") leans against it unless owning every line is itself the point.

**Floor option:** freeze/fork your Vendure 3.6.x. ~2–4 hrs/month security triage, zero rebuild. Lowest effort, keeps the GraphQL you dislike.

### Decision I need from you

> **From-scratch build, or Medusa v2 base?** Both deliver an owned, clean-REST-API, full-admin, Vendure-free RH backend. Schema, migration, and the cent-perfect parity test are the same work either way — so this is the only fork in the road, and the rest of the plan is ready to execute the moment you pick.

(Pass 1 draft — push back on anything. Once you choose, Pass 2 is the concrete schema + API spec + build sequence for RH.)

---

## Citations

**Vendure base & license:** [License change MIT→GPLv3](https://vendure.io/blog/license-change-announcement) · [GPL self-host clarification](https://vendure.io/blog/busting-the-myth-of-gpl) · [Licensing](https://vendure.io/licensing) · [React admin / Angular EOL](https://vendure.io/blog/vendure-react-admin-ui) · [Perf issue #1718](https://github.com/vendure-ecommerce/vendure/issues/1718) · [Subscriptions #2369](https://github.com/vendure-ecommerce/vendure/issues/2369)

**Shopify / world-class:** [Admin GraphQL API](https://shopify.dev/docs/api/admin-graphql/2026-01) · [Tax engine componentization](https://shopify.engineering/componentizing-shopify-tax-engine) · [Discount combinations](https://help.shopify.com/en/manual/discounts/discount-combinations) · [PCI](https://www.shopify.com/security/pci-compliant) · [Webhook idempotency pattern](https://www.digitalapplied.com/blog/webhook-reliability-idempotency-retries-engineering-reference-2026)

**Peers:** [Medusa GitHub](https://github.com/medusajs/medusa) · [Medusa v2 overview](https://medusajs.com/v2-overview/) · [Medusa vs Saleor vs Vendure 2025](https://u11d.com/blog/medusa-js-vs-saleor-vs-vendure-capabilities-compared-in-2025/) · [Who wins where](https://www.linearloop.io/blog/medusa-js-vs-saleor-vs-vendure)
