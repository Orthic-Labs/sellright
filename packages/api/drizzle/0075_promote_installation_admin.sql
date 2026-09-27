-- HAND-WRITTEN: see docs/runbooks/migrations.md — do NOT regenerate via drizzle-kit.
-- WS-B (one-click install plan §1.3/§1.4) upgrade path. An EXISTING
-- deployment upgraded to the release that introduced
-- admin_user.is_installation_admin (0072_installation_admin.sql) has real
-- admin_user rows but none flagged installation-admin yet.
--
-- /v1/setup/* is correctly gated on hasAnyAdmin() (see auth/setup-claim.ts),
-- not hasInstallationAdmin() — so an upgraded install's real admins are never
-- locked out behind the claim screen regardless of this migration. But
-- system operations gated on requireInstallationAdmin() (recovery-kit
-- download today; backup/restore/add-store triggers in later workstreams)
-- would stay permanently unreachable after an upgrade, because nothing else
-- ever sets the flag on a path that never goes through POST
-- /v1/setup/claim. This migration promotes exactly one existing admin so
-- those operations stay reachable.
--
-- Idempotent — safe to run on every deploy:
--   * no-ops if an installation admin already exists (a fresh install
--     claimed through POST /v1/setup/claim, or this migration already ran);
--   * no-ops if admin_user is empty (a truly fresh, not-yet-claimed install —
--     install.sh's normal path; the claim flow itself sets the flag).
--
-- Selection: the earliest-created admin holding an 'owner' membership on any
-- store (matches "the person who set this install up"), falling back to the
-- earliest-created admin overall when none holds 'owner' (e.g. a staff-only
-- seed). Ties broken by id for determinism.

DO $$
DECLARE
  chosen uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM "admin_user" WHERE "is_installation_admin") THEN
    RETURN;
  END IF;

  SELECT au.id INTO chosen
  FROM "admin_user" au
  JOIN "admin_user_store" aus ON aus.admin_user_id = au.id AND aus.role = 'owner'
  ORDER BY au.created_at ASC, au.id ASC
  LIMIT 1;

  IF chosen IS NULL THEN
    SELECT id INTO chosen FROM "admin_user" ORDER BY created_at ASC, id ASC LIMIT 1;
  END IF;

  IF chosen IS NOT NULL THEN
    UPDATE "admin_user" SET is_installation_admin = true WHERE id = chosen;
  END IF;
END $$;

-- DOWN
-- (data-only migration; no schema to revert. To undo a promotion:
--  UPDATE "admin_user" SET is_installation_admin = false WHERE id = '<chosen>';)
