# Remaining work — SellRight

Last reconciled: 2026-09-06 · evidence head `224955d` · CI `34030937041` · CodeQL `34030937106`

This is the canonical current backlog. Historical audit/dispatch documents remain evidence, not execution truth. When they disagree, current code + current CI + this file win.

## Current release posture

SellRight has no known critical release-blocking correctness defect at evidence head `224955d`. CI run `34030937041` and CodeQL run `34030937106` are green on Node 24 LTS across:

- core + admin build/typecheck/unit tests;
- PostgreSQL 17 migrations + DB integration + RLS/isolation assertions;
- storefront production build;
- production API/admin container smoke + bootstrap/readiness/CSP;
- CodeQL JavaScript/TypeScript analysis.

The remaining P0 launch work is one real Stripe test-key end-to-end payment receipt. Product-breadth work follows separately and must not be mistaken for a release blocker.

## P0 — close before calling 0.1.0 a launch candidate

- [x] **DEP-1 — production dependency audit clean.** `pnpm deps:audit` passed again in current-head CI run `34030937041` on evidence head `224955d`, after the admin React Router advisory fix (`bb54899`) and storefront transitive security floors (`4eb150d`).
- [x] **PERF-1 — cap checkout line count.** Landed in `39a97e4`; the public checkout now rejects an excessive cart-line count before entering the stock-operation path.
- [x] **CI-1 — include dependency audit in CI.** Landed in `e9b1b67`; current-head CI run `34030937041` proves the production dependency audit executes after frozen installs and passes.
- [x] **REPO-1 — public/source-available hygiene.** Explicit tracked-file hygiene scan at `4eb150d` found no accidental runtime/log/scratch artifacts; a Gitleaks scan across 409 commits found no leaks; tracked env files are examples. README, CONTRIBUTING and LICENSE consistently identify SellRight as BSL 1.1 source-available rather than OSI Open Source before the Change Date. Historical audit/readiness docs remain intentional evidence.
- [x] **REPO-2 — contribution/license guidance.** Landed in `224d11e`; CONTRIBUTING documents BSL 1.1, the <=25 Covered Persons production grant, and contribution licensing.
- [x] **OPS-1 — protect `main`.** Verified at evidence head `224955d`: strict branch protection, enforced for admins, requires `Core + admin / Node 24 LTS`, `Storefront build / Node 24 LTS`, `PostgreSQL 17 integration`, `Production container smoke / Node 24 LTS`, and `JavaScript / TypeScript security analysis`; pull requests are required for normal changes, force-push/deletion are disabled, and conversation resolution is required.
- [ ] **PAY-1 — real Stripe test-key E2E.** Against a disposable/test store: cart -> checkout -> PaymentIntent/3DS-capable confirmation -> webhook -> Paid -> refund. This requires configured test credentials; never use live customer data.
- [x] **OPS-2 — backup/restore drill.** Production-container CI proves backup and restore into a disposable database; current-head run `34030937041` passed the `Prove database backup and restore` step.
- [x] **OPS-3 — installation/reboot smoke.** Production-container current-head CI run `34030937041` passed first-run/startup checks plus `Prove persistent-volume reboot and idempotent bootstrap`.

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

P0 is the 0.1.0 launch-candidate gate. P1/P2 are roadmap work and may ship incrementally after 0.1.0. Every item closes only with executable or repository evidence, not by documentation claim. P0 is not complete while PAY-1 remains open, so SellRight is not yet a 0.1.0 launch candidate.