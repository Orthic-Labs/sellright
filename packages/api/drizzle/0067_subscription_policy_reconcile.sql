-- HAND-WRITTEN: see docs/runbooks/migrations.md -- do NOT regenerate via drizzle-kit.
-- Repair older deployment histories that skipped the original policy hardening.
-- Forward-only: preserve migration history and all subscription rows.
ALTER POLICY "tenant_isolation" ON "subscription"
  USING ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid)
  WITH CHECK ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid);
