-- HAND-WRITTEN: see docs/runbooks/migrations.md — do NOT regenerate via drizzle-kit.
-- 0093: admits the entitlement-reversal vocabulary (de-fork policy hook onEntitlementReversal).
-- Operation kinds: order_refunded (identity order.id), dispute_opened (identity stripe_dispute:<dispute id>).
-- Effect kind: entitlement_reversal. Both CHECK constraints are widened; no rows change.
-- The widened lists are exactly the SETTLEMENT_KINDS / EFFECT_KINDS of settlement/ops.ts.

ALTER TABLE "settlement_operation" DROP CONSTRAINT IF EXISTS "settlement_operation_kind_check";
--> statement-breakpoint
ALTER TABLE "settlement_operation" ADD CONSTRAINT "settlement_operation_kind_check" CHECK ("operation_kind" IN ('stripe_invoice_paid', 'payment_settled', 'payment_state_progress', 'order_paid_transition', 'admin_draft_create', 'order_edit_balance_settled', 'duplicate_capture_recorded', 'historical_import', 'synthetic_seed', 'payment_mode_corrected', 'order_purge', 'operator_resolution', 'order_refunded', 'dispute_opened'));
--> statement-breakpoint
ALTER TABLE "order_pending_effect" DROP CONSTRAINT IF EXISTS "order_pending_effect_kind_check";
--> statement-breakpoint
ALTER TABLE "order_pending_effect" ADD CONSTRAINT "order_pending_effect_kind_check" CHECK ("effect_kind" IN ('license_issue', 'license_extend', 'loyalty_earn', 'notification', 'edit_reconcile', 'admin_review', 'entitlement_reversal'));

-- DOWN
-- ALTER TABLE "order_pending_effect" DROP CONSTRAINT "order_pending_effect_kind_check";
-- ALTER TABLE "order_pending_effect" ADD CONSTRAINT "order_pending_effect_kind_check" CHECK ("effect_kind" IN ('license_issue', 'license_extend', 'loyalty_earn', 'notification', 'edit_reconcile', 'admin_review'));
-- ALTER TABLE "settlement_operation" DROP CONSTRAINT "settlement_operation_kind_check";
-- ALTER TABLE "settlement_operation" ADD CONSTRAINT "settlement_operation_kind_check" CHECK ("operation_kind" IN ('stripe_invoice_paid', 'payment_settled', 'payment_state_progress', 'order_paid_transition', 'admin_draft_create', 'order_edit_balance_settled', 'duplicate_capture_recorded', 'historical_import', 'synthetic_seed', 'payment_mode_corrected', 'order_purge', 'operator_resolution'));
