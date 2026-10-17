-- HAND-WRITTEN: see docs/runbooks/migrations.md — do NOT regenerate via drizzle-kit.
CREATE TABLE customer_address_draft (
  id uuid PRIMARY KEY, store_id uuid NOT NULL REFERENCES store(id),
  customer_id uuid NOT NULL REFERENCES customer(id) ON DELETE CASCADE,
  source_key text NOT NULL, source_id text NOT NULL, source_customer_id text NOT NULL, source_digest text NOT NULL,
  full_name text, line1 text, line2 text, city text, province text, postal_code text, phone text,
  source_country_id text, country_code text, is_default_shipping boolean, is_default_billing boolean,
  CONSTRAINT address_draft_source_identity UNIQUE(store_id, source_key, source_id)
);
ALTER TABLE customer_address_draft ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_address_draft FORCE ROW LEVEL SECURITY;
CREATE POLICY customer_address_draft_store ON customer_address_draft
USING (store_id = NULLIF(current_setting('app.current_store', true), '')::uuid)
WITH CHECK (store_id = NULLIF(current_setting('app.current_store', true), '')::uuid);

CREATE TABLE financial_payment_archive (
  id uuid PRIMARY KEY, store_id uuid NOT NULL REFERENCES store(id),
  source_key text NOT NULL, source_id text NOT NULL, source_digest text NOT NULL,
  source_created_at text, source_order_id text, method text, state text, amount integer,
  transaction_id text, metadata text, error_message text, import_currency_context text NOT NULL,
  source_record text NOT NULL, source_refunds text[] NOT NULL DEFAULT '{}'::text[],
  source_references text[] NOT NULL DEFAULT '{}'::text[],
  CONSTRAINT payment_archive_source_identity UNIQUE(store_id, source_key, source_id)
);
ALTER TABLE financial_payment_archive ENABLE ROW LEVEL SECURITY;
ALTER TABLE financial_payment_archive FORCE ROW LEVEL SECURITY;
CREATE POLICY financial_payment_archive_store ON financial_payment_archive
USING (store_id = NULLIF(current_setting('app.current_store', true), '')::uuid)
WITH CHECK (store_id = NULLIF(current_setting('app.current_store', true), '')::uuid);
