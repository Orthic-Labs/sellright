# SellRight Rules

## Purpose
SellRight is the generic commerce product.
RightSites is its Right Suite web-layer fork and owns suite-specific storefront behavior.

## Canonical sources
- Read `README.md` and `docs/ARCHITECTURE.md` for product structure.
- Read parent SSH runbook before server work.
- Read RightSites overlay before cross-fork changes.
- Treat `github.com/bogusyogi/sellright` as origin identity.

## Commands
- Run `pnpm verify` for the broad product gate.
- Run `pnpm build` and `pnpm typecheck` for application changes.
- Run `pnpm deps:audit` and `pnpm deps:check` for dependency changes.
- Run API tests only against the repository's test database.

## Locked invariants
- Put generic commerce changes here before syncing them into RightSites.
- Put Right Suite catalog, site theming, and license-gate wiring only in RightSites.
- The Hetzner checkout and `origin/main` are the source of truth: edit on the server checkout, commit to `main`, push `origin/main`. No long-lived branches.
- Use development and test databases for local work.
- Never target production customer data without an explicit request naming the database and operation.
- Keep tests independent of live store or customer data.

## Verification
- Run focused package tests before `pnpm verify`.
- Run dependency checks for manifest or lockfile changes.
- Prove cross-fork changes in SellRight first, then verify the RightSites merge separately.
