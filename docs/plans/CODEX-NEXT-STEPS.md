# SellRight — Codex next steps

Generated: 2026-09-06

## Objective

Finish the SellRight 0.1.0 release gate from the current protected `main`, then continue only into the locked P1/P2 roadmap when its canon gates permit it. Do not restart the release audit or redesign SellRight.

At handoff preparation, proven-green `main` was `7e3ed35c0879eaf6d6bceb0f53ec9b30966816a0` (`docs: refresh launch gate evidence`), with CI `34031428018` and CodeQL `34031427999` successful. **Do not assume that SHA is still current.**

## First action

1. Fetch actual current `main` before doing anything else.
2. Confirm the current head's CI and CodeQL state.
3. Read, in order:
   - `docs/plans/REMAINING-WORK.md`
   - `docs/FEATURES.md`
   - `AGENTS.md`
   - `README.md`
4. Treat `docs/plans/REMAINING-WORK.md` as the canonical current backlog and locked P1/P2 contract.
5. Do not use `.blueprint/manifest.json` as execution truth.

## Current launch state

All canonical P0 gates are closed except **PAY-1**. The completed gates are DEP-1, PERF-1, CI-1, REPO-1, REPO-2, OPS-1, OPS-2 and OPS-3.

Current hardening includes:

- clean production dependency audit;
- checkout public line-count bound;
- dependency audit enforced in CI;
- BSL 1.1/source-available repository hygiene and contribution guidance;
- successful backup/restore and persistent-volume reboot/idempotent-bootstrap CI receipts;
- protected `main` with the five required GitHub checks;
- Node 24.20.0 + pnpm 11.25.0 launch toolchain.
## PAY-1 — the only 0.1.0 blocker

Required receipt, against a disposable/test store using Stripe test mode:

`cart -> checkout -> PaymentIntent -> 3DS-capable confirmation -> Stripe-signed webhook -> order Paid -> refund -> refund reconciliation`

Rules:

- Use Stripe **test** credentials only. Never use live customer data or live payment credentials for this receipt.
- Do not substitute mocks, provider-contract tests or a synthetic webhook for the real Stripe test-mode E2E.
- Do not print, copy or inspect secret values. Use credentials already injected into the authorized test environment.
- If the required Stripe test credentials are not configured, PAY-1 remains open. Report the exact missing configuration by variable/configuration name only and do not mark the release gate complete.
- Exercise the real storefront/API path rather than a one-off script that bypasses SellRight's shopper flow.
- Preserve store-scoped payment idempotency, webhook mode binding, settled-tender accounting and fail-closed refund behavior.

After the transaction/refund succeeds, preserve evidence sufficient to identify the test-mode payment/refund and the resulting SellRight order state without committing secrets or sensitive payment material.

## Close PAY-1

Once the real receipt exists:

1. Update only the evidence/status needed in `docs/plans/REMAINING-WORK.md`; do not rewrite architecture.
2. Mark PAY-1 complete with the actual runtime receipt.
3. State that P0 is closed and SellRight qualifies as a 0.1.0 launch candidate only after that documentation change reaches `main` and current-head CI + CodeQL are green.
4. Use a PR. `main` is protected for admins as well.

## Protected-main workflow

Normal changes must go through a branch/PR. Required strict checks are:

- `Core + admin / Node 24 LTS`
- `Storefront build / Node 24 LTS`
- `PostgreSQL 17 integration`
- `Production container smoke / Node 24 LTS`
- `JavaScript / TypeScript security analysis`

Force-push and branch deletion are disabled; conversation resolution is required.
## P1 after launch-candidate closure

The P1 scope is locked in `docs/plans/REMAINING-WORK.md`. Do not re-architect it. Default order is:

1. **CAT-1 — variant matrix generator**
2. **OPS-4 — order/customer notes**
3. **GROW-1 — abandoned-cart recovery**

**PAY-2 is not fourth in the queue.** It starts only when a named deployment demonstrates a concrete need for a second shopper payment provider. Stripe remains the default.

For every P1 item, follow the canonical trigger, locked scope, non-goals and close-evidence clauses verbatim. Small implementation choices may follow current code, but scope expansion requires an explicit canon amendment backed by a concrete requirement.

## P2 is trigger-gated

Do not implement TAX-1, SHIP-1, ASSET-1 or SEARCH-1 merely because they are listed. Each is forbidden until its canon trigger is true:

- TAX-1: actual second tax implementation/external compliance provider.
- SHIP-1: actual second shipping calculator/provider, carrier requirement or weight-tier deployment need.
- ASSET-1: actual S3/R2/object-storage or multi-replica requirement.
- SEARCH-1: measured Postgres search inadequacy or a concrete second search backend requirement.

When a trigger becomes true, extract only the minimum seam needed to support the existing built-in implementation plus the concrete second implementation. Do not create a generic plugin framework.

## Dependency policy

- Preserve Node 24.20.0 and pnpm 11.25.0 for launch/runtime validation.
- Do not move launch runtime to Node 26 Current.
- Do not merge Dependabot majors indiscriminately.
- Hold React, router, Tailwind, Vite, plugin-react, Stripe JS, Node type-line and Qwik behavioral majors unless a concrete security/compatibility requirement justifies the move and CI proves it.
- Prefer the smallest compatible patch/minor/override. A security advisory may justify a major only when the patched line genuinely requires it and the affected surface is validated.
## Do not reopen known-good architecture without contrary evidence

Keep the following settled for this work:

- server-authoritative pricing/shipping totals;
- store-scoped payment idempotency and settled-tender amount-due accounting;
- settle-after-cancel reconciliation;
- gift-card ledger integrity;
- fail-closed ambiguous refunds;
- FORCE RLS / non-owner isolation;
- native Argon2id plus narrow legacy SellRight scrypt upgrade;
- immutable production API/admin images and current bootstrap/readiness/CSP path;
- current cached hostname resolver.

Vendure/Damned Designs compatibility belongs in migration/adapter tooling. NMI/Sezzle parity is not a SellRight launch requirement.

## Working-tree warning

A prior local release-hardening checkout contained an unrelated uncommitted `packages/storefront/.env.example` edit. Do not sweep it into a commit. In particular, a local rename from `LISTMONK_LIST_ID_DAMNED` to `LISTMONK_LIST_ID` was not committed because current storefront code still consumes `LISTMONK_LIST_ID_DAMNED`.

Always stage explicit files and preserve unrelated user changes.

## Definition of finished release-hardening

Do not report SellRight release-hardening complete until all of these are simultaneously true on actual current `main`:

- PAY-1 has a genuine Stripe test-mode payment + webhook + Paid + refund receipt;
- PAY-1 is marked complete in canonical `docs/plans/REMAINING-WORK.md` with actual evidence;
- all P0 items are checked complete;
- the five protected GitHub checks are green on the current head;
- `main` protection remains enabled.

P1/P2 do not block the 0.1.0 launch candidate. They are locked post-candidate roadmap contracts and must not be pulled into PAY-1 closure.