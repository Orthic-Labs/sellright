-- HAND-WRITTEN: see docs/runbooks/migrations.md — do NOT regenerate via drizzle-kit.
-- SELLRIGHT-ISSUES P1: shared rate-limit backend (src/auth/rate-limit-backend.ts).
-- Global infra table, NOT store-scoped — a rate-limit bucket keys on
-- ip+identifier, not a tenant, so it carries no store_id and no RLS policy,
-- same posture as `session`/`processed_event` (see src/db/rls-tables.test.ts's
-- EXEMPT set and assert-force-rls.ts's discovery). Queried via the unscoped
-- owner pool, matching jobs/leader-lock.ts's advisory-lock precedent for
-- cross-cutting infra state that isn't tenant data.
CREATE TABLE rate_limit_attempt (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bucket text NOT NULL,
  key text NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT now()
);
-- Every backend operation filters on (bucket, key) then either counts or
-- prunes by attempted_at — one composite index covers both.
CREATE INDEX rate_limit_attempt_lookup_idx ON rate_limit_attempt (bucket, key, attempted_at);
