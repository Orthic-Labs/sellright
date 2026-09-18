-- HAND-WRITTEN: see docs/runbooks/migrations.md
-- SR-03/SR-04: payment/refund identity hardening for the webhook settle and
-- refund-reconcile paths.
--
-- 1) payment dedupe index: the composite key included coalesce(gateway_mode,'')
--    so a Stripe payment row that gains its persisted mode AFTER insert (the
--    subscription invoice.paid backfill, or a row written before SR-03 mode
--    persistence) would stop matching a later insert of the SAME provider_ref —
--    a webhook redelivery then inserted a duplicate ledger row instead of
--    deduping. Stripe provider refs (pi_...) are bound to exactly one
--    account+mode namespace at the provider, so the stripe index keys on
--    (store_id, provider_ref) alone. nmi/sezzle keep the account+mode key:
--    their transaction ids can legitimately collide across accounts/modes.
-- 2) refund (store_id, payment_id, provider_ref) uniqueness: hardens the
--    reconcile path's dedupe against a concurrent insert race, so one provider
--    refund (re_...) can never land as two refund rows on the same payment.
DROP INDEX IF EXISTS payment_store_provider_ref_uidx;
CREATE UNIQUE INDEX payment_store_provider_ref_uidx
  ON payment (store_id, method, coalesce(gateway_account, ''), coalesce(gateway_mode, ''), provider_ref)
  WHERE provider_ref IS NOT NULL AND method <> 'stripe';
CREATE UNIQUE INDEX payment_stripe_provider_ref_uidx
  ON payment (store_id, provider_ref)
  WHERE provider_ref IS NOT NULL AND method = 'stripe';
CREATE UNIQUE INDEX refund_payment_provider_ref_uidx
  ON refund (store_id, payment_id, provider_ref)
  WHERE provider_ref IS NOT NULL;
