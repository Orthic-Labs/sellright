# Open-Source Readiness Audit — 2026-07-17

Scope: lifecycle, performance, security, scalability of `adrdsouza/sellright` at
commit `74b6eae`, assessed against the question "what must be fixed before this
repo is published publicly?"

Verdict: **the code is not the problem — the packaging is.** No tracked secrets,
no secrets in git history, zero known dependency CVEs, and the security wiring
(auth, CSRF, RLS, webhooks) holds up. Every blocker below is repo hygiene: a
contradictory license, another brand's storefront, internal strategy docs, and
personal ops scripts that would ship with the product.

---

## Blockers — fix before publishing

### 1. LICENSE contradicts open-sourcing

[`LICENSE`](../LICENSE) reads "All rights reserved… proprietary and
confidential. No permission is granted to copy, modify, distribute…". Publishing
the repo under this text tells every reader they may not use it.

**Decision required (Adrian's, not automatable):** permissive (MIT / Apache-2.0)
if the goal is adoption, or source-available (BSL / Elastic-style) if the goal is
adoption *without* a hosted competitor reselling it. Context worth weighing: the
whole reason SellRight exists is that Vendure's GPLv3 was unacceptable, so the
license choice here is a product decision, not a formality.

### 2. `packages/storefront` is the Damned Designs storefront, not a demo

Evidence:

- `packages/storefront/package.json` → `"name": "damned-designs-storefront"`,
  `"homepage": "https://damneddesigns.com/"`, `"license": "UNLICENSED"`,
  description still says "built with Vendure & Qwik"
- DD brand assets and copy throughout `src/` (`constants.ts`, `header.tsx`,
  `footer.tsx`, `ProductCard.tsx`, `seo-schemas.ts`, `HomeTeeSection.tsx`)
- `src/data/trustpilot.json` — real DD review data
- `src/generated/graphql-shop*.ts` — Vendure-era generated GraphQL clients, dead
  weight in a REST-first product

Publishing as-is ships DD's brand inside an OSS codebase and hands readers a
storefront that can't be a starting point. Either genericize it into a neutral
demo storefront or exclude the package from the public repo.

### 3. Internal strategy docs are tracked and linked from the README

Business/competitive material, currently public-facing the moment the repo is:

| Path | Why it shouldn't ship |
|---|---|
| [`docs/MOAT-AND-DISRUPTION.md`](MOAT-AND-DISRUPTION.md) | competitive strategy |
| [`docs/GTM.md`](GTM.md) | go-to-market plan |
| [`docs/COMPETITORS.md`](COMPETITORS.md) | competitor teardown |
| [`docs/MARKET-PLACEMENT.md`](MARKET-PLACEMENT.md) | positioning |
| [`docs/COMMERCE-GAP-ANALYSIS.md`](COMMERCE-GAP-ANALYSIS.md) | gap/roadmap analysis |
| `docs/ADMIN-*-PLAN*.md`, `docs/plans/` | internal WIP plans |
| `rank.md`, `.agent/` | internal tooling state / committed repo graph |

The [README](../README.md) links several of these under "Docs" — trim that
section in the same pass.

### 4. `packages/api/scripts-deploy/` is personal infrastructure

Box-specific ops: `deploy-rightapps-tls.sh`, `nginx-rightapps.conf`,
`nginx-admin.conf`, `sellright-api.service`, `create-tenant-db.sh`, and verify
scripts that hardcode `adrdsouza@gmail.com` (`auth-verify.sh:18`,
`affiliate-commission-test.sh:7`). No secrets in them, but they're Adrian's
deployment, not the product. Move private or genericize into an example deploy.

### 5. Dependency scripts point outside the repo

`package.json` `deps:check` / `deps:audit` / `deps:update` all call
`../tools/right-release/deps.mjs` — a path no cloner has (it doesn't even resolve
on this Mac; it fails with `MODULE_NOT_FOUND`). Vendor the script or drop the
entries. Same class of problem: [`CLAUDE.md`](../CLAUDE.md) and
[`AGENTS.md`](../AGENTS.md) document a private `D:\Claude` workspace and a
specific Hetzner box; rewrite as public contributor guidance.

---

## Clean — verified, not assumed

| Area | Evidence |
|---|---|
| No tracked secrets | only `.env.example` files tracked; `sk_live`/key/password sweep hits only prefix-handling code and test dummies |
| No secrets in history | `git log --all --full-history -- '*.env'` empty; `-S 'sk_live_'` matches only key-handling code |
| Password storage | scrypt + `timingSafeEqual`, self-describing hash (`auth/password.ts`) |
| Session tokens | 32-byte random, only SHA-256 hash stored, TTL enforced (`auth/admin-session.ts`) |
| Login 2FA | TOTP; a 2FA-enabled account with missing code returns a generic 401 — no password-validity enumeration (`routes/admin.ts:40-50`) |
| Brute force | sliding-window throttle, proxy-aware client IP (`cf-connecting-ip` trusted only behind Cloudflare) (`auth/rate-limit.ts`) |
| CSRF | double-submit token on cookie sessions for `/v1/admin/*` and `/v1/shop/*`; bearer clients exempt (`app.ts:81-111`) |
| CORS | per-store allowlist from `store.config.hostnames`; never wildcard-with-credentials (`app.ts:67-76`, `cors-origins.ts`) |
| Error leakage | bodies sanitized unless `DEBUG_ERRORS=1` — an explicit opt-in, not `NODE_ENV`-derived (`app.ts:197-217`) |
| Tenant isolation | Postgres FORCE RLS + `withStore()` GUC; `db:assert-rls` + `assert:shop-isolation` gate `pnpm verify` |
| Payment webhooks | Stripe signature auth, raw body preserved, tenant-scoped (`routes/payment-webhooks.ts`) |
| SSRF | outbound URL guard + `ARTIFACT_EXTERNAL_HOST_ALLOWLIST` defaulting to deny (`security/outbound-url.ts`, `env.ts`) |
| Supply chain | GitHub Actions pinned to commit SHAs (`.github/workflows/verify.yml`) |
| CVEs | `pnpm audit --prod` → **no known vulnerabilities** |
| Lifecycle | fail-fast env validation; graceful shutdown with drain + force-exit watchdog (`index.ts`); `/v1/health` + `/v1/readyz` (DB ping, 1500ms ceiling, sanitized failures) |

---

## Scalability — document, don't block

Self-hosters will hit these; they're honest defaults, not defects.

- **Jobs are multi-instance safe.** Postgres advisory locks elect one leader per
  job tick (`jobs/leader-lock.ts`), so blue/green deploys won't double-run stock
  releases.
- **Login rate limiter is per-process** (`auth/rate-limit.ts`) — in-memory Map.
  Correct for one instance; needs Redis behind a load balancer. The code says so;
  the README doesn't.
- **Assets are local disk** (`ASSET_DIR`) — fine single-box, needs object storage
  when horizontal.
- **DB pool defaults** `PGPOOL_MAX=10`, 5s acquisition timeout (fails fast rather
  than hanging). Raise under load.
- **OpenAPI metadata is placeholder**: title "Commerce Platform API", version
  `0.0.0` (`app.ts:250-253`) — the published contract should carry the real name
  and a real version before it's the public API of an OSS project.

---

## Fixed in this pass

- **Per-line refunds were impossible for any API consumer.** `GET
  /v1/admin/orders/{code}` mapped order lines without their ids, while the refund
  and return endpoints key `lines[].orderLineId` on exactly that id. Fixed in
  `7be6ad6` with a regression test asserting the contract end to end.

## Known gaps (not blockers)

- Refund accepts a per-line `quantity` exceeding the line's remaining refundable
  amount; it's clamped with `Math.min` on write rather than rejected
  (`routes/admin-orders.ts:218-219`). Money is safe — the total is capped at
  `grandTotal - priorRefunded` — but the refund_line ledger can record a quantity
  the server then truncates. The iOS app can't send this (stepper caps at
  refundable qty); a direct API caller can.
- `.pnpm-store/` is untracked at the repo root — cache junk that wants a root
  `.gitignore` entry before publishing.
