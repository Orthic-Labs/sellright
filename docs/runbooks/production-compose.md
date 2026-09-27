# Production Compose operations

SellRight's supported single-instance production path is `deploy/compose.yaml` plus `deploy/install.sh` (see the [one-click install plan](../plans/2026-09-27-one-click-install.md), Workstream D). `deploy/compose.yaml` pulls **pinned, cosign-signed images from GHCR** (`ghcr.io/orthic-labs/sellright-{api,admin,storefront}`); it has no `build:` sections. The database, uploaded assets, downloads, and Caddy state live in named Docker volumes.

## Install (new server)

```bash
curl -fsSL https://raw.githubusercontent.com/Orthic-Labs/sellright/main/deploy/install.sh | sudo sh
```

This checks the OS/RAM/disk/ports, installs Docker + cosign if missing, generates every machine secret (database passwords, `SELLRIGHT_MASTER_KEY`, cookie/download/licensing/contact/cache secrets) with `openssl rand`/`/dev/urandom`, verifies each image's signature (`cosign verify`, keyless — see `.github/workflows/ci.yml`'s `release` job) before pulling, starts the stack, and writes a recovery kit (see `docs/runbooks/recovery.md`). It never displays or logs a secret. Re-running is idempotent — it leaves an existing `/opt/sellright/.env` and recovery kit untouched.

Manage the running install with the `sellright` CLI it installs to `/usr/local/bin/sellright`: `status`, `logs`, `backup [--offsite]`, `recovery-kit`, `restore --kit … --set …`, `setup-link`, `reset-admin <email>`. `update` is a stub pending WS-E.

## Building from source (development)

```bash
cp deploy/.env.example deploy/.env   # fill every required value
docker compose --env-file deploy/.env -f deploy/compose.yaml -f deploy/compose.build.yaml up -d --build
```

`compose.build.yaml` adds back the `build:` contexts (`packages/{api,admin,storefront}/Dockerfile`) for developers who don't want to pull from GHCR. Never combine it with a production `.env` that expects pinned digests.

The API image runs schema migrations and create-only bootstrap before starting the server. Re-running with the same `BOOTSTRAP_STORE_SLUG` does not recreate the store or reset an existing admin password.

Check health through the admin proxy:

```bash
docker compose --env-file deploy/.env -f deploy/compose.yaml exec -T admin \
  wget -qO- http://127.0.0.1:8080/v1/readyz
```

## Storefront

The `storefront` service (Qwik SSR, `packages/storefront/Dockerfile`) is included in Compose behind Caddy. Since WS-C, it's a **generic image**: no store identity/theme is baked in at build time — it resolves the store per incoming request `Host` at runtime (`GET /v1/shop/identity` against `SELLRIGHT_API_URL`), so one image serves every store an operator points it at. It's not exposed publicly unless `SELLRIGHT_STOREFRONT_DOMAIN` is set in `deploy/.env`; unset, Caddy binds it to the internal-only `:8090` and only the `admin` domain is public, matching pre-storefront behavior exactly. Multi-store per-Host routing in Caddy itself (so one Caddy instance fronts several storefront hosts) remains a follow-up.

## HTTPS / Caddy IP certificate (spike result)

The plan calls for a Let's Encrypt **IP-address certificate** so HTTPS works before a domain is configured. **This has not been verified against a real public IP** — CI and this workspace have no publicly-routable address to request one against, and claiming success without that evidence would be worse than not claiming it. `deploy/Caddyfile`'s `SELLRIGHT_DOMAIN`/`SELLRIGHT_STOREFRONT_DOMAIN` values accept either a domain or a bare IP unchanged; Caddy 2.10 (pinned in `compose.yaml`) supports ACME IP certificates per its release notes, but that support has only been checked by reading Caddy's own documentation, not by issuing one here.

**Manual test** (run on the actual target VPS, which has a public IP and ports 80/443 reachable from the internet):

```bash
# deploy/.env: SELLRIGHT_DOMAIN=<the server's public IP>
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d caddy
docker compose --env-file deploy/.env -f deploy/compose.yaml logs caddy | grep -i certificate
curl -v https://<public-ip>/  # expect a valid, non-self-signed cert
```

**Fallback**: if that fails (rate limits, ACME account restrictions, or Caddy version behavior differing from docs), `install.sh` requires a real domain up front instead — this is the safe default until the IP-certificate path is confirmed working in production.

## Backup and restore (canonical: `sellright` CLI)

For an install done via `install.sh`, use `sellright backup [--offsite]` and `sellright restore --kit … --set …` — see `docs/runbooks/recovery.md` for the backup set format, the recovery kit, restoring to a new server, and the automated CI drill. The manual `docker compose exec pg_dump/pg_restore` steps below remain for a from-source install (no `sellright` CLI installed) or manual inspection.

Create a PostgreSQL custom-format dump outside the containers so it survives container or volume loss:

```bash
mkdir -p backups
stamp=$(date -u +%Y%m%dT%H%M%SZ)
docker compose --env-file deploy/.env -f deploy/compose.yaml exec -T postgres \
  pg_dump -U sellright -d sellright -Fc > "backups/sellright-$stamp.dump"
test -s "backups/sellright-$stamp.dump"
```

Back up the `assets` and `downloads` named volumes using the host's normal volume or snapshot tooling as well; database dumps do not contain file payloads. Store backups off-host according to your retention policy.

## Restore drill

Test each backup against a disposable database before relying on it:

```bash
dump=backups/sellright-YYYYMMDDTHHMMSSZ.dump
docker compose --env-file deploy/.env -f deploy/compose.yaml exec -T postgres \
  dropdb --if-exists -U sellright sellright_restore
docker compose --env-file deploy/.env -f deploy/compose.yaml exec -T postgres \
  createdb -U sellright sellright_restore
cat "$dump" | docker compose --env-file deploy/.env -f deploy/compose.yaml exec -T postgres \
  pg_restore -U sellright -d sellright_restore --no-owner --no-privileges
```

Then run the image's migration runtime against the restored database and make a basic read:

```bash
docker compose --env-file deploy/.env -f deploy/compose.yaml exec -T \
  -e DATABASE_URL="postgresql://sellright:${POSTGRES_PASSWORD}@postgres:5432/sellright_restore" \
  api node dist/scripts/migrate.js
docker compose --env-file deploy/.env -f deploy/compose.yaml exec -T postgres \
  psql -U sellright -d sellright_restore -c 'SELECT id, slug, name FROM store ORDER BY created_at LIMIT 5;'
```

Delete the disposable restore database after the drill. A real disaster restore should stop API writes first, preserve the failed database for forensics, restore the chosen dump into a fresh database or volume, run migrations with the exact intended SellRight image, restore file volumes, and only then return traffic.

## Reboot and persistence check

A normal container restart must keep named volumes:

```bash
docker compose --env-file deploy/.env -f deploy/compose.yaml down
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d
```

Do **not** add `-v` to `down` during normal operations; `down -v` deletes named volumes. CI exercises a full down/up cycle and verifies that the bootstrap store identity plus asset and download sentinels survive.
