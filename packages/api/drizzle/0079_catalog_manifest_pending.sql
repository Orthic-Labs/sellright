-- HAND-WRITTEN: see docs/runbooks/migrations.md — do NOT regenerate via drizzle-kit.
-- SELLRIGHT-ISSUES P1: durable retry for cross-process catalog manifest
-- regeneration triggers. manifest/stock-hook.ts's in-memory trailing-rerun
-- state (RegenState) only survives within ONE process's lifetime — a crash
-- (or `withLeaderLock` losing the advisory lock to a DIFFERENT instance
-- mid-run) between "stock changed" and "manifest republished" silently
-- drops the regeneration with no in-memory trace of it ever having been
-- owed. This table is that trace: one row per store with a regeneration
-- outstanding, upserted BEFORE the in-process attempt and deleted only
-- after that attempt actually succeeds. jobs/scheduler.ts's
-- catalog-manifest-drain pass periodically republishes (full regen, always
-- safe/correct) any row stale enough that the in-process attempt behind it
-- must have failed, then clears it — "no lost regenerations", independent
-- of whether the ORIGINAL trigger's process is even still alive.
--
-- Global-ish infra table (one row per store, not per-tenant DATA), same
-- posture as rate_limit_attempt (migration 0078): no RLS, queried via the
-- unscoped owner pool.
CREATE TABLE catalog_manifest_pending (
  store_id uuid PRIMARY KEY,
  store_slug text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now()
);
