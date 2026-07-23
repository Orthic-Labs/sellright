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
license-gate wiring belongs in `D:\Claude\rightsites`.

When RightApps needs product changes, sync from SellRight with upstream fetch
and merge rather than editing the fork first.

### Run product changes past Adrian (locked 2026-07-20)

**SellRight is the product, not a website.** Anything changed here is inherited
by the e-commerce backend and every store built on it — DD, RH, SS, RightSites,
and future stores. Before editing anything in this repo, classify the change:

1. **Genuinely product-level** (every store wants it) — still run it past Adrian
   before committing. Do not self-certify.
2. **Right-apps-only** — it does not belong here. Use the RightSites process, or
   ask.

Deciding *which* of those a change is, is Adrian's call, not the agent's. The
failure this rule exists to prevent: a Right Suite-shaped problem gets fixed in
SellRight because the surrounding feature already lives here, so the change
*looks* product-level and the agent classifies it itself. That is the whole
mistake — the feature already being here is not evidence that a new constraint
on it is product-level.

This applies to behaviour changes, schema changes, and validation. It does not
apply to fixing a doc to match what Adrian has already stated.

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

An explicit user request is the approval for every step of it. This repo's gates (bakeoff, release, QA, review) govern only unrequested spend, destructive/production steps, or specifics the user must see (e.g. a run packet) — and then only that single step; all other requested work is completed first, never left undone pending approval. Offering is the same defect as asking: "say the word and I'll trace it" / "let me know and I'll do it" — if it is in scope of the request, do it and report what you found; an unresolved "I have not found X" at the end of a turn is unfinished work, not a status report. Supersedes any stricter reading of this repo's gates. Canonical: workspace `CLAUDE.md` §1C / `AGENTS.md` "User Intent Is Final".

## No solution + caveat (workspace rule, locked 2026-07-19)

Work is either in perfect shape or it needs fixing — and if it needs fixing, fix it now, in this turn. Never close a reply with a hedge ("one thing worth flagging", "one caveat", "the honest limit is", "that said…"). Three legitimate endings only: done and verified with evidence; a genuine failure stated in the body with the real output; or a hard blocker naming the input required. If a caveat is worth writing, it is worth fixing first. Canonical: workspace `CLAUDE.md` §1D / `AGENTS.md` "No Solution + Caveat".
