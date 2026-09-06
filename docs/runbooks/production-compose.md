# Production Compose operations

SellRight's supported single-instance production path is `deploy/compose.yaml`. The database, uploaded assets, downloads, and Caddy state live in named Docker volumes.

## Start or upgrade

```bash
cp deploy/.env.example deploy/.env
# Fill every required value in deploy/.env, then:
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d --build
```

The API image runs schema migrations and create-only bootstrap before starting the server. Re-running with the same `BOOTSTRAP_STORE_SLUG` does not recreate the store or reset an existing admin password.

Check health through the admin proxy:

```bash
docker compose --env-file deploy/.env -f deploy/compose.yaml exec -T admin \
  wget -qO- http://127.0.0.1:8080/v1/readyz
```

## Backup

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
