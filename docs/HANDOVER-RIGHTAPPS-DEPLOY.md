# Handover — Right Apps SellRight instance: finish public exposure (+ open tracks)

**Date:** 2026-06-13 · **For:** an agent running **on the box** (`vendure@rottenhand`, 5.78.82.156) with docker-group + sudo access (the off-box agent that did the work below has neither, which is why this is handed over).

**Repo source of truth:** laptop `D:\Claude\sellright` → GitHub `origin/main` → box deploy checkout `/home/vendure/sites/sellright` (clean checkout of origin/main; `git pull` to update, never edit code there). Latest commit at handover: `2649b99`.

---

## 0. The ONE thing blocking you right now

**Symptom:** `https://api.spoares.com/v1/health` and `https://admin.spoares.com` return nothing (curl `HTTP:000`, ~hang). Everything else is healthy.

**Fully characterised (already diagnosed, don't re-derive):**
- rightapps API origin is UP: `curl http://127.0.0.1:3301/v1/health` → **200**. Binds `*:3301` (all interfaces).
- DNS resolves: `admin/api.spoares.com` → `5.78.82.156` (Cloudflare, **DNS-only/grey**).
- TLS is CORRECT: `openssl s_client -connect 127.0.0.1:443 -servername api.spoares.com` presents `CN=admin.spoares.com`, SAN `admin.spoares.com, api.spoares.com`, chain depth 4 (complete). The dedicated LE cert `/etc/letsencrypt/live/rightapps/` was issued and the vhost points at it.
- `:80` works: `http://api.spoares.com/...` → **301** redirect (so the rightapps vhost IS loaded in the running nginx).
- Brand sites are fine: `https://damneddesigns.com/` (SNI→127.0.0.1) → **200** (nginx healthy).
- The hang is at nginx → upstream: TLS handshake completes, the HTTP request is sent, **nginx never responds** (both HTTP/1.1 and HTTP/2). It is NOT TLS, NOT cert, NOT http2.
- From the **host**, `curl http://172.22.0.1:3301/v1/health` → **200** (172.22.0.1 = docker bridge gateway, the IP the nginx vhost proxies to).

**Top hypothesis (verify first):** a **host firewall rule** (ufw / iptables `DOCKER-USER`) lets the docker bridge reach the existing brand backend ports (`:3100`, `:3300`, `:9000`, etc.) but **not the new `:3301`**, so from *inside* the nginx-brotli container `172.22.0.1:3301` is blocked → nginx waits on the upstream → 000. The vhost `proxy_read_timeout` is 30s; curl gave up at 6s.

**Confirm + fix:**
```bash
# 1. Does nginx-in-container reach the upstream? (THE decisive test)
docker compose -f ~/sites/nginx/docker-compose.yml exec nginx-brotli \
  wget -qO- --timeout=5 http://172.22.0.1:3301/v1/health ; echo
#   -> if this hangs/fails but the host curl works, it's the firewall.

# 2. See what the firewall allows for the docker bridge vs the brand ports
sudo ufw status numbered | grep -iE "172\.|3100|3300|3301|docker"
sudo iptables -S DOCKER-USER 2>/dev/null
sudo iptables -L -n | grep -E "3100|3300|3301"

# 3. Fix — mirror whatever rule lets :3100/:3300 through, for :3301. Examples:
#    ufw:
sudo ufw allow from 172.16.0.0/12 to any port 3301 proto tcp
#    (use the SAME source subnet the brand-port rules use — copy their exact form)
#    then re-test:
curl -sk -m 6 --resolve api.spoares.com:443:127.0.0.1 https://api.spoares.com/v1/health
```

**Also check (secondary hypotheses if the firewall is not it):**
- `docker logs --tail=50 nginx-brotli` — look for upstream timeout / connect errors for `172.22.0.1:3301`.
- `/home/vendure/sites/nginx/logs/rightapps-api_error.log` and `rightapps-admin_error.log` (mounted from the container).
- `docker compose exec nginx-brotli nginx -T | grep -A40 "server_name api.spoares.com"` — confirm the live config matches `~/sites/nginx/rightapps.conf`.
- Confirm the deploy actually completed phase 3 (vhost on `/rightapps/`, container rebuilt): `grep ssl_certificate ~/sites/nginx/rightapps.conf` should show `/etc/letsencrypt/live/rightapps/`.

**When fixed, verify the full path:** `curl -sI https://api.spoares.com/v1/health` → 200, then open `https://admin.spoares.com`, log in `adrdsouza@gmail.com` / (password handed over separately — generated, change it). Optionally flip the 2 DNS records to **proxied/orange** afterward (CF in front); they're grey now.

---

## 1. What is already done (do NOT redo)

**Audit remediation (32 findings) — shipped + verified.** Committed; `pnpm verify` gate green on the box: **90/90 tests** against `sellright_test` with the real non-owner app role, `db:assert-rls` (50 FORCE-RLS tables), `assert:shop-isolation` (11 routes). New verify gate: `pnpm --filter @sellright/api assert:shop-isolation`.

**Right Apps instance — its own DB, separate from the DD clone.**
- DB `rightapps` on the **native :5433 cluster** (owner `sellright`, app role `sellright_app`). 28 migrations applied (0000-0027), 52 tables, 50 FORCE-RLS. DD clone `sellright_dev` untouched.
- Admin `adrdsouza@gmail.com` seeded; **5 stores** provisioned (`viewright`, `coderight`, `heardright`, `mailright`, `scraperight`), admin = owner on each.
- **`rightapps-api` runs under PM2** (`pm2 describe rightapps-api`), entrypoint `packages/api/scripts-deploy/start-rightapps.sh`, env `~/.sellright/rightapps.env` (0600), compiled `dist/index.js`, port **3301**, `pm2 save`d (survives reboot).
- Admin SPA built: `packages/admin/dist` (mounted into nginx, see below).
- DNS `admin/api.spoares.com` → box IP (Cloudflare, DNS-only).
- nginx: vhost `~/sites/nginx/rightapps.conf`, Dockerfile `COPY rightapps.conf`, compose mount `packages/admin/dist → /var/www/rightapps-admin:ro`, dedicated cert `rightapps` issued. (This is the layer with the §0 blocker.)

---

## 2. Architecture + gotchas (the non-obvious stuff)

- **Two SellRight API instances, two DBs, both on :5433 native cluster:**
  - dev API `:3300` → `sellright_dev` (DD PII clone, for DD-cutover testing). Runs via nohup/pnpm (pid varies).
  - **rightapps API `:3301` → `rightapps`** (the new proper instance, PM2 `rightapps-api`).
  - **NEVER touch the `:5432` `vendure-postgres` Docker container — that's LIVE production stores.** A `prod-db-guard` hook blocks docker-exec + prod psql; if you hit it you're on the wrong instance.
- **nginx is dockerized** (`nginx-brotli` container, `~/sites/nginx/`, configs **baked via Dockerfile COPY** — so a vhost change needs `docker compose build && up -d`, not just reload). It fronts :80/:443 for ALL sites.
- **Inside the nginx container, host services are at `172.22.0.1:<port>`** (docker bridge gateway), NOT `127.0.0.1` (that's the container). The rightapps vhost correctly uses `172.22.0.1:3301`. (WP6's old `nginx-admin.conf` wrongly used `127.0.0.1` — ignore it; `nginx-rightapps.conf` is the right one.)
- **Cloudflare Access is on the `spoares.com` apex** → its ACME HTTP-01 challenge redirects to a login page. That's why the cert is a **dedicated `rightapps` cert for admin+api only** (apex excluded), not a `--expand` of the `spoares.com` cert. Don't try to expand the apex.
- **pnpm on the box:** not on the non-interactive PATH. Use `COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm ...` from the repo dir (reads `packageManager: pnpm@10.10.0`). `node`/`certbot`/`pm2`/`docker`/`certbot` are at standard paths; `nginx` only exists inside the container.
- **DB creds:** `~/.sellright/env` (0600) has `DATABASE_URL_OWNER` + `DATABASE_URL_APP` (both point at `sellright_dev`); derive other DBs by swapping the trailing db name, e.g. `RIGHTAPPS_OWNER="${DATABASE_URL_OWNER%/*}/rightapps"`. Tests run vs `sellright_test` ONLY (the RLS suite TRUNCATEs).
- **Reusable ops scripts** (committed, `packages/api/scripts-deploy/`): `create-tenant-db.sh`, `grant-app-role.sh` (re-apply `sellright_app` grants to any DB — required for any new DB **and** `sellright_test`, else "permission denied" under the real app role), `start-rightapps.sh`, `deploy-rightapps-tls.sh`.

### Redeploy the rightapps instance after a code change
```bash
cd ~/sites/sellright && git pull && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm -r build
pm2 restart rightapps-api
# admin SPA changed? cd packages/admin && corepack pnpm install && corepack pnpm build  (it's a separate, non-workspace toolchain)
# nginx vhost changed? cd ~/sites/nginx && sudo docker compose build && sudo docker compose up -d
```

---

## 3. Other open tracks (the off-box agent is handling these; coordinate)

1. **Stripe** — pending the **test secret key** (`sk_test_...`) from Adrian. When available: add `STRIPE_SECRET_KEY` (and later `STRIPE_WEBHOOK_SECRET`) to `~/.sellright/rightapps.env`, `pm2 restart rightapps-api`. Then validate: create a ViewRight `license`-type product variant (`fulfillmentType=license`, `appKey=viewright`, a price), run order → `POST /v1/shop/orders/{code}/payment-intent` → confirm with `pm_card_visa` (server-side, test mode) → `POST /v1/shop/orders/{code}/pay` → assert a `license` row is issued. Webhook endpoint once public: `https://api.spoares.com/v1/webhooks/stripe` (register in Stripe dashboard → get `whsec_`).
2. **Deep security/logic/perf audit** — a 6-agent audit was run; confirmed findings get fixed off-box with the 90-test gate. Notable licensing findings to be aware of (may already be fixed by the time you read this — check git log): qty>1 license idempotency (no `unique(order_line_id)`, can under/double-issue), `canReceiveUpdate` returns false for perpetual (`updatesUntil=null`) licenses, `GET /releases/latest.json` falls back to `DEV_DEFAULT_STORE` when the app header is absent. **Do not independently fix these** unless coordinating — they touch the money/licensing path and need the test gate.

---

## 4. Quick reference

| Item | Value |
|---|---|
| Box | `ssh vendure@5.78.82.156` (host alias `dd`) |
| rightapps API | PM2 `rightapps-api`, `:3301`, DB `rightapps` |
| rightapps env | `~/.sellright/rightapps.env` (0600) |
| nginx | docker `nginx-brotli`, `~/sites/nginx/` (configs baked; rebuild to change) |
| rightapps vhost | `~/sites/nginx/rightapps.conf` (repo: `packages/api/scripts-deploy/nginx-rightapps.conf`) |
| rightapps cert | `/etc/letsencrypt/live/rightapps/` (admin+api.spoares.com) |
| Admin URL / login | `https://admin.spoares.com` · `adrdsouza@gmail.com` |
| Verify gate | `cd packages/api && DATABASE_URL=…5433/sellright_test DATABASE_URL_NONOWNER=…app…/sellright_test corepack pnpm test` |
| TLS deploy script | `sudo bash packages/api/scripts-deploy/deploy-rightapps-tls.sh` (idempotent) |
