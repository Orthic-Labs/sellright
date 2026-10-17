-- HAND-WRITTEN: see docs/runbooks/migrations.md — do NOT regenerate via drizzle-kit.
-- Source deltas are retained separately: they cannot prove native before/after order snapshots.
CREATE TABLE imported_order_modification (
  id uuid PRIMARY KEY, store_id uuid NOT NULL REFERENCES store(id),
  source_key text NOT NULL, source_id text NOT NULL, source_digest text NOT NULL,
  source_record text NOT NULL, source_references text[] NOT NULL DEFAULT '{}'::text[],
  source_order_id text, source_refund_id text, source_payment_id text,
  order_id uuid REFERENCES "order"(id) ON DELETE SET NULL,
  refund_id uuid REFERENCES refund(id) ON DELETE SET NULL,
  payment_id uuid REFERENCES payment(id) ON DELETE SET NULL,
  scope_disposition text NOT NULL,
  source_created_at text, source_updated_at text, price_change integer NOT NULL, note text NOT NULL,
  shipping_address_change text, billing_address_change text,
  CONSTRAINT imported_modification_source_identity UNIQUE(store_id, source_key, source_id),
  CONSTRAINT imported_modification_scope CHECK(scope_disposition IN ('selected_channel','other_channel','unresolved_parent')),
  CONSTRAINT imported_modification_projection CHECK(scope_disposition = 'selected_channel' OR (order_id IS NULL AND refund_id IS NULL AND payment_id IS NULL))
);
CREATE INDEX imported_modification_order ON imported_order_modification(store_id, order_id);
ALTER TABLE imported_order_modification ENABLE ROW LEVEL SECURITY;
ALTER TABLE imported_order_modification FORCE ROW LEVEL SECURITY;
CREATE POLICY imported_order_modification_store ON imported_order_modification
USING (store_id = NULLIF(current_setting('app.current_store', true), '')::uuid)
WITH CHECK (store_id = NULLIF(current_setting('app.current_store', true), '')::uuid);
