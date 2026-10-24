-- HAND-WRITTEN: see docs/runbooks/migrations.md — do NOT regenerate via drizzle-kit.
-- Scheduler leadership as a lease row (#358 / #360). Each scheduled job (and each per-store catalog publisher) used to
-- hold a session advisory lock for its whole pass, which pinned one pooled connection idle while the job worked:
-- hourly, every job's lock plus its work asked for two connections from the request pool at once. A pass now claims
-- the row for its name with one short statement, renews it while running and deletes it when done, so it holds no
-- connection between its own transactions, and a crashed leader is released by expires_at instead of a TCP timeout.
-- Global like processed_event (no store_id, so no RLS); runtime grants follow schema-owner default privileges.
-- Additive: the previous image never reads the table. Rolling back to it restores advisory-lock leadership; the two
-- schemes do not see each other, so never run an old and a new API process side by side with jobs enabled.
CREATE TABLE IF NOT EXISTS "scheduler_lease" (
  "name" text PRIMARY KEY,
  "token" uuid NOT NULL,
  "holder" text NOT NULL,
  "acquired_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz NOT NULL
);
-- DOWN (never run automatically): DROP TABLE "scheduler_lease" (the previous image never reads it).
