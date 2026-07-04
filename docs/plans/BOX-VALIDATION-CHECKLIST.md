# Box validation checklist — phase-2 DB/money lanes (2026-07-04)

Phase-1 (6 pure-code security lanes) is **merged + pushed to `main`** (validated on the laptop: typecheck + 169 unit tests + build + deps:audit). This checklist covers the **7 phase-2 lanes** that touch migrations, the DB, or need `pnpm test:db` — which has **no local test DB on the laptop** (`:5433` absent), so they were built + typechecked + code-reviewed on branches and **pushed unmerged**. They must be validated on the box (native Postgres `sellright_test` on `:5433`) before merge.

Every branch **typechecks clean** locally (api; SEC-6 also admin). None has run `pnpm test:db`.

## Branches (all pushed to `origin`, NOT merged)

| Lane | Branch | Head | Adds migration | New DB tests | Notes |
|---|---|---|---|---|---|
| MONEY-1 | `feat/money-payment-idempotency` | `0b37c45` | **0037** (partial unique) | `pay-idempotency.test.ts` | merge FIRST |
| MONEY-2 | `fix/money-refund-idempotency` | `11ee251` | none | `admin-orders.refund.test.ts` | **stacked on MONEY-1** — merge AFTER it |
| MONEY-3 | `fix/money-draft-license` | `b195602` | none | `admin-order-draft-license.test.ts` | independent |
| OPS-1 | `feat/ops-host-routing-cors` | `bd53f62` | none (uses `store.config`) | `store-context.db.test.ts`, `app.cors.db.test.ts` | independent |
| OPS-2 | `fix/ops-job-leader-lock` | `2bc2f69` | none | `release-stale-allocations.test.ts` | independent |
| SEC-6 | `fix/sec-rbac-refunds` | `bcd74c1` | none | `admin-rbac-sensitive.test.ts` | touches `packages/admin` too |
| PERF-1 | — (**no branch**) | — | — | — | **NO-OP — do nothing** |

**PERF-1 is a verified no-op:** `(store_id, code)` already exists as the `order_store_code` UNIQUE constraint (`schema-orders.ts:72`, created in `0000`), which Postgres backs with a B-tree index. All four indexes the perf audits flagged as "missing" actually exist. No migration.

## Migration numbering — no collision

Only **MONEY-1** adds a migration (`0037_payment_provider_ref_unique.sql` + journal `idx 37` + registered as the 4th hand-written file in `assert-hand-written-migrations.ts` + `docs/runbooks/migrations.md`). Highest on `main` is `0036`, so `0037` is free — no renumber needed. OPS-1 chose `store.config.hostnames` over a `store_domain` table specifically to avoid a migration.

## Per-lane box steps

Run on the box in `~/sites/sellright` (dev) against `sellright_test` on `:5433` — **never** `:5432`/prod, never raw `psql`/`docker` (the `prod-db-guard` hook blocks it). For each branch, in a scratch checkout or worktree off `origin/main`:

```bash
cd ~/sites/sellright && git fetch origin
git checkout <branch>
pnpm install --frozen-lockfile
# migration lanes only (MONEY-1): apply to the TEST db
cd packages/api && DATABASE_URL=…:5433/sellright_test pnpm db:migrate
pnpm test          # non-DB unit subset — must stay green
pnpm test:db       # the lane's new DB tests — THE gate for these lanes
cd ../.. && pnpm run verify   # build + typecheck + tests + assert-rls + assert-hand-written + shop-isolation
```

- **MONEY-1**: confirm `pnpm db:migrate` applies `0037` cleanly on a fresh test DB, `assert-hand-written` passes (marker intact), and `pay-idempotency.test.ts` proves: two settles on the same `(store_id, provider_ref)` → **one** payment row; two stores with the same order-code suffix pay independently; manual/COD (null `provider_ref`) still inserts.
- **MONEY-2**: merge only after MONEY-1 is on `main`; rebase the branch on the merged MONEY-1 if needed. Confirm the refund `idempotencyKey` reaches `refunds.create` and concurrent return-approves yield one refund. **Deferred item (3):** the gateway call still runs inside the txn — a follow-up lane should split claim→gateway→finalize (deferred because moving restock out of the gateway-before-ledger window is a real behavior change, not a mechanical move). Not a blocker for the double-refund fix.
- **MONEY-3**: confirm a draft `markPaid:true` on a licensed line issues exactly the right licenses and a second settlement issues zero more.
- **OPS-1**: set each store's `config.hostnames` (JSONB array) before relying on host routing. Confirm: known host → right store; **unknown host in production → 404** (no silent `damned` fallback); explicit `x-store-slug` still wins; CORS preflight allowed only for configured origins. Pool connect-timeout is now `5000ms` (was `0`) — confirm nothing depended on the infinite wait.
- **OPS-2**: confirm the advisory-lock key namespace (`"SRSP"<<32 | job-index`) doesn't collide with any other advisory lock, and the stale-release SKIP-LOCKED claim releases each allocation exactly once under concurrency.
- **SEC-6** ⚠️ **behavior change to announce before deploy:** the new keys `refunds`/`cancel_orders`/`releases` are **deny-by-default for staff/read_only**. Existing `staff`-role accounts immediately lose refund / order-cancel / release-publish ability on deploy **until an owner/manager grants the keys** (owner/manager are unaffected — they pass via role). Grant the keys to the appropriate staff in the admin Staff Permissions UI at/before cutover. Build `packages/admin` too (the UI permission list changed).

## Recommended merge order (box, after each is green)

1. **MONEY-1** → main (migration + settle idempotency; unblocks MONEY-2).
2. **MONEY-2** → main (rebased on MONEY-1).
3. MONEY-3, OPS-2, SEC-6, OPS-1 — independent, any order. Each `--no-ff`, then `pnpm run verify` on the merge result before the next.

After all merges, sync `docs/FEATURES.md`, `docs/COMMERCE-GAP-ANALYSIS.md`, and the DISPATCH table rows in the same turn (per the studio "sync docs as part of done" rule).

## What was NOT built (correctly deferred, tracked in DISPATCH)
- MONEY-2 gateway-out-of-txn split (restock-timing behavior change).
- Multi-instance Redis rate-limiter (only needed at N≥2 instances).
- Observability floor (pino + `/readyz`).
- Storefront `VITE_SR_CHECKOUT` flag-flip (human gate — needs a live test-card run).
