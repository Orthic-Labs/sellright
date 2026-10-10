-- 0092: runtime artifact identity slots (upstream of the RightSites fork's
-- `artifact_id`, de-fork Phase 5). Additive except for one relaxation:
-- the current-pointer key widens from (store, app, kind, os, arch) to
-- (store, app, kind, artifact_id, os, arch) with NULLS NOT DISTINCT, so legacy
-- rows (artifact_id NULL) keep exactly the old uniqueness while identified
-- artifacts get their own slot. Existing rows satisfy the new key by
-- construction. No FK is added or changed; no existing delete is affected.

ALTER TABLE "runtime_artifact_promotion" ADD COLUMN IF NOT EXISTS "artifact_id" text;
--> statement-breakpoint
ALTER TABLE "runtime_artifact_promotion" DROP CONSTRAINT IF EXISTS "runtime_artifact_promotion_current";
--> statement-breakpoint
ALTER TABLE "runtime_artifact_promotion" ADD CONSTRAINT "runtime_artifact_promotion_current"
  UNIQUE NULLS NOT DISTINCT ("store_id", "app_key", "artifact_kind", "artifact_id", "target_os", "target_arch");

-- DOWN
-- ALTER TABLE "runtime_artifact_promotion" DROP CONSTRAINT "runtime_artifact_promotion_current";
-- ALTER TABLE "runtime_artifact_promotion" ADD CONSTRAINT "runtime_artifact_promotion_current"
--   UNIQUE ("store_id", "app_key", "artifact_kind", "target_os", "target_arch");
-- ALTER TABLE "runtime_artifact_promotion" DROP COLUMN IF EXISTS "artifact_id";
