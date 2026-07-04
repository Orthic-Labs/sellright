# Box validation runbook — phase-2 branches → merge → deploy (hand-off, 2026-07-04)

**For the next agent.** Phase-1 (6 security + hygiene lanes) is on `main` and box-validated. Phase-2 is 6 branches; **MONEY-1 is box-green, the other 5 still need `test:db` on the box.** This is the concrete, already-proven procedure — not generic advice. The audit backlog (unbuilt findings) is the ledger at the end of `DISPATCH.md`, not this file.

## Current state (git)

| Branch | Head | Box `test:db` | Notes |
|---|---|---|---|
| `main` | `4d0b517` | ✅ 47/47 | phase-1 merged + validated |
| `feat/money-payment-idempotency` (MONEY-1) | `2c75e9f` | ✅ **51/51** | one real bug already found+fixed (42P10) |
| `fix/money-refund-idempotency` (MONEY-2) | `0b4dee8` | ⏳ pending | already merges the fixed MONEY-1; gateway-out-of-txn deferred |
| `fix/money-draft-license` (MONEY-3) | `b195602` | ⏳ pending | independent |
| `feat/ops-host-routing-cors` (OPS-1) | `bd53f62` | ⏳ pending | independent |
| `fix/ops-job-leader-lock` (OPS-2) | `2bc2f69` | ⏳ pending | independent |
| `fix/sec-rbac-refunds` (SEC-6) | `bcd74c1` | ⏳ pending | independent; touches `packages/admin` |
| PERF-1 | — | — | NO-OP (index exists) — no branch |

## Box access (proven this session)

- SSH: agent at `/tmp/ssh-dd-sock`, key `~/.ssh/id_ed25519`, alias `dd` (`~/.ssh/config.dd`). See `.claude/rules/ssh-server-access.md`. Run remote commands with `bash -lc` (pnpm is only on the **login** PATH).
- pnpm on the box is **10.34.1**; the repo pins 11.9.0 — always invoke `corepack pnpm@11.9.0 …`, never bare `pnpm`.
- The dev API `sellright-api` runs under pm2 from `~/sites/sellright/packages/api/dist/index` on `:3300`, DB `sellright_dev`. **Do not disturb it** — validate in a separate worktree.
- `sellright_test` (native cluster `:5433`) is **already provisioned** (created + migrated through 0036 + app-role granted, this session). Roles: owner `sellright`, app `sellright_app`.

### Test DB URLs (secrets by location — do NOT commit them)
Take the owner + app connection strings from `~/.sellright/env` on the box (`DATABASE_URL_OWNER`, `DATABASE_URL_APP`) and swap the trailing `/sellright_dev` → `/sellright_test`:
```bash
export DATABASE_URL='<DATABASE_URL_OWNER, db=sellright_test>'          # owner: seed/wipe/migrate
export DATABASE_URL_NONOWNER='<DATABASE_URL_APP,  db=sellright_test>'  # app role: real RLS assertions
```
The RLS suite refuses any non-`_test` DB, and exercises real RLS only when the two URLs differ (owner vs app).

## Per-branch validation (the loop that caught MONEY-1's bug)

A validation script is on the box at `/tmp/sr-validate-branch.sh` (re-create from below if gone). It uses a dedicated worktree `~/sr-validate` so the running dev deploy is untouched.

```bash
#!/usr/bin/env bash
set +e
export PNPM_HOME="$HOME/.local/share/pnpm"; export PATH="$PNPM_HOME:$PATH"
BR="$1"
export DATABASE_URL='<owner @ sellright_test>'
export DATABASE_URL_NONOWNER='<app @ sellright_test>'
WT=~/sr-validate
[ -d "$WT" ] || git -C ~/sites/sellright worktree add -q --detach "$WT" origin/main
cd "$WT"; git fetch origin -q
git checkout -q --detach "origin/$BR" && git reset --hard -q "origin/$BR"
echo "=== $BR @ $(git rev-parse --short HEAD) ==="
corepack pnpm@11.9.0 install --frozen-lockfile >/dev/null 2>&1 && echo "install ok" || echo "install FAIL"
cd packages/api
corepack pnpm@11.9.0 db:migrate 2>&1 | grep -iE 'applied|error' | tail -2   # MONEY-1 applies 0037; others no-op
corepack pnpm@11.9.0 db:assert-hand-written 2>&1 | tail -1
corepack pnpm@11.9.0 db:assert-rls        2>&1 | tail -1
corepack pnpm@11.9.0 typecheck >/dev/null 2>&1 && echo "typecheck ok" || echo "typecheck FAIL"
corepack pnpm@11.9.0 test:db 2>&1 | grep -E 'Test Files|Tests|FAIL' | tail -6
```
Run: `ssh -F ~/.ssh/config.dd dd 'bash -l /tmp/sr-validate-branch.sh <branch>'`. A branch is GREEN only when typecheck ok AND `test:db` reports 0 failed. **Read the failures** — MONEY-1 passed typecheck + migrate + assert-rls and still failed `test:db` on 8 subscription tests; that is the whole point of this pass.

Validate in this order (MONEY-2 depends on MONEY-1 being applied to the test DB first):
1. `feat/money-payment-idempotency` — ✅ already 51/51 (re-run to confirm on your checkout).
2. `fix/money-refund-idempotency` — confirm refund idempotency-key + concurrent return-approve tests.
3. `fix/money-draft-license`, `feat/ops-host-routing-cors`, `fix/ops-job-leader-lock`, `fix/sec-rbac-refunds` — independent, any order.

If a branch fails: fix on the **laptop** (`D:\Claude\sellright`, add a worktree for the branch), commit, push, re-validate. Do not edit product code on the box.

## Merge (after each branch is box-green)

Merge on the laptop off `origin/main`, re-run the merge result's `verify` + `test:db` on the box, then push:
```
MONEY-1 → main   (brings migration 0037; run db:migrate on sellright_test after)
MONEY-2 → main   (already contains MONEY-1 via merge; merge cleanly)
MONEY-3, OPS-2, SEC-6, OPS-1 → main   (independent, --no-ff each, re-gate between)
```
After all merges: sync `docs/FEATURES.md` + `docs/COMMERCE-GAP-ANALYSIS.md` rows and flip the DISPATCH ledger statuses to ✅ in the same commit.

## Deploy (make it live — separate, confirm scope first)
`main` is NOT live until deployed. To deploy the dev API on the box:
```bash
cd ~/sites/sellright && git pull --ff-only origin main
corepack pnpm@11.9.0 install --frozen-lockfile
corepack pnpm@11.9.0 -r build          # compiles packages/api → dist/ (pm2 runs dist)
cd packages/api && DATABASE_URL='<owner @ sellright_DEV>' corepack pnpm@11.9.0 db:migrate   # applies 0037 to DEV
pm2 restart sellright-api
```
**Storefront smoke** (the "does it actually work" gate the audits demand): hit `/v1/health`, a catalog read, and a full cart→checkout→pay against Stripe **test** keys; confirm a license issues and the confirmation email fires. This is a human/taste gate, not an agent claim of "done".

⚠️ **SEC-6 deploy note:** the new `refunds`/`cancel_orders`/`releases` keys are deny-by-default for staff — existing staff accounts lose those abilities until an owner grants the keys in the admin Staff Permissions UI. Grant before/at cutover.

## Deferred within built lanes (tracked, not blockers)
- MONEY-2 item (3): gateway call still inside the txn — a future lane should split claim→gateway→finalize with restock deferred (restock-timing behavior change, not mechanical).
