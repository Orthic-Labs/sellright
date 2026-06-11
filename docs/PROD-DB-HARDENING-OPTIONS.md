# Prod-DB Hardening — Options, Exact Steps, Rollback

> Status: **PLAN ONLY.** Nothing here has been run. Every prod-touching command is
> marked **[ADRIAN-SUDO]** — it needs the sudo password Claude does not have, so
> Adrian runs it. Born from the 2026-06-06 incident + the follow-up question:
> "how do I make the prod DB un-destroyable by any agent (Claude or Codex)?"

## Where we are now

| Door | Vector | Status |
|---|---|---|
| 1. Docker | `docker exec` into `vendure-postgres` (was root-equiv via docker group) | ✅ **CLOSED** — `vendure` removed from docker group; docker now needs `sudo` password |
| 2. DB over TCP | `psql -h 127.0.0.1 -p 5432` using `vendureuser` creds read from `~/sites/<brand>/admin/.env` | ⚠️ **OPEN** — this doc addresses it |

**Why Door 2 isn't a sudo/docker problem:** the container *publishes* `127.0.0.1:5432`, so `psql` is a plain TCP client — no docker, no root, no sudo. It needs only the port (must stay open for the app) + the password (readable by `vendure`). The only way to close it is to make the password unreachable by the agent → the agent and the password-owner must be different identities, OR the readable password must be made far less powerful.

Prod DBs (all in the `vendure-postgres` container, owner = `vendureuser`): `vendure_db` (DD), `rotten_db` (RH), `stunning_db` (SS), `toxic_db` (TS).
App processes: systemd `dd-worker@{1,2}`, `rh-worker@{1,2}`, `ss-worker@{1,2}`, `pm2-vendure`.

---

## Option B — Postgres privilege split (keeps agent deploys; closes catastrophic wipe only)

**Idea:** split the one all-powerful DB key into two. A **data key** (DML-only) goes in `.env` (agents can read it but it can't `DROP`/`TRUNCATE`/`ALTER`). A **structure key** (the owner) is held by Adrian and used only for migrations.

### What it stops / doesn't
- ✅ Stops: `DROP DATABASE`, `DROP TABLE`, `TRUNCATE`, `ALTER` — the catastrophic wipes.
- ❌ Doesn't stop: row-level `DELETE`/`UPDATE` (the app needs these, so the data key has them).
- ⚠️ Friction: Vendure migrations at deploy now need the structure key, not the data key.

### Steps (per database; example shows `vendure_db` / DD)

**B0. [ADRIAN-SUDO] Snapshot first (rollback safety):**
```bash
sudo docker exec -t vendure-postgres pg_dump -U postgres -Fc vendure_db > ~/backups/vendure_db.$(date +%F).dump
```

**B1. [ADRIAN-SUDO] Create the DML-only data role + grant only DML:**
```bash
sudo docker exec -i vendure-postgres psql -U postgres -d vendure_db <<'SQL'
-- data key (no DDL, no TRUNCATE, no ownership)
CREATE ROLE vendure_app LOGIN PASSWORD '<NEW-DATA-PW>';
GRANT CONNECT ON DATABASE vendure_db TO vendure_app;
GRANT USAGE ON SCHEMA public TO vendure_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO vendure_app;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO vendure_app;
-- future tables created by the owner are auto-granted to the app
ALTER DEFAULT PRIVILEGES FOR ROLE vendureuser IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO vendure_app;
ALTER DEFAULT PRIVILEGES FOR ROLE vendureuser IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO vendure_app;
-- explicitly deny the dangerous ones (defense in depth; non-owner can't anyway)
REVOKE TRUNCATE ON ALL TABLES IN SCHEMA public FROM vendure_app;
SQL
```

**B2. Rotate the owner (structure key) so the old `vendureuser` password — which agents may have seen — is dead:**
```bash
# [ADRIAN-SUDO] pick a new owner password, store it ONLY where Adrian controls it
sudo docker exec -i vendure-postgres psql -U postgres -c "ALTER ROLE vendureuser PASSWORD '<NEW-OWNER-PW>';"
```

**B3. Point the app at the data key:** edit `~/sites/damned/admin/.env` so `DATABASE_URL`/DB user = `vendure_app` + `<NEW-DATA-PW>` (NOT `vendureuser`). Keep the owner creds out of every `.env`.

**B4. Restart + verify the store still works:**
```bash
sudo systemctl restart dd-worker@1 dd-worker@2     # [ADRIAN-SUDO]
# smoke: load the storefront, place a test order, confirm reads+writes work
```

**B5. Repeat B1–B4 for `rotten_db`/RH, `stunning_db`/SS, `toxic_db`/TS.**

### Migrations under B (the new normal)
When a deploy changes schema, run the migration with the **owner** creds, e.g.:
```bash
DATABASE_URL=postgres://vendureuser:<NEW-OWNER-PW>@127.0.0.1:5432/vendure_db <vendure migrate cmd>
```
Adrian supplies the owner password at that moment; it never lives in `.env`.

### Rollback
```bash
# revert .env to vendureuser, restart; or full restore:
sudo docker exec -i vendure-postgres pg_restore -U postgres -d vendure_db --clean ~/backups/vendure_db.<date>.dump
```

---

## Option A — Identity separation (fully closes Door 2; agents lose prod deploy)

**Idea:** agents stop logging in as `vendure`. A new restricted user can't read `vendure`'s `750` home, so it never gets any prod password.

**Steps [ADRIAN-SUDO]:**
```bash
sudo adduser --disabled-password a5agent
sudo -u a5agent mkdir -p /home/a5agent/.ssh
# add Claude/Codex public key to /home/a5agent/.ssh/authorized_keys
# do NOT add a5agent to: vendure group, docker group
```
- SellRight dev moves to `/home/a5agent/sellright` (own clone; connects to the host-wide 5433 cluster fine).
- Optional read-only prod for the agent: grant it a `*_ro` Postgres role / the existing `mcp_readonly` over TCP.
- Update the laptop SSH config (`~/.ssh/config.dd`) to `User a5agent`.

**Cost:** `a5agent` can't touch `~vendure/sites/*` → no storefront SEO fixes, blog deploys, robots edits, store builds, or pm2 restarts. Those become a deliberate `vendure`-key or human action.

**Rollback:** point SSH config back at `User vendure`; `sudo deluser a5agent`.

---

## Option C — Service-user separation (best long-term; biggest live-store surgery)

**Idea:** the *app* stops being `vendure`. Store processes run as a new `vendureapp` service user; `.env` becomes `600` owned by `vendureapp`; the `vendure` login (agents) keeps editing/deploying code but can't read another user's `600` file or its `/proc/<pid>/environ`.

**Why it's messy here:** everything lives under `/home/vendure` (`750`), and `pm2-vendure` runs pm2 as `vendure`. Running the app as `vendureapp` means relocating the app out of `vendure`'s home (or re-grouping), changing every systemd `User=`, and migrating off pm2-as-vendure. Real downtime risk. Document fully and stage carefully before attempting; not a same-session change.

---

## Recommendation

- Want **catastrophic-wipe gone with least disruption**, agents keep deploy → **B**.
- Want it **fully, non-bypassably closed** and accept agents stop managing prod → **A**.
- Want it **done right** long-term and will schedule a careful live migration → **C**.

All three are Adrian-run (sudo). Claude produced the plan; Claude cannot execute the sudo steps.
