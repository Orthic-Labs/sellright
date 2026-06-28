-- Harden the subscription tenant policy to match the repo-wide nullif() RLS
-- pattern. A missing app.current_store must fail closed instead of casting an
-- empty setting directly to uuid.
ALTER POLICY "tenant_isolation" ON "subscription"
  USING ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid)
  WITH CHECK ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid);

-- DOWN
-- ALTER POLICY "tenant_isolation" ON "subscription"
--   USING ("store_id" = current_setting('app.current_store', true)::uuid)
--   WITH CHECK ("store_id" = current_setting('app.current_store', true)::uuid);
