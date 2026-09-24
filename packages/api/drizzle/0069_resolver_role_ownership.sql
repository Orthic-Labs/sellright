-- HAND-WRITTEN: see docs/runbooks/migrations.md
-- SR-01/SR-02 follow-up: least-privilege ownership for the cross-tenant
-- SECURITY DEFINER resolver seam (0053/0060 resolve_store_for_gateway_event,
-- 0066 resolve_store_for_storekit_bundle).
--
-- Both functions are SECURITY DEFINER and run as their OWNER, not as the
-- caller — every table they read (payment, payment_attempt, subscription,
-- gateway_event, storekit_app) carries FORCE ROW LEVEL SECURITY, and their
-- owner has always been the migration role. Their original comments said
-- "requires the migration role to be superuser/BYPASSRLS", but the migration
-- role (`sellright`) is deliberately NOSUPERUSER/NOBYPASSRLS (SR-01 — the
-- same reason the runtime role is) so it cannot see other tenants' rows
-- either. Result: as owner, these functions have been silently returning
-- NULL for every candidate that isn't already visible to the connecting
-- session — i.e. always NULL, since no app.current_store is set when they're
-- called (see payments/tenant-resolution.db.test.ts pre-fix).
--
-- Fix: a dedicated NOLOGIN role that owns ONLY these two functions, holding
-- BYPASSRLS so the definer body actually sees across tenants, and SELECT-only
-- grants on exactly the tables the two bodies read — nothing else, and never
-- INSERT/UPDATE/DELETE. BYPASSRLS is never granted to `sellright_app` (the
-- runtime role) or to `sellright` (the migration role) itself — only to this
-- narrow role, and only these two functions run as it.
--
-- The role itself (CREATE ROLE ... BYPASSRLS) can only be created by a
-- superuser — see docs/runbooks/postgres-app-role.md "Resolver role
-- bootstrap" and deploy/compose.yaml's db-init service. This migration is
-- the non-privileged half: it re-points ownership/grants at whatever role
-- exists under that name, and is a safe no-op — leaving the functions owned
-- by `sellright` exactly as before — when that bootstrap hasn't run yet
-- (fresh dev/CI databases without the operator step). Re-running this
-- migration after the role IS created (e.g. a later `db:migrate` on an
-- environment that only just got the bootstrap applied) converges it, so
-- there is no ordering requirement between "run this migration" and "run the
-- superuser bootstrap" beyond wanting the fix to actually take effect.
--
-- The bootstrap also does `GRANT sellright_resolver TO sellright` so
-- `sellright` has_privs_of_role(sellright_resolver) — that's what lets a
-- normal (non-superuser) `sellright` session both run the ALTER OWNER TO
-- below and, in every future migration, CREATE OR REPLACE these two
-- functions without needing to be superuser again.
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'sellright_resolver') THEN
    EXECUTE 'GRANT SELECT ON public.payment, public.payment_attempt, public.subscription, public.gateway_event TO sellright_resolver';
    EXECUTE 'GRANT SELECT ON public.storekit_app TO sellright_resolver';
    -- ALTER ... OWNER TO requires the new owner to hold CREATE on the schema.
    -- Grant it only for the ownership change, then take it back: the role
    -- keeps USAGE (needed to resolve the tables its functions read) only.
    EXECUTE 'GRANT USAGE, CREATE ON SCHEMA public TO sellright_resolver';
    EXECUTE 'ALTER FUNCTION public.resolve_store_for_gateway_event(text, text, text, text, text) OWNER TO sellright_resolver';
    EXECUTE 'ALTER FUNCTION public.resolve_store_for_storekit_bundle(text) OWNER TO sellright_resolver';
    EXECUTE 'REVOKE CREATE ON SCHEMA public FROM sellright_resolver';
  END IF;
END
$$;
