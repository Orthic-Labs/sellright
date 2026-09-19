-- HAND-WRITTEN: see docs/runbooks/migrations.md — do NOT regenerate via drizzle-kit.
-- 0057 — SR-05/SR-12 hardening + emailAddressChangeHandler parity (PAR inventory).
--
-- 1) customer_token.kind CHECK gains 'email_change': the email-address-change flow
--    mints a one-time token mailed to the NEW address (Vendure
--    emailAddressChangeHandler parity). The CHECK is re-created in place — the
--    table's FORCE RLS tenant policy (0023) is untouched.
-- 2) customer_token.payload jsonb: binds the pending new address to the token
--    row itself, so a link cannot be replayed against a different address and
--    each outstanding request is self-contained (superseding = mark old rows
--    used; no shared mutable slot on the customer row).
-- 3) email_outbox.dedupe_key: exactly-once enqueue for event-driven sends.
--    Producers pass a stable key (e.g. 'order-refund-confirmation:<refundId>');
--    a replayed settlement event hits the partial unique index and the insert
--    is a no-op (ON CONFLICT DO NOTHING) instead of a duplicate customer email.
--    Partial index keeps non-keyed rows (password resets etc.) unaffected.

ALTER TABLE customer_token DROP CONSTRAINT customer_token_kind_check;
-- Existing consumers may already issue magic links before this upgrade.
-- Preserve them here: a later widening cannot rescue this intermediate CHECK.
ALTER TABLE customer_token ADD CONSTRAINT customer_token_kind_check
  CHECK (kind IN ('password_reset', 'email_verify', 'set_password', 'email_change', 'magic_link'));
ALTER TABLE customer_token ADD COLUMN IF NOT EXISTS payload jsonb;

ALTER TABLE email_outbox ADD COLUMN IF NOT EXISTS dedupe_key text;
CREATE UNIQUE INDEX IF NOT EXISTS email_outbox_dedupe_key
  ON email_outbox (store_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
