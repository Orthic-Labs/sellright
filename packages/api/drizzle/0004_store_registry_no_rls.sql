-- The `store` table is the tenant REGISTRY, not tenant data. Host->store_id
-- resolution (before any RLS context exists) and the admin store-switcher both
-- need to read it. It holds no per-tenant business data (just name/slug/config),
-- so it is not self-RLS'd. All store_id-bearing DATA tables keep their RLS.
ALTER TABLE "store" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "store" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "store_isolation" ON "store";
