-- Non-owner app role prep (research §1, AWS-canonical RLS pattern).
--
-- admin_user_store is an ACL/registry: which admin can access which store. The
-- app must read it BEFORE any store context exists (to build an admin's store
-- list / the switcher), and it is inherently cross-store. Under a NON-owner app
-- role, the leftover RLS policy (store_id = current_store) would return ZERO
-- rows pre-context and break admin login. So fully DISABLE RLS here, exactly
-- like the `store` registry (0004 already disabled store's RLS). The app filters
-- by admin_user_id; writes happen only via the owner role (seed-admin).
--
-- Every store-scoped DATA table keeps FORCE RLS — the non-owner role stays
-- fail-closed there.
DROP POLICY IF EXISTS "tenant_isolation" ON "admin_user_store";--> statement-breakpoint
ALTER TABLE "admin_user_store" DISABLE ROW LEVEL SECURITY;
