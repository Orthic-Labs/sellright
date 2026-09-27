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

`sellright backup --offsite` additionally encrypts each part with
**encrypt-then-MAC** authenticated encryption and copies the results to
`SELLRIGHT_OFFSITE_REMOTE` (any `rclone`-configured remote, e.g. an
S3-compatible bucket, or a plain local path for testing) set in
`$SELLRIGHT_HOME/.env`. Nothing is pushed off-site unless that variable is
set. For each part:

- Two keys are derived from the recovery kit's `masterKey` + `kitId` via
  HMAC-SHA256 with distinct labels (`sellright-backup-enc:<kitId>` and
  `sellright-backup-mac:<kitId>`) — encryption and authentication never share
  a key.
- `<part>.enc` — `openssl enc -aes-256-cbc -pbkdf2 -iter 200000` under the
  derived encryption key.
- `<part>.enc.hmac` — HMAC-SHA256 of the *ciphertext* under the derived MAC
  key.

This is plain `openssl enc` + `openssl dgst -hmac`, not `enc`'s newer
(version-dependent) AEAD tag support, so it works identically across
OpenSSL 1.1+. `sellright restore` recomputes the HMAC over the ciphertext
before decrypting anything and refuses (`integrity check failed for …`) on
any mismatch — a tampered or corrupted `.enc` file, or a missing/altered
`.hmac`, is rejected before it can touch any data.

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

`sellright restore --kit <recovery-kit.json> --set <backup-dir> [--yes]`
restores **and promotes** the database, assets, and downloads in one
destructive operation:

1. Provision a new server and run `install.sh` there (creates its own fresh
   `$SELLRIGHT_HOME/.env` and recovery kit — the new kit is irrelevant to this
   restore; you're restoring data, not the kit).
2. Copy the backup set locally (from off-site: download the `.enc`/`.enc.hmac`
   files for one timestamp into a directory) and copy the **old** recovery kit
   (`recovery-kit.json`) — you need the OLD kit's `masterKey`/`kitId` to
   decrypt and authenticate an OLD off-site backup.
3. Run the restore:
   ```
   sellright restore --kit <old-recovery-kit.json> --set <backup-dir>
   ```
   - If the set is encrypted (`*.enc` present), each file's HMAC is verified
     against its derived MAC key **before anything is decrypted**. A mismatch
     aborts immediately — nothing about the live stack is touched.
   - **Confirmation:** in a real terminal, it prints what it's about to
     replace and requires typing `yes`. In a non-interactive session (scripts,
     CI) it refuses unless `--yes` is passed — it never assumes consent.
   - **Pre-restore safety backup:** before touching anything live, it runs
     `sellright backup` on the *current* stack, so a bad restore can itself be
     recovered from.
   - **Database promotion:** restores `database.dump` into a disposable
     `sellright_restore` database, stops `api`, terminates other connections,
     then `ALTER DATABASE sellright RENAME TO sellright_prev_<timestamp>`
     followed by `ALTER DATABASE sellright_restore RENAME TO sellright`. The
     previous database is kept (not dropped) for forensics — drop it manually
     once you've verified the restore.
   - **Assets/downloads promotion:** extracts `assets.tar.gz`/
     `downloads.tar.gz` directly into the live `assets`/`downloads` named
     volumes (replacing their current contents), then starts `api` back up.
4. Verify: `sellright status`, then spot-check the storefront/admin.

This is a live cutover, not a side-database drill — run it only when you mean
to replace the current data. The pre-restore backup and the kept
`sellright_prev_*` database are the safety net if something's wrong with the
set you restored.

## Restore drill (automated, CI)

`.github/workflows/ci.yml`'s `verify-appliance` job runs on every push to
`main` after the `release` job (build/push/sign) succeeds:

1. Builds the appliance from this commit's own images in an isolated Compose
   project (`-p sellright-drill`), with `SMTP_ENABLED=false` and
   `JOBS_ENABLED=0` — no outbound email, no background jobs, no payment
   provider calls. `SELLRIGHT_OFFSITE_REMOTE` points at a plain local
   directory (`rclone` treats a path with no `remote:` prefix as local
   filesystem — no cloud account needed to exercise the real off-site code
   path) and `rclone` is installed on the runner for this job.
2. Boots it, seeds an asset **and** a download sentinel file, runs
   `sellright backup --offsite`, and asserts: the local backup set's shape
   (all four files, manifest checksums, both sentinels round-trip out of
   their tarballs) and the off-site set's shape (`.enc` + `.enc.hmac` for all
   four parts).
3. **Tamper test:** copies the off-site set, flips one byte inside
   `database.dump.enc`, and asserts `sellright restore --yes` against it
   fails with an integrity-check error — and that the live store is
   unaffected (still exactly one `slug = 'drill'` row).
4. `docker compose down -v` — destroys every volume, simulating total loss.
5. Brings up a bare Postgres, runs `sellright restore --kit … --set
   <off-site dir> --yes` against the untampered off-site set, and asserts:
   `store.slug = 'drill'` is present in the **promoted, live** `sellright`
   database (not a side database), both sentinels are present in the live
   `assets`/`downloads` volumes, and `api` comes back up `healthy`.
6. Tears the isolated project down.

This never touches a real deployment: it's a project-scoped, from-scratch
Compose stack on the CI runner with synthetic credentials, destroyed at the
end of the job regardless of outcome (`if: always()`).

## What's still manual / follow-up

- `sellright update` is a stub (WS-E ships maintenance-mode + functional-check
  updates with automatic pre-reopen rollback).
- Off-site backup needs `rclone` installed on the host and
  `SELLRIGHT_OFFSITE_REMOTE` configured; `install.sh` does not install or
  configure `rclone` today.
- The kept `sellright_prev_*` database from a promoted restore is never
  auto-pruned — old ones accumulate until dropped manually.
