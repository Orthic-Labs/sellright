# SellRight Agent Instructions

## Workspace Rules

This repo lives inside Adrian's `D:\Claude` workspace. For Codex, read and
apply `D:\Claude\AGENTS.md` before substantial work; this file adds
SellRight-specific rules and does not replace the studio rules.

Claude Code should use the sibling `CLAUDE.md`, which points at
`D:\Claude\CLAUDE.md` and mirrors these local rules.

## Repo Identity

SellRight (`github.com/adrdsouza/sellright`) is the commerce product.
RightApps (`github.com/adrdsouza/rightapps`) is a fork of it for the Right
Suite app stores. They are separate repos and separate directories.

- SellRight laptop path: `D:\Claude\sellright`
- SellRight server path: `~/sites/sellright`
- Dev API: `tsx` on `:3300`
- Dev DB: `sellright_dev`

Edit on the laptop, push `origin/main`, then pull on the box. Do not make
product code edits directly on the server.

## Split Rule

Changes that ship with SellRight belong here first. RightApps-specific code
such as storefront apps, Right Suite catalog scripts, app-store theming, and
license-gate wiring belongs in `D:\Claude\rightapps`.

When RightApps needs product changes, sync from SellRight with upstream fetch
and merge rather than editing the fork first.

## Standard Tooling

Use `pnpm`, not npm, for package management unless a legacy script explicitly
says otherwise.

SellRight has no desktop installer release. Its standardized Right tooling is
for dependency hygiene:

```powershell
pnpm run deps:audit
pnpm run deps:check
pnpm run verify
pnpm run build
pnpm run typecheck
```

The dependency scripts use shared tooling at `../tools/right-release/deps.mjs`
plus `right-release.config.mjs`. Do not remove `packageManager`, `deps:*`, or
pnpm lockfile changes.

## Database Safety

Use the dev/test databases for local work. Do not write production data from a
local session unless Adrian explicitly asks for a production operation and the
target database has been named in the command/handoff.

API tests should target the test database and must not depend on live customer
or store data.

## Verification

For product changes, prefer focused package tests first, then `pnpm run verify`
before claiming broad correctness. For dependency or security hygiene work, run
`pnpm run deps:audit` and `pnpm run deps:check`.

## User intent is final (workspace rule, locked 2026-07-19)

An explicit user request is the approval for every step of it. This repo's gates (bakeoff, release, QA, review) govern only unrequested spend, destructive/production steps, or specifics the user must see (e.g. a run packet) — and then only that single step; all other requested work is completed first, never left undone pending approval. Supersedes any stricter reading of this repo's gates. Canonical: workspace `CLAUDE.md` §1C / `AGENTS.md` "User Intent Is Final".
