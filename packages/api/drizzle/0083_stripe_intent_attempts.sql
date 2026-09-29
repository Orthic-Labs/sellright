-- HAND-WRITTEN: see docs/runbooks/migrations.md — do NOT regenerate via drizzle-kit.
-- Same stale-snapshot drift reason as 0072-0082: drizzle-kit would re-emit
-- CREATE TABLE for already-live tables, so this carries ONLY the additive
-- change below.
--
-- Durable Stripe PaymentIntent tracking (payments audit D1/D5). Every PI
-- minted by /payment-intent is recorded as a payment_attempt row
-- (operation 'intent', method 'stripe', provider_ref = pi_...), so the stale
-- sweeper, the shopper refresh route and the admin reconciliation list can
-- find in-flight Stripe money. New status 'open' = minted, awaiting the
-- shopper; deliberately NOT a payment hold (hold.ts lists only
-- processing/unknown/pending), so an abandoned PI never blocks admin cancel.
--
-- Expand-only: the widened CHECKs accept every value the previous release
-- writes, and the new index is additive.
ALTER TABLE payment_attempt DROP CONSTRAINT IF EXISTS payment_attempt_operation_check;--> statement-breakpoint
ALTER TABLE payment_attempt ADD CONSTRAINT payment_attempt_operation_check
  CHECK (operation IN ('charge','session','refund','capture','void','intent'));--> statement-breakpoint
ALTER TABLE payment_attempt DROP CONSTRAINT IF EXISTS payment_attempt_status_check;--> statement-breakpoint
ALTER TABLE payment_attempt ADD CONSTRAINT payment_attempt_status_check
  CHECK (status IN ('processing','unknown','pending','settled','failed','cancelled','open'));--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS payment_attempt_stripe_intent_uidx
  ON payment_attempt (store_id, provider_ref)
  WHERE operation = 'intent' AND provider_ref IS NOT NULL;
-- DOWN
-- DROP INDEX IF EXISTS payment_attempt_stripe_intent_uidx;
-- (CHECK widening is not reverted: rows with operation 'intent' / status 'open' may exist.)
