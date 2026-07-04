# Remaining work — SellRight goal (2026-07-05)

SellRight is **code-complete and box-validated**: all 12 original lanes + all 21 §3a BUILD lanes + the zod 4 / `@hono/zod-openapi` 1 migration + the MONEY-1 `0037` fix are merged to `main` and green on the box (`test:db` 131 pass, non-DB 215 pass, typecheck + build OK). **Laptop = origin = box `~/sites/sellright` all at the same `main`.** DEFER (§3b) and DECIDE (§3c) items in `DISPATCH.md` remain intentionally deferred with reasons; the dependency majors are `DEPS-1` (ts6/@types/node26/api-vite8/@stripe/stripe-js9/graphql17 — each its own migration).

Two things are NOT done, both requiring steps an agent cannot safely take alone:

## 1. Deploy to the box (hook-gated DB ops → Adrian runs)
`main` is validated but **not live** — the box `sellright-api` still runs pre-merge `dist/`, and `sellright_dev` (a Damned clone, 13,544 payments) is behind + has a migration-journal drift I introduced while diagnosing (0035/0036 applied out-of-band; a stray journal marker). The migration to current `main` includes `0037` (which now nulls the `'imported'` placeholders, safe) + `0038` (email outbox). The destructive steps (DROP/DELETE/ALTER, `dropdb`) are **hard-blocked by the `prod-db-guard` hook** (correctly — it protects the Damned clone), human-bypass only. Adrian, from your own terminal on the box:
```bash
cd ~/sites/sellright && git pull --ff-only origin main
corepack pnpm@11.9.0 install --frozen-lockfile && corepack pnpm@11.9.0 -r build
(cd packages/admin && corepack pnpm@11.9.0 install --ignore-workspace && corepack pnpm@11.9.0 build)
# reconcile sellright_dev journal (it's mid-drift): easiest is to confirm which of 0035..0038
#   are physically applied, then `DATABASE_URL=<owner @ sellright_dev> corepack pnpm@11.9.0 db:migrate`
#   (0037 nulls 'imported' → indexes; 0038 adds email_outbox). Verify payment count stays 13,544.
pm2 restart sellright-api
```
Then storefront smoke (health, catalog, a Stripe **test**-key cart→checkout→pay) + grant the SEC-6 permission keys (`refunds`/`cancel_orders`/`releases`) to staff who need them. Full runbook: `BOX-VALIDATION-CHECKLIST.md` §Deploy.

## 2. Merge SellRight → RightApps (needs careful hand-merge on a live fork)
RA (`~/sites/rightapps`, DB `rightapps`, pm2 `rightapps-api :3301`) forked from sellright at `25c4b35`; it is now **94 behind / 81 ahead**. `git merge upstream/main` produces **10 conflicts** — I aborted (RA is clean at `3bfb08d`) rather than rush load-bearing app-store code at the tail of a long session. Resolution plan:

**Mechanical (union / small):**
- `pnpm-lock.yaml` → regenerate with `pnpm install` after resolving package.json.
- `packages/api/package.json` → union deps (take zod 4 + all upstream) + union the `test`/`test:db` lists + keep RA-specific scripts.
- `docs/runbooks/migrations.md`, `packages/api/src/db/assert-hand-written-migrations.ts` → union the hand-written-migration registrations (0037/0038 from upstream + any RA-specific).
- `packages/api/src/routes/admin-assets.ts` (2 lines) → take upstream (sharp `Metadata` import fix).
- `packages/api/src/store-context.ts` → take upstream's OPS-1 host-routing block, but **keep RA's `DEV_DEFAULT_STORE = 'rightapps'`** (not `'damned'`).

**Needs judgment (both sides changed real logic):**
- `packages/api/src/routes/store-context.ts` (RA +26/-5: RA's `appKey`-by-Host resolution for the app stores) vs upstream's OPS-1 `resolveStoreForRequest`. **Combine** — RA's per-app appKey resolution must survive; graft upstream's host→store lookup around it. This is the riskiest file (drives which app store a request hits).
- `packages/api/src/routes/account.ts` (RA +59: RA-specific account features) vs upstream's COMP-2 (GDPR delete + export). Additive on both sides — keep both, verify no duplicate route paths.
- `packages/api/src/app.ts` (RA +5) + `app.test.ts` (RA +16) vs upstream OBS-1/OBS-2/CORS. Additive — keep both middleware/route registrations.

**After merge:** RA validates against DB **`rightapps`** (not `sellright_test`) — run `pnpm build` + RA's own tests, smoke the app-store host resolution, then `pm2 restart rightapps-api`. Push `origin/main` (rightapps) and pull on the laptop so RA also matches box=laptop=remote. RA also carries the zod 4 migration now, so expect the same `z.string().uuid()`→`z.guid()` / `J`-generic patterns already applied upstream to flow in via the merge.
