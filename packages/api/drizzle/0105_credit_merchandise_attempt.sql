-- HAND-WRITTEN: see docs/runbooks/migrations.md — do NOT regenerate via drizzle-kit.
-- Zero cash records an explicitly proven merchandise return, never gateway I/O.
ALTER TABLE payment_attempt DROP CONSTRAINT payment_attempt_amount_check;
ALTER TABLE payment_attempt ADD CONSTRAINT payment_attempt_amount_check CHECK (
  amount > 0 OR (
    amount = 0 AND operation = 'refund' AND method = 'credit_merchandise' AND mode = 'internal'
    AND payment_id IS NOT NULL AND provider_ref IS NULL
    AND COALESCE(context->>'authority' = 'credit_merchandise', false)
    AND COALESCE(context->>'redemptionId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$', false)
  )
);
--> statement-breakpoint
ALTER TABLE payment_attempt DROP CONSTRAINT payment_attempt_mode_check;
ALTER TABLE payment_attempt ADD CONSTRAINT payment_attempt_mode_check CHECK (
  (mode IN ('test','live') AND method <> 'credit_merchandise') OR
  (mode = 'internal' AND method = 'credit_merchandise' AND operation = 'refund' AND amount = 0)
);
