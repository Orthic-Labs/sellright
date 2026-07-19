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
PGAPPNAME=rightapps-api
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
ALTER ROLE sellright_app IN DATABASE rightapps
  SET statement_timeout = '30s';
ALTER ROLE sellright_app IN DATABASE rightapps
  SET idle_in_transaction_session_timeout = '15s';
ALTER ROLE sellright_app IN DATABASE rightapps
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
