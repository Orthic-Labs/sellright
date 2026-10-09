-- HAND-WRITTEN: see docs/runbooks/migrations.md — do NOT regenerate via drizzle-kit.
-- Fail-closed RLS: 0002 wrapped current_setting('app.current_store', true) in
-- nullif(..., '') so an EMPTY setting yields NULL (zero rows) instead of a
-- 22P02 "invalid input syntax for type uuid" error. A pooled connection that
-- has ever run withStore() keeps app.current_store = '' (not NULL) after the
-- transaction ends, so any later unscoped query on it hit the cast error on
-- the tables below, whose policies (0038/0039/0041/0048/0049) were written
-- without the nullif. Re-create exactly those seven policies with the 0002
-- pattern. Semantics are unchanged for a set store id; only the empty-string
-- case changes (error -> zero rows). ALTER POLICY is idempotent and
-- expand-only.
ALTER POLICY "tenant_isolation" ON "admin_device_token" USING ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid) WITH CHECK ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid);
--> statement-breakpoint
ALTER POLICY "tenant_isolation" ON "contact_submission" USING ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid) WITH CHECK ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid);
--> statement-breakpoint
ALTER POLICY "tenant_isolation" ON "email_outbox" USING ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid) WITH CHECK ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid);
--> statement-breakpoint
ALTER POLICY "tenant_isolation" ON "push_outbox" USING ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid) WITH CHECK ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid);
--> statement-breakpoint
ALTER POLICY "tenant_isolation" ON "restock_event" USING ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid) WITH CHECK ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid);
--> statement-breakpoint
ALTER POLICY "tenant_isolation" ON "restock_request" USING ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid) WITH CHECK ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid);
--> statement-breakpoint
ALTER POLICY "tenant_isolation" ON "subscriber" USING ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid) WITH CHECK ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid);
