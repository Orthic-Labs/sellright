-- HAND-WRITTEN: see docs/runbooks/migrations.md — do NOT regenerate via drizzle-kit.
-- Expand-only identity columns preserve old omitted-column inserts. NMI refs
-- belong to an account+mode; unresolved history must not suppress known scope.
ALTER TABLE dispute ADD COLUMN gateway_account text;
ALTER TABLE dispute ADD COLUMN gateway_mode text;
ALTER TABLE dispute ADD CONSTRAINT dispute_gateway_identity_check CHECK (
  (gateway_account IS NULL AND gateway_mode IS NULL) OR
  (provider = 'nmi' AND gateway_account IS NOT NULL AND btrim(gateway_account) <> ''
    AND gateway_mode IS NOT NULL AND gateway_mode IN ('test', 'live'))
);
--> statement-breakpoint
-- Keep FORCE RLS active for both owned ledgers throughout the all-store
-- backfill. Only the already-linked exact payment can prove historical scope.
DO $$
DECLARE
  tenant record;
  prior_store text := current_setting('app.current_store', true);
BEGIN
  FOR tenant IN SELECT id FROM store LOOP
    PERFORM set_config('app.current_store', tenant.id::text, true);
    UPDATE dispute d SET gateway_account = p.gateway_account, gateway_mode = p.gateway_mode
      FROM payment p
      WHERE d.store_id = tenant.id AND d.provider = 'nmi' AND d.payment_id = p.id
        AND p.store_id = d.store_id AND p.method = 'nmi' AND p.provider_ref = d.provider_ref
        AND (d.order_id IS NULL OR d.order_id = p.order_id)
        AND p.gateway_account IS NOT NULL AND btrim(p.gateway_account) <> ''
        AND p.gateway_mode IN ('test', 'live');
  END LOOP;
  PERFORM set_config('app.current_store', coalesce(prior_store, ''), true);
END $$;
--> statement-breakpoint
DROP INDEX dispute_provider_ref_key;
CREATE UNIQUE INDEX dispute_provider_ref_key ON dispute (store_id, provider, provider_ref)
  WHERE provider <> 'nmi';
CREATE UNIQUE INDEX dispute_nmi_identity_key ON dispute (store_id, provider, gateway_account, gateway_mode, provider_ref)
  WHERE provider = 'nmi' AND gateway_account IS NOT NULL AND gateway_mode IS NOT NULL;
CREATE UNIQUE INDEX dispute_nmi_unresolved_key ON dispute (store_id, provider, provider_ref)
  WHERE provider = 'nmi' AND gateway_account IS NULL AND gateway_mode IS NULL;
