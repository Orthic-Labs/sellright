# Recovery runbook (WS-D)

Covers total server loss for the single-VPS Compose appliance: what a backup
set contains, the recovery kit, restoring to a new server, and the automated
drill CI runs on every push to `main`.

## Backup sets

`sellright backup` (installed by `install.sh` to `/usr/local/bin/sellright`)
writes a timestamped directory under `$SELLRIGHT_HOME/backups/<UTC timestamp>/`
containing:

- `database.dump` — `pg_dump -Fc` of the `sellright` database
- `assets.tar.gz` — the `assets` named volume
- `downloads.tar.gz` — the `downloads` named volume
- `manifest.json` — application version (`SELLRIGHT_IMAGE_TAG`), the running
  API image id, and a `sha256:` digest of each of the three files above

`sellright backup --offsite` additionally encrypts each part with a key
derived from the recovery kit's master key + kit id (`openssl enc -aes-256-cbc
-pbkdf2`) and copies the `.enc` files to `SELLRIGHT_OFFSITE_REMOTE` (any
`rclone`-configured remote, e.g. an S3-compatible bucket) set in
`$SELLRIGHT_HOME/.env`. Nothing is pushed off-site unless that variable is set.

## The recovery kit

`install.sh` generates `$SELLRIGHT_HOME/recovery-kit.json` once, at install
time (root-owned, `chmod 600`):

```json
{
  "kitId": "…",
  "generatedAt": "…",
  "masterKey": "…",
  "backupLocation": "/opt/sellright/backups",
  "offsite": { "configured": false, "note": "…" }
}
```

Download it (`sellright recovery-kit` prints it) and store it somewhere other
than this server — it is the only thing that can decrypt an off-site backup,
it is never re-derivable, and losing both it and the server is unrecoverable.
It is not re-generated on re-install if one already exists.

## Restore to a new server

1. Provision a new server and run `install.sh` there (creates its own fresh
   `$SELLRIGHT_HOME/.env` and recovery kit — the new kit is irrelevant to this
   restore; you're restoring data, not the kit).
2. Copy the backup set locally (from off-site: download the `.enc` files for
   one timestamp into a directory) and copy the **old** recovery kit
   (`recovery-kit.json`) alongside `install.sh`'s output — you need the OLD
   kit's `masterKey`/`kitId` to decrypt an OLD off-site backup.
3. `sellright restore --kit <old-recovery-kit.json> --set <backup-dir>`
   - Detects `*.enc` files automatically and decrypts them first.
   - Restores `database.dump` into a **disposable** `sellright_restore`
     database — it never touches the live `sellright` database.
4. Verify the restored data (`docker compose exec postgres psql -d
   sellright_restore -c 'select slug from store;'`, etc).
5. Manually restore `assets.tar.gz`/`downloads.tar.gz` into the new server's
   `assets`/`downloads` volumes (`docker run --rm -v sellright_assets:/dst -v
   $PWD:/src alpine tar xzf /src/assets.tar.gz -C /dst`), then promote
   `sellright_restore` to `sellright` (rename or `pg_dump`/`pg_restore`
   between them) and restart the `api` service.

Volume restore and the final promotion are manual today — the CLI restores
the database into an isolated database as the safety-critical, most
error-prone step; the recovery kit + backup manifest give you everything
needed for the rest.

## Restore drill (automated, CI)

`.github/workflows/ci.yml`'s `verify-appliance` job runs on every push to
`main` after the `release` job (build/push/sign) succeeds:

1. Builds the appliance from this commit's own images in an isolated Compose
   project (`-p sellright-drill`), with `SMTP_ENABLED=false` and
   `JOBS_ENABLED=0` — no outbound email, no background jobs, no payment
   provider calls.
2. Boots it, seeds a sentinel file, runs `sellright backup`, and asserts the
   backup set's shape (all four files present, manifest has checksums, the
   sentinel round-trips out of `assets.tar.gz`).
3. `docker compose down -v` — destroys every volume, simulating total loss.
4. Brings up a bare Postgres, runs `sellright restore --kit … --set …`, and
   asserts `store.slug = 'drill'` is present in `sellright_restore`.
5. Tears the isolated project down.

This never touches a real deployment: it's a project-scoped, from-scratch
Compose stack on the CI runner with synthetic credentials, destroyed at the
end of the job regardless of outcome (`if: always()`).

## What's still manual / follow-up

- Volume restore (assets/downloads) and promoting `sellright_restore` to
  `sellright` are host commands today, not `sellright restore` itself — see
  step 5 above. A future release can fold both into the CLI.
- `sellright update` is a stub (WS-E ships maintenance-mode + functional-check
  updates with automatic pre-reopen rollback).
- Off-site backup needs `rclone` installed on the host and
  `SELLRIGHT_OFFSITE_REMOTE` configured; `install.sh` does not install or
  configure `rclone` today.
