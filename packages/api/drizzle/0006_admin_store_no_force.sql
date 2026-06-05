-- admin_user_store is an ACL/registry table (which admin can access which store),
-- not tenant data. Like the `store` registry (0004), the owner must read it
-- BEFORE a store context is chosen — to resolve an admin's accessible stores for
-- the store switcher. FORCE RLS would hide every row pre-context. Drop FORCE so
-- the owning DB role bypasses the policy; the policy itself stays for any
-- non-owner role. Data tables (order, product, customer, ...) keep FORCE.
ALTER TABLE "admin_user_store" NO FORCE ROW LEVEL SECURITY;
