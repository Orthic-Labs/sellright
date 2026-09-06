# Remaining work — SellRight

Last reconciled: 2026-09-06 · evidence head `7e3ed35` · CI `34031428018` · CodeQL `34031427999`

This is the canonical current backlog. Historical audit/dispatch documents remain evidence, not execution truth. When they disagree, current code + current CI + this file win.

## Current release posture

SellRight has no known critical release-blocking correctness defect at evidence head `7e3ed35`. CI run `34031428018` and CodeQL run `34031427999` are green on Node 24 LTS across:

- core + admin build/typecheck/unit tests;
- PostgreSQL 17 migrations + DB integration + RLS/isolation assertions;
- storefront production build;
- production API/admin container smoke + bootstrap/readiness/CSP;
- CodeQL JavaScript/TypeScript analysis.

The remaining P0 launch work is one real Stripe test-key end-to-end payment receipt. Product-breadth work follows separately and must not be mistaken for a release blocker.

## P0 — close before calling 0.1.0 a launch candidate

- [x] **DEP-1 — production dependency audit clean.** `pnpm deps:audit` passed again in current-head CI run `34031428018` on evidence head `7e3ed35`, after the admin React Router advisory fix (`bb54899`) and storefront transitive security floors (`4eb150d`).
- [x] **PERF-1 — cap checkout line count.** Landed in `39a97e4`; the public checkout now rejects an excessive cart-line count before entering the stock-operation path.
- [x] **CI-1 — include dependency audit in CI.** Landed in `e9b1b67`; current-head CI run `34031428018` proves the production dependency audit executes after frozen installs and passes.
- [x] **REPO-1 — public/source-available hygiene.** Explicit tracked-file hygiene scan at `4eb150d` found no accidental runtime/log/scratch artifacts; a Gitleaks scan across 409 commits found no leaks; tracked env files are examples. README, CONTRIBUTING and LICENSE consistently identify SellRight as BSL 1.1 source-available rather than OSI Open Source before the Change Date. Historical audit/readiness docs remain intentional evidence.
- [x] **REPO-2 — contribution/license guidance.** Landed in `224d11e`; CONTRIBUTING documents BSL 1.1, the <=25 Covered Persons production grant, and contribution licensing.
- [x] **OPS-1 — protect `main`.** Verified at current evidence head `7e3ed35`: strict branch protection, enforced for admins, requires `Core + admin / Node 24 LTS`, `Storefront build / Node 24 LTS`, `PostgreSQL 17 integration`, `Production container smoke / Node 24 LTS`, and `JavaScript / TypeScript security analysis`; pull requests are required for normal changes, force-push/deletion are disabled, and conversation resolution is required.
- [ ] **PAY-1 — real Stripe test-key E2E.** Against a disposable/test store: cart -> checkout -> PaymentIntent/3DS-capable confirmation -> webhook -> Paid -> refund. This requires configured test credentials; never use live customer data.
- [x] **OPS-2 — backup/restore drill.** Production-container CI proves backup and restore into a disposable database; current-head run `34031428018` passed the `Prove database backup and restore` step.
- [x] **OPS-3 — installation/reboot smoke.** Production-container current-head CI run `34031428018` passed first-run/startup checks plus `Prove persistent-volume reboot and idempotent bootstrap`.

## Locked delivery rules for P1/P2

The contracts below are canonical scope locks, not invitations to redesign SellRight. Local implementation mechanics may change when tests or current code require it, but scope, trigger, non-goals and closure evidence may change only through an explicit canon amendment backed by a concrete requirement or contrary evidence.

- **P1 start gate:** begin P1 only after P0 is closed unless Adrian explicitly reprioritizes it. Default implementation order is CAT-1 -> OPS-4 -> GROW-1. PAY-2 is trigger-only and does not enter the sequence until a concrete deployment requires it.
- **P2 trigger gate:** do not manufacture an abstraction before the named second implementation, deployment need or measured scale condition exists. A hypothetical future implementation is not a trigger.
- **Compatibility rule:** preserve the known-good commerce, isolation, payment and deployment invariants below. Historical Vendure/Damned Designs parity is not authority for core design.
- **Completion rule:** close an item only with focused executable evidence plus the repository's protected CI/CodeQL signal where the change reaches those surfaces.

## P1 — first product-completeness work after launch candidate

- [ ] **CAT-1 — variant matrix generator.**
  - **Trigger:** P0 is closed and CAT-1 is the next default P1 item.
  - **Locked scope:** add an admin operation that derives the Cartesian product of a product's existing option groups/values and creates only missing variant combinations using the schema's existing option/variant links. Re-running the operation must be idempotent and existing variants must remain intact.
  - **Non-goals:** catalog-schema redesign, bulk pricing policy, inventory-policy redesign, or a generalized product-generation framework.
  - **Close evidence:** focused generator tests covering full generation, partial-existing matrices, duplicate prevention and repeat-run idempotence; admin typecheck/build/tests; protected CI/CodeQL green.
- [ ] **OPS-4 — order/customer notes.**
  - **Trigger:** CAT-1 is closed, or Adrian explicitly reprioritizes OPS-4 within P1.
  - **Locked scope:** add store-scoped operator notes to orders and customers with immutable author and timestamp metadata; provide create/read API behavior and surface the notes in the relevant admin timelines.
  - **Non-goals:** CRM, ticketing, arbitrary workflow automation, or replacement of existing system/audit events.
  - **Close evidence:** persistence/API tests for author/timestamp and store isolation, admin create/render coverage, protected CI/CodeQL green.

- [ ] **GROW-1 — abandoned-cart recovery.**
  - **Trigger:** OPS-4 is closed, or Adrian explicitly reprioritizes GROW-1 within P1.
  - **Locked scope:** reuse the existing cart lifecycle, scheduler, email outbox and templates; add an opt-in store/admin setting and an idempotent eligibility/recovery job that cannot send duplicate recovery messages for the same eligibility window.
  - **Non-goals:** generalized marketing automation, campaign builder, new queue platform, or replacement of the existing outbox/scheduler.
  - **Close evidence:** tests for enabled/disabled behavior, eligibility timing, duplicate suppression and outbox delivery; relevant admin coverage; protected CI/CodeQL green.

- [ ] **PAY-2 — second shopper payment provider only on demonstrated demand.**
  - **Trigger:** a named target deployment has a concrete requirement that Stripe cannot satisfy or explicitly requires another shopper gateway.
  - **Locked scope:** implement that provider through the existing `PaymentProvider` boundary with isolated configuration, payment/refund behavior, webhook/reconciliation handling and provider-specific tests. Stripe remains the default shopper provider.
  - **Non-goals:** NMI/Sezzle parity, speculative gateway breadth, generic plugin SDK work, or changing core payment semantics to accommodate historical Vendure/DD behavior.
  - **Close evidence:** provider contract tests plus a real sandbox/test-mode payment/refund receipt for the deployment that triggered the work; protected CI/CodeQL green.

## P2 — architecture seams when the second implementation exists

- [ ] **TAX-1 — `TaxProvider` seam.**
  - **Trigger:** a second tax calculation implementation or external compliance provider is actually required.
  - **Locked scope:** extract the minimum provider contract that preserves the current country/zone calculation as the built-in implementation; add tax classes first when the concrete provider requires class-aware behavior.
  - **Non-goals:** speculative tax SDK, generalized plugin framework, or replacing the built-in path without a second implementation.
  - **Close evidence:** built-in and second-provider implementations pass the same checkout/tax contract tests; migration/backward-compatibility coverage where required; protected CI/CodeQL green.

- [ ] **SHIP-1 — formal shipping provider/calculator seam + weight tiers.**
  - **Trigger:** a second shipping calculator/provider, carrier integration, or concrete deployment requirement for weight-tier calculation exists.
  - **Locked scope:** extract the minimum calculator/provider boundary while preserving flat/conditional shipping as the built-in path; reuse existing variant weight/dimensions for weight-tier behavior.
  - **Non-goals:** broad carrier/label ecosystem, speculative rate marketplace, or unrelated fulfillment redesign.
  - **Close evidence:** built-in and triggered second calculator/provider pass shared shipping/checkout-total contracts, including weight boundaries; protected CI/CodeQL green.

- [ ] **ASSET-1 — `AssetStorage` seam.**
  - **Trigger:** a deployment requires S3/R2-compatible object storage or multi-replica operation makes local disk insufficient.
  - **Locked scope:** extract the minimum storage contract around existing asset lifecycle operations, retain disk as the default implementation, and add the concrete S3/R2-compatible adapter that triggered the seam.
  - **Non-goals:** DAM, image-processing platform, CDN abstraction, or multi-backend framework without a deployment requirement.
  - **Close evidence:** shared disk/object-storage contract tests for write/read/delete and relevant failure behavior, plus integration evidence against the selected object store; protected CI/CodeQL green.

- [ ] **SEARCH-1 — search provider/index seam.**
  - **Trigger:** measured catalog/query behavior shows the Postgres path is inadequate, or a concrete deployment requires a second search backend.
  - **Locked scope:** preserve Postgres as the default and extract only the query/index boundary required by the demonstrated problem; add a denormalized/external index only when that trigger exists.
  - **Non-goals:** default faceted/typo-tolerant search, speculative indexing infrastructure, or replacing Postgres without measured evidence.
  - **Close evidence:** documented trigger evidence plus shared search-contract tests for Postgres and the second backend, with correctness and relevant performance evidence; protected CI/CodeQL green.

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

P0 is the 0.1.0 launch-candidate gate. P1/P2 are locked roadmap contracts and may ship incrementally after 0.1.0 under the trigger/order rules above. Every item closes only with executable or repository evidence, not by documentation claim. P0 is not complete while PAY-1 remains open, so SellRight is not yet a 0.1.0 launch candidate.