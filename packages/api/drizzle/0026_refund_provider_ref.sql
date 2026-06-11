-- WP3: store the gateway refund reference (e.g. Stripe re_...) on the refund row
-- so dashboard reconciliation can match a ledger refund to the provider refund.
-- Additive column on an already-FORCE-RLS table — no policy change needed.
-- Idempotent (matches the 0022-0025 hand-authored style).
ALTER TABLE "refund" ADD COLUMN IF NOT EXISTS "provider_ref" text;
