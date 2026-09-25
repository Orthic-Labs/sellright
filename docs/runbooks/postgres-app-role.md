# Postgres application-role hardening

Apply these settings as a Postgres operator. They are deliberately not a
migration: the database owner used by migrations may not own the runtime role,
and role policy belongs to deployment operations.

## Runtime identities

Set a distinct application name in each deployment:

```dotenv
# SellRight
PGAPPNAME=sellright-api

# RightSites production API
PGAPPNAME=rightsites-api
```

The API passes this value to Postgres as `application_name`, so activity and
slow-query views identify the correct service.

## Query observability

Run this once per Postgres cluster as an administrator, before making further
query or memory tuning decisions:

```sql
SHOW shared_preload_libraries;
ALTER SYSTEM SET shared_preload_libraries = 'pg_stat_statements';
ALTER SYSTEM SET log_min_duration_statement = '1000ms';
```

`ALTER SYSTEM SET shared_preload_libraries` replaces the whole list. If `SHOW`
returns other modules, preserve them in the comma-separated value alongside
`pg_stat_statements`. Restart Postgres after changing
`shared_preload_libraries`, then enable the extension in each application
database:

```sql
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
```

Verify after the restart, once per database:

```sql
SHOW log_min_duration_statement;
SELECT count(*) FROM pg_stat_statements;

SELECT query, calls, total_exec_time, mean_exec_time, rows
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 20;
```

The first result must be `1s`; the count and top-query query must execute
without an extension/preload error. The cluster on port 5433 is shared, so do
not change `shared_buffers`, `work_mem`, or `effective_cache_size` without
measuring this data first.

## Role settings

Run as a Postgres administrator for each database used by the application. The
15-second idle-in-transaction timeout is safe only after the external-I/O
transaction-boundary regression test is present and green.

```sql
ALTER ROLE sellright_app IN DATABASE rightsites
  SET statement_timeout = '30s';
ALTER ROLE sellright_app IN DATABASE rightsites
  SET idle_in_transaction_session_timeout = '15s';
ALTER ROLE sellright_app IN DATABASE rightsites
  SET lock_timeout = '5s';

ALTER ROLE sellright_app IN DATABASE sellright_dev
  SET statement_timeout = '30s';
ALTER ROLE sellright_app IN DATABASE sellright_dev
  SET idle_in_transaction_session_timeout = '15s';
ALTER ROLE sellright_app IN DATABASE sellright_dev
  SET lock_timeout = '5s';
```

If a separate test database is provisioned, repeat the same `IN DATABASE`
statements for it. New sessions are required before the settings take effect.

## Resolver role bootstrap (SR-01/SR-02 follow-up)

`resolve_store_for_gateway_event` (0053/0060) and `resolve_store_for_storekit_bundle`
(0066) are SECURITY DEFINER functions that MUST see across every tenant's rows
regardless of FORCE ROW LEVEL SECURITY — that's their entire purpose: a
webhook arrives before any `app.current_store` exists. They have always been
owned by the migration role (`sellright`), whose header comments say
"requires the migration role to be superuser/BYPASSRLS" — but `sellright` is
deliberately NOSUPERUSER/NOBYPASSRLS (same SR-01 reasoning as the runtime
role), so as owner these functions have been silently returning NULL for
every cross-tenant lookup. Do NOT fix this by granting BYPASSRLS to
`sellright` or to `sellright_app` — that would let ordinary migration or
runtime queries bypass FORCE RLS everywhere, not just inside these two
functions.

Run this once per Postgres cluster/database as a superuser. It is idempotent
— safe to re-run on every deploy alongside the `sellright_app` block above.

```sql
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'sellright_resolver') THEN
    CREATE ROLE sellright_resolver
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT BYPASSRLS;
  END IF;
END
$$;

-- Lets `sellright` (the migration role) both ALTER FUNCTION ... OWNER TO
-- sellright_resolver once, and CREATE OR REPLACE these two functions in every
-- future migration afterward, without ever being superuser or BYPASSRLS
-- itself — has_privs_of_role() treats a role as "owning" what a role it has
-- the privileges of owns. Requires Postgres 16+ for the WITH INHERIT clause;
-- on 15 and earlier use plain `GRANT sellright_resolver TO sellright;` (the
-- default is equivalent to INHERIT TRUE there).
GRANT sellright_resolver TO sellright WITH INHERIT TRUE;
```

Then apply `packages/api/drizzle/0069_resolver_role_ownership.sql` to move
ownership and grant the narrow SELECT privileges the two function bodies
need, run as `sellright`:

```bash
psql "$DATABASE_URL_MIGRATE" -v ON_ERROR_STOP=1 \
  -f packages/api/drizzle/0069_resolver_role_ownership.sql
```

On a **fresh** deployment (compose `up` from empty), `deploy/compose.yaml`'s
`db-init` already runs this bootstrap before the API's migrate step, so
0069 takes effect the first time it's ever applied — no extra step needed.

On an **already-migrated** deployment, 0069 has already run as its no-op
branch and Drizzle's migration ledger records it as applied — restarting the
API or re-running `db:migrate` will NOT re-execute it (Drizzle skips
already-applied migrations by hash, regardless of what the file's own logic
would now do differently). Run the `psql -f` command above by hand, once,
immediately after creating `sellright_resolver` and granting membership. This
is the only migration in this repo that requires a manual replay after an
environment-level bootstrap; note it in the deploy log for that environment.

Verify ownership and grants landed:

```sql
SELECT p.proname, r.rolname AS owner
FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
WHERE p.proname IN ('resolve_store_for_gateway_event', 'resolve_store_for_storekit_bundle');
-- both rows must show owner = sellright_resolver

SELECT table_name, privilege_type
FROM information_schema.role_table_grants
WHERE grantee = 'sellright_resolver'
ORDER BY table_name;
-- exactly: gateway_event, payment, payment_attempt, storekit_app, subscription — all SELECT only
```

Then re-run the `tenant resolution seam (SR-01)` and `storekit-webhooks`
DB test suites (`payments/tenant-resolution.db.test.ts`,
`routes/storekit-webhooks.db.test.ts`, `routes/payment-webhooks.route.test.ts`,
`routes/gateway-payments.webhook.test.ts`) — they self-skip against a
non-`_test` database but exercise this exact seam under the nonowner role.

## Verify

Connect to each database as `sellright_app` in a fresh session:

```sql
SHOW statement_timeout;
SHOW idle_in_transaction_session_timeout;
SHOW lock_timeout;
SHOW application_name;
```

Expected timeout values are `30s`, `15s`, and `5s`. `application_name` must
match the deployment identity above.

After migration `0040_outbox_autovacuum`, verify the queue-table settings:

```sql
SELECT relname, reloptions
FROM pg_class
WHERE relname IN ('email_outbox', 'push_outbox')
ORDER BY relname;
```

Both rows must include `autovacuum_vacuum_scale_factor=0.02` and
`autovacuum_vacuum_threshold=50`.
