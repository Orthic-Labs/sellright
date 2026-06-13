# Handover — Right Apps SellRight instance (for an on-box agent)

**Updated:** 2026-06-13 · **For:** an agent running **on the box** (`vendure@rottenhand`, `5.78.82.156`) with docker-group + sudo access. The off-box agent that did the work below has **neither docker-socket access nor sudo** (and a safety hook blocks `docker exec`), which is why the remaining ops steps are handed over.

**Repo:** laptop `D:\Claude\sellright` → GitHub `origin/main` → box deploy checkout `/home/vendure/sites/sellright` (clean checkout of `origin/main`; `git pull` / `git reset --hard origin/main` to update — **never edit code there**, edit on the laptop). **Latest commit at handover: `08906b5`.**

**First thing to do:** `cd ~/sites/sellright && git fetch origin && git reset --hard origin/main` so you have this doc + all fixes.

---

## 0. IMMEDIATE BLOCKER — public `:443` returns 000 (finish the exposure)

`https://api.spoares.com/v1/health` / `https://admin.spoares.com` hang (`HTTP:000`). Already diagnosed — **don't re-derive**:

- rightapps API origin is UP: `curl http://127.0.0.1:3301/v1/health` → **200**, binds `*:3301`.
- DNS resolves: `admin/api.spoares.com` → `5.78.82.156` (Cloudflare, **DNS-only/grey**).
- TLS is CORRECT: dedicated LE cert `/etc/letsencrypt/live/rightapps/` (`CN=admin.spoares.com`, SAN `admin,api.spoares.com`, full chain), vhost points at it, `:80` redirects (301).
- Brand sites fine (`https://damneddesigns.com` → 200) → nginx healthy.
- The hang is **nginx → upstream**: TLS completes, the HTTP request is sent, nginx never responds (h1 + h2). From the **host**, `curl http://172.22.0.1:3301/v1/health` → 200 (172.22.0.1 = docker bridge gateway, what the vhost proxies to).

**Hypothesis (test first):** a host firewall (ufw / iptables `DOCKER-USER`) allows the docker bridge → the brand backend ports (`:3100/:3300/:9000`) but **not the new `:3301`**, so from *inside* the nginx container `172.22.0.1:3301` is blocked → nginx waits on the upstream → 000.

```bash
# DECISIVE test — does nginx-in-container reach the upstream?
docker compose -f ~/sites/nginx/docker-compose.yml exec nginx-brotli \
  wget -qO- --timeout=5 http://172.22.0.1:3301/v1/health ; echo
#   hangs/fails while the host curl works  ->  it's the firewall.

# See what lets the brand ports through, mirror it for :3301
sudo ufw status numbered | grep -iE "172\.|3100|3300|3301"
sudo iptables -S DOCKER-USER 2>/dev/null
sudo ufw allow from 172.16.0.0/12 to any port 3301 proto tcp   # COPY the exact source the :3100/:3300 rules use

# verify
curl -sI https://api.spoares.com/v1/health        # expect 200
```

**If it's NOT the firewall, check:** `docker logs --tail=50 nginx-brotli`; `/home/vendure/sites/nginx/logs/rightapps-{api,admin}_error.log`; `docker compose exec nginx-brotli nginx -T | grep -A40 "server_name api.spoares.com"` (confirm live config matches `~/sites/nginx/rightapps.conf`).

**When 200:** open `https://admin.spoares.com`, log in (`adrdsouza@gmail.com` / password handed over separately — generated, change it). Optionally flip the 2 CF DNS records to **proxied/orange** afterward (they're grey now).

---

## 1. What is DONE (do not redo)

- **Audit remediation (32 findings from round 1)** — shipped + verified, `pnpm verify` green.
- **Round-2 deep audit fixes** (commits `2842c9d`, `08906b5`), all gate-green (90/90) + deployed:
  - CRITICAL gift-card double-spend → `FOR UPDATE` lock (`checkout.ts`).
  - License issuance idempotency/concurrency (order `FOR UPDATE` + per-line shortfall, `issue.ts`).
  - Perpetual-updates licenses revived (`entitlements.ts`).
  - `/releases/latest.json` requires an app header (`apps.ts`).
  - Refund: exclude `Failed` from `alreadyRefunded` + order `FOR UPDATE` on refund/return-approve (`admin-orders.ts`).
- **Right Apps instance** (its own DB, separate from the DD clone):
  - DB `rightapps` on the **native :5433 cluster** (owner `sellright`, app role `sellright_app`), 28 migrations, 52 tables, 50 FORCE-RLS. DD clone `sellright_dev` untouched.
  - Admin `adrdsouza@gmail.com`; **5 stores** (`viewright`, `coderight`, `heardright`, `mailright`, `scraperight`), owner on each.
  - **`rightapps-api` under PM2** (`pm2 describe rightapps-api`), `:3301`, env `~/.sellright/rightapps.env` (0600), compiled `dist/index.js`, `pm2 save`d.
  - Admin SPA built (`packages/admin/dist`, mounted into nginx).
  - DNS + nginx vhost + dedicated TLS cert (the §0 blocker is the last mile).

---

## 2. Architecture + gotchas (the non-obvious stuff — read before touching anything)

- **Two API instances, two DBs, both on :5433 native cluster:** dev `:3300`→`sellright_dev` (DD clone), **rightapps `:3301`→`rightapps`** (PM2 `rightapps-api`). **NEVER touch the `:5432` `vendure-postgres` Docker container — LIVE production stores.** A `prod-db-guard` hook blocks docker-exec + prod psql + raw `DROP/TRUNCATE/DELETE FROM/ALTER ROLE|DATABASE` (it even false-positives on those words in commit messages — write commit bodies to a file + `git commit -F`).
- **nginx is dockerized** (`nginx-brotli` container, dir `~/sites/nginx/`, configs **baked via Dockerfile `COPY`** → a vhost change needs `sudo docker compose build && up -d`, not a reload). Backends inside the container are at **`172.22.0.1:<port>`** (bridge gateway), NOT `127.0.0.1`.
- **Cloudflare Access is on the `spoares.com` apex** → apex ACME HTTP-01 redirects to a login page. That's why the rightapps cert is a **dedicated cert for admin+api only** (apex excluded), via `deploy-rightapps-tls.sh`. Don't `--expand` the apex.
- **pnpm not on the non-interactive PATH:** use `COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm ...` from a repo dir. `node/certbot/pm2/docker/certbot` standard paths; `nginx` only exists inside the container.
- **DB creds:** `~/.sellright/env` (0600) → `DATABASE_URL_OWNER` + `DATABASE_URL_APP` (both point at `sellright_dev`); swap the trailing db name for others, e.g. `RIGHTAPPS_OWNER="${DATABASE_URL_OWNER%/*}/rightapps"`. The API runs as the **non-owner `sellright_app`** (fail-closed RLS); migrations/seed/scripts run as the owner.
- **Cloudflare DNS:** a CF API token with `spoares.com` zone access is in the laptop PS env (`CLOUDFLARE_API_TOKEN`); the box only has a DD-cache-scoped token. So DNS changes are easiest from the laptop / dashboard.
- **Reusable ops scripts** (committed, `packages/api/scripts-deploy/`): `create-tenant-db.sh`, `grant-app-role.sh` (re-apply `sellright_app` grants to ANY db — required for every new DB **and** `sellright_test`, else "permission denied" under the real app role), `start-rightapps.sh`, `deploy-rightapps-tls.sh`.

### The test gate (run after ANY api change)
```bash
cd ~/sites/sellright/packages/api
set -a; . ~/.sellright/env; set +a
TEST_OWNER="${DATABASE_URL_OWNER%/*}/sellright_test"; TEST_APP="${DATABASE_URL_APP%/*}/sellright_test"
DATABASE_URL="$TEST_OWNER" COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm db:migrate    # apply any new migration to _test
DATABASE_URL="$TEST_OWNER" DATABASE_URL_NONOWNER="$TEST_APP" COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm test
DATABASE_URL="$TEST_OWNER" COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm db:assert-rls
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm assert:shop-isolation
```
Currently **90/90**. New store-scoped tables MUST get FORCE RLS (`assert-rls` enforces it) — copy the pattern from `drizzle/0002_harden_rls_nullif.sql`.

### Redeploy the rightapps instance after a code change
```bash
cd ~/sites/sellright && git pull && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm -r build && pm2 restart rightapps-api
# new migration? apply to rightapps too: DATABASE_URL="${DATABASE_URL_OWNER%/*}/rightapps" corepack pnpm --filter @sellright/api db:migrate
# admin SPA changed? cd packages/admin && corepack pnpm install && corepack pnpm build   (separate, non-workspace toolchain)
# nginx vhost changed? cd ~/sites/nginx && sudo docker compose build && sudo docker compose run --rm nginx-brotli nginx -t && sudo docker compose up -d
```

---

## 3. Track B — Stripe (test-mode first)

Pending the **test secret key** (`sk_test_...`) from Adrian. Then:
1. Add `STRIPE_SECRET_KEY=sk_test_...` to `~/.sellright/rightapps.env`; `pm2 restart rightapps-api`.
2. Create a ViewRight license product + variant via the admin API (or a one-off script): `fulfillmentType=license`, `appKey=viewright`, a price (integer cents), `licenseSeats`, `licenseDurationDays`/`updatesDurationDays`.
3. Validate the full flow (test mode): order → `POST /v1/shop/orders/{code}/payment-intent` → confirm with `pm_card_visa` (server-side via the Stripe SDK) → `POST /v1/shop/orders/{code}/pay` (token = the intent id) → assert order `Paid` AND a `license` row issued (`issueLicensesForPaidOrder` runs on settle).
4. Webhook (after §0 is live): register `https://api.spoares.com/v1/webhooks/stripe` in the Stripe dashboard → put the `whsec_...` in `rightapps.env` as `STRIPE_WEBHOOK_SECRET` → restart. The handler verifies the raw-body signature + is idempotent (`processed_event`).

Provider code is built (`payments/stripe.ts`, `routes/pay.ts`, `routes/payment-webhooks.ts`, `payments/settle.ts`); only the live e2e + keys were pending.

---

## 4. Track C — deep-audit queue (verified-real, deferred; fix with the gate)

The round-2 audit's high-value correctness/security fixes are DONE (§1). These remain — verify each against current code, fix, run the gate, commit. (The audit's parallel verify-skeptic pass died on a rate-limit, so treat severities as the finder's claim + re-confirm.)

**Tenancy (migration `0029`):**
- `gift_card.code` has a **global** UNIQUE (`schema.ts` ~571) → should be `UNIQUE(store_id, code)`. Same for `license.license_key` (`schema.ts` ~400) → `UNIQUE(store_id, license_key)`. Write `drizzle/0029_per_store_unique.sql` (drop global, add composite), journal it (`meta/_journal.json` — copy the 0028 entry shape; **un-journaled migrations are silently skipped** — that bit us before), update `schema.ts` `unique()` calls, apply to `_test` + `rightapps` + `sellright_dev`, run the gate. No existing cross-store dup codes, so it's safe.

**Security hardening:**
- No rate-limit on `POST /api/licenses/activate` + `/v1/apps/{appKey}/licenses/activate` (license-key brute-force). Add `clientIp()` + `loginRetryAfter()` keyed on ip (pattern: `routes/pay.ts`).
- No rate-limit on staff-invite accept (`admin-settings.ts` ~500, 48-char token brute-force). Same pattern.
- `/releases/latest.json` device-binding is optional (token reuse across devices) — consider requiring `x-viewright-device` when the activation was device-bound.
- SSRF via admin-configured Listmonk URL (`shop-extra.ts` newsletter, `admin-marketing.ts`) — admin-controlled so lower risk; consider an allowlist/scheme+host validation.

**Perf (NOT urgent at low data — do before DD-scale):** ~12 N+1 / correlated-subquery / full-scan spots: admin product/customer/order list + export (`admin.ts`, `admin-orders.ts`), `manifest/generate.ts` (in-memory joins), jobs (`release-stale-allocations.ts`, `auto-deliver.ts`), `webhooks/emit.ts` endpoint scan, `catalog.ts` smart-collection in-memory filter. Convert to single aggregate/JOIN queries; add covering indexes.

**Refuted (no action):** manifest "no store_id filter" (RLS scopes it inside `withStore`); activation `FOR UPDATE` "bypasses RLS" (RLS applies to locking selects).

---

## 5. Quick reference

| Item | Value |
|---|---|
| Box | `ssh dd` (alias) / `vendure@5.78.82.156` |
| rightapps API | PM2 `rightapps-api`, `:3301`, DB `rightapps` |
| rightapps env | `~/.sellright/rightapps.env` (0600) |
| nginx | docker `nginx-brotli`, `~/sites/nginx/` (configs baked → rebuild to change; backends at `172.22.0.1:<port>`) |
| rightapps vhost | `~/sites/nginx/rightapps.conf` (repo copy: `packages/api/scripts-deploy/nginx-rightapps.conf`) |
| rightapps cert | `/etc/letsencrypt/live/rightapps/` (admin+api.spoares.com) |
| Admin URL / login | `https://admin.spoares.com` · `adrdsouza@gmail.com` |
| TLS deploy script | `sudo bash ~/sites/sellright/packages/api/scripts-deploy/deploy-rightapps-tls.sh` (idempotent) |
| Test gate | §2 above — currently 90/90 |
| Latest commit | `08906b5` |
