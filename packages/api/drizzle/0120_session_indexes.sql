-- HAND-WRITTEN: see docs/runbooks/migrations.md — do NOT regenerate via drizzle-kit.
-- DB-M1 / DB-L3: indexes behind the session reaper (jobs/session-reaper.ts) and the per-user session deletes.
-- `session` is an RLS-exempt global table (auth looks sessions up by token hash before any store is chosen), so these are
-- ordinary indexes with no FORCE RLS leakproof caveat. Live indexes were only the primary key, token_hash and api_token_id.
--   session_expires_at_idx         reaper batches (expires_at < cutoff ORDER BY expires_at, id)
--   session_legacy_expires_at_idx  reaper's legacy-expiry arm; partial, only imported rows carry the column
--   session_customer_idx           delete-by-customer on logout-everywhere, password change and erasure
--   session_admin_user_idx         delete-by-admin on password change and admin revocation
-- Additive. The table holds hundreds of rows (largest table in the system is 149 MB); a plain build holds the write lock
-- for milliseconds, so no CONCURRENTLY and no non-transactional step is needed.
CREATE INDEX IF NOT EXISTS "session_expires_at_idx" ON "session" ("expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "session_legacy_expires_at_idx" ON "session" ("legacy_expires_at") WHERE "legacy_expires_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "session_customer_idx" ON "session" ("customer_id") WHERE "customer_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "session_admin_user_idx" ON "session" ("admin_user_id") WHERE "admin_user_id" IS NOT NULL;
-- DOWN (never run automatically): DROP INDEX IF EXISTS session_expires_at_idx, session_legacy_expires_at_idx,
--   session_customer_idx, session_admin_user_idx; (no data changes; the previous image never names them).
