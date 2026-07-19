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
