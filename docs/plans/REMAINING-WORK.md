# Remaining work — SellRight

Last reconciled: 2026-09-06 · baseline `1b5042a`

This is the canonical current backlog. Historical audit/dispatch documents remain evidence, not execution truth. When they disagree, current code + current CI + this file win.

## Current release posture

SellRight has no known critical release-blocking correctness defect at this baseline. The public GitHub pipeline is green on Node 24 LTS across:

- core + admin build/typecheck/unit tests;
- PostgreSQL 17 migrations + DB integration + RLS/isolation assertions;
- storefront production build;
- production API/admin container smoke + bootstrap/readiness/CSP;
- CodeQL JavaScript/TypeScript analysis.

The remaining launch work is dependency hygiene, bounded abuse/performance hardening, public-repo hygiene, real external-service smoke, and operator runbooks. Product-breadth work follows separately and must not be mistaken for a release blocker.

## P0 — close before calling 0.1.0 a launch candidate

- [ ] **DEP-1 — production dependency audit clean.** Resolve current `pnpm audit --prod` advisories (Hono/@hono/node-server, sanitize-html, nanoid or their current equivalents), then make `pnpm deps:audit` agree with the green CI signal.
- [ ] **PERF-1 — cap checkout line count.** Add a bounded maximum to public checkout items (target 200 unless code evidence argues lower) so one request cannot hold a transaction across thousands of sequential stock operations.
- [ ] **CI-1 — include dependency audit in CI.** Run production dependency audit after frozen installs; dependency changes must not produce a green launch pipeline with a red audit.
- [ ] **REPO-1 — public/source-available hygiene.** Remove accidental runtime/log/scratch artifacts from tracked source; keep useful engineering docs intentionally. Ensure README consistently says source-available/BSL 1.1 rather than OSI open source.
- [ ] **REPO-2 — contribution/license guidance.** Add concise contribution guidance explaining BSL 1.1, the <=25 Covered Persons production grant, and that contributions are accepted under the repository license unless separately agreed.
- [ ] **OPS-1 — protect `main`.** Require the proven CI + CodeQL checks, block force-push/deletion, and use PRs for normal future changes. Enable only after the required check names are confirmed from green runs.
- [ ] **PAY-1 — real Stripe test-key E2E.** Against a disposable/test store: cart -> checkout -> PaymentIntent/3DS-capable confirmation -> webhook -> Paid -> refund. This requires configured test credentials; never use live customer data.
- [ ] **OPS-2 — backup/restore drill.** Prove a fresh Postgres backup restores into a disposable database and passes `/v1/readyz`/basic reads after migration.
- [ ] **OPS-3 — installation/reboot smoke.** From the production Compose path, prove first-run bootstrap is idempotent and the stack returns healthy after a full down/up cycle with persistent volumes.

## P1 — first product-completeness work after launch candidate

- [ ] **CAT-1 — variant matrix generator.** Generate variant combinations from option groups in admin; schema already supports the links.
- [ ] **OPS-4 — order/customer notes.** Add operator notes with author/timestamp and surface them in the relevant admin timelines.
- [ ] **GROW-1 — abandoned-cart recovery.** Reuse the existing cart lifecycle, scheduler, email outbox and templates; add an opt-in admin/store setting and idempotent recovery job.
- [ ] **PAY-2 — second shopper payment provider only on demonstrated demand.** Keep Stripe as the default. Add PayPal/COD/other provider when a concrete target deployment requires it; do not distort the core for historical Vendure/DD parity.

## P2 — architecture seams when the second implementation exists

- [ ] **TAX-1 — `TaxProvider` seam.** Keep country/zone tax as the built-in provider; add tax classes before external compliance providers.
- [ ] **SHIP-1 — formal shipping provider/calculator seam + weight tiers.** Reuse existing variant weight/dimensions; carrier APIs remain later.
- [ ] **ASSET-1 — `AssetStorage` seam.** Keep disk as default; add S3/R2-compatible storage before multi-replica deployment.
- [ ] **SEARCH-1 — search provider/index seam.** Preserve Postgres as default; add a denormalized index/provider boundary only when catalog scale justifies it.

## Explicitly deferred — not launch blockers

- Generic plugin SDK/framework.
- Redis/distributed rate limiting until horizontal API scaling is planned.
- Keyset pagination until a list actually reaches offset-pain scale.
- Faceted/typo-tolerant external search.
- True multi-currency settlement/region model.
- Full i18n/translation system.
- OpenTelemetry integration.
- Multi-tender refund allocation beyond the currently supported safe cases.
- Broad carrier/label ecosystem.

## Known good / do not re-open without contrary evidence

- Server-authoritative pricing and shipping totals.
- Store-scoped payment idempotency and settled-tender amount-due accounting.
- Settle-after-cancel reconciliation behavior.
- Gift-card redemption/refund ledger integrity.
- Refund ambiguity fails closed.
- FORCE RLS / non-owner isolation assertions.
- Argon2id native password format with legacy SellRight scrypt upgrade path.
- Node 24 LTS + pnpm 11 launch toolchain.
- Production API/admin images, first-run bootstrap, readiness and CSP smoke.

## Completion rule

P0 is the 0.1.0 launch-candidate gate. P1/P2 are roadmap work and may ship incrementally after 0.1.0. Every item closes only with executable evidence (test/CI/runtime receipt), not by documentation claim.