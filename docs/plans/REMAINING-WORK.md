# Remaining work — SellRight

Last reconciled: 2026-09-06 · head `4eb150d` · CI `34030599548` · CodeQL `34030599564`

This is the canonical current backlog. Historical audit/dispatch documents remain evidence, not execution truth. When they disagree, current code + current CI + this file win.

## Current release posture

SellRight has no known critical release-blocking correctness defect at head `4eb150d`. CI run `34030599548` and CodeQL run `34030599564` are green on Node 24 LTS across:

- core + admin build/typecheck/unit tests;
- PostgreSQL 17 migrations + DB integration + RLS/isolation assertions;
- storefront production build;
- production API/admin container smoke + bootstrap/readiness/CSP;
- CodeQL JavaScript/TypeScript analysis.

The remaining P0 launch work is branch protection plus one real Stripe test-key end-to-end payment receipt. Product-breadth work follows separately and must not be mistaken for a release blocker.

## P0 — close before calling 0.1.0 a launch candidate

- [x] **DEP-1 — production dependency audit clean.** `pnpm deps:audit` passed in CI run `34030599548` on head `4eb150d`, after the admin React Router advisory fix (`bb54899`) and storefront transitive security floors (`4eb150d`).
- [x] **PERF-1 — cap checkout line count.** Landed in `39a97e4`; the public checkout now rejects an excessive cart-line count before entering the stock-operation path.
- [x] **CI-1 — include dependency audit in CI.** Landed in `e9b1b67`; CI run `34030599548` proves the production dependency audit executes after frozen installs and passes.
- [x] **REPO-1 — public/source-available hygiene.** Explicit tracked-file hygiene scan at `4eb150d` found no accidental runtime/log/scratch artifacts; tracked env files are examples. README, CONTRIBUTING and LICENSE consistently identify SellRight as BSL 1.1 source-available rather than OSI Open Source before the Change Date. Historical audit/readiness docs remain intentional evidence.
- [x] **REPO-2 — contribution/license guidance.** Landed in `224d11e`; CONTRIBUTING documents BSL 1.1, the <=25 Covered Persons production grant, and contribution licensing.
- [ ] **OPS-1 — protect `main`.** Require the proven CI + CodeQL checks, block force-push/deletion, and use PRs for normal future changes. Enable only after the required check names are confirmed from green runs.
- [ ] **PAY-1 — real Stripe test-key E2E.** Against a disposable/test store: cart -> checkout -> PaymentIntent/3DS-capable confirmation -> webhook -> Paid -> refund. This requires configured test credentials; never use live customer data.
- [x] **OPS-2 — backup/restore drill.** Production-container CI proves backup and restore into a disposable database; run `34030599548` passed the `Prove database backup and restore` step.
- [x] **OPS-3 — installation/reboot smoke.** Production-container CI run `34030599548` passed first-run/startup checks plus `Prove persistent-volume reboot and idempotent bootstrap`.

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

P0 is the 0.1.0 launch-candidate gate. P1/P2 are roadmap work and may ship incrementally after 0.1.0. Every item closes only with executable or repository evidence, not by documentation claim. P0 is not complete while OPS-1 and PAY-1 remain open, so SellRight is not yet a 0.1.0 launch candidate.