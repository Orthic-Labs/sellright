-- HAND-WRITTEN: see docs/runbooks/migrations.md
-- 0095: least-privilege read of the migration journal for the startup gate.
--
-- The serving process runs as the NOSUPERUSER/NOBYPASSRLS runtime role, which has no USAGE on schema `drizzle`, so it
-- cannot read `drizzle.__drizzle_migrations` and createApp's `verify` mode could not run (index.ts used `skip`, letting
-- new code serve against an old schema). Rather than grant that role access to the journal schema, this SECURITY DEFINER
-- function (owned by the migration role, which owns the journal tables) returns exactly one number: the newest applied
-- migration's `created_at`, or NULL when the journal table does not exist. It reads nothing else and writes nothing.
--
-- Only schema `drizzle` is served (the journal schema every track defaults to); any other schema is refused so the
-- definer cannot be pointed at arbitrary tables. EXECUTE stays at the PUBLIC default, like resolve_store_for_gateway_event
-- (0053): the runtime role's name is a deployment choice a migration cannot know, and the result discloses only a
-- migration timestamp.
CREATE OR REPLACE FUNCTION public.sellright_migration_last_applied(p_schema text, p_table text)
RETURNS bigint
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_reg regclass;
  v_last bigint;
BEGIN
  IF p_schema IS DISTINCT FROM 'drizzle' OR p_table IS NULL OR p_table = '' THEN
    RAISE EXCEPTION 'sellright_migration_last_applied only serves journal tables in schema drizzle' USING ERRCODE = '22023';
  END IF;
  v_reg := to_regclass(format('%I.%I', p_schema, p_table));
  IF v_reg IS NULL THEN RETURN NULL; END IF;
  EXECUTE format('SELECT max(created_at) FROM %s', v_reg) INTO v_last;
  RETURN v_last;
END
$fn$;
-- Rollback: DROP FUNCTION public.sellright_migration_last_applied(text, text);
