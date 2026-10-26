-- HAND-WRITTEN: see docs/runbooks/migrations.md — do NOT regenerate via drizzle-kit.
-- Per-admin, per-store UI preferences (#381): the Order Export page remembers what each admin last used (statuses,
-- dates, rows, format, columns and their order) and their named presets, server-side, so they follow the admin across
-- browsers and devices. One row per (store, admin, key); value is the page's own JSON. Store-scoped: FORCE RLS on
-- app.current_store like every tenant table. Additive: the previous image never reads it. Runtime grants follow
-- schema-owner default privileges.
CREATE TABLE "admin_preference" (
  "store_id" uuid NOT NULL REFERENCES "store"("id") ON DELETE CASCADE,
  "admin_user_id" uuid NOT NULL REFERENCES "admin_user"("id") ON DELETE CASCADE,
  "key" text NOT NULL CHECK ("key" ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  "value" jsonb NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("store_id", "admin_user_id", "key")
);--> statement-breakpoint
ALTER TABLE "admin_preference" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "admin_preference" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "admin_preference" USING ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid) WITH CHECK ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid);
-- DOWN (never run automatically): DROP TABLE "admin_preference" (the previous image never reads it).
