-- Migration 0028: licensing performance indexes.
--
-- NOTE (ra-031): Migration 0027 (0027_software_entitlements.sql) declared the
-- activation_token_hash column twice — once in the CREATE TABLE body and once via
-- a subsequent ALTER TABLE ADD COLUMN IF NOT EXISTS. Both use IF NOT EXISTS so the
-- double-declaration is harmless. Do NOT edit 0027 to "fix" this — already-
-- journaled migrations must not change.
--
-- Three indexes that were missing from the initial licensing migration:
--   1. license_activation(license_id)   — seat-count and deactivation look-ups
--   2. download_artifact(app_release_id) — artifact list by release
--   3. license(order_line_id)           — fulfillment look-up at order completion
--
-- All three are append-only; none alter any table column or constraint.

CREATE INDEX IF NOT EXISTS license_activation_license_idx
  ON license_activation (license_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS download_artifact_release_idx
  ON download_artifact (app_release_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS license_order_line_idx
  ON license (order_line_id);
