-- HAND-WRITTEN: see docs/runbooks/migrations.md
-- SR-01/SR-02: pre-context tenant resolution for inbound gateway events.
-- Webhook handlers must learn the owning store_id BEFORE any
-- app.current_store exists and while connected as the RLS nonowner role.
-- A scoped query can't do that (FORCE RLS fails closed — zero rows), so the
-- seam is this SECURITY DEFINER function owned by the migration role. It is
-- deliberately narrow: it returns ONLY a store_id (never row data), and
-- every lookup is bound to the event's provider via the method column so a
-- reference minted by another gateway can never resolve a tenant.
--
-- EXECUTE stays at the PUBLIC default: the runtime app role must call it and
-- that role's name is a deployment choice a migration cannot know. The
-- result is an existence oracle over unguessable provider refs — a caller
-- must already know the exact ref to learn its store_id.
--
-- Requires the migration role to be a superuser (or BYPASSRLS): as definer it
-- must read across all tenants regardless of FORCE RLS.
CREATE OR REPLACE FUNCTION public.resolve_store_for_gateway_event(
  p_provider text,
  p_payment_ref text DEFAULT NULL,
  p_subscription_ref text DEFAULT NULL,
  p_account_ref text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_store uuid;
BEGIN
  IF p_provider IS NULL OR p_provider NOT IN ('stripe', 'nmi', 'sezzle') THEN
    RETURN NULL;
  END IF;

  IF p_payment_ref IS NOT NULL AND p_payment_ref <> '' THEN
    -- Settled ledger row (stripe payment_intent / nmi transactionid /
    -- sezzle order uuid in payment.provider_ref).
    SELECT pay.store_id INTO v_store
      FROM public.payment AS pay
     WHERE pay.method = p_provider AND pay.provider_ref = p_payment_ref
     ORDER BY pay.created_at DESC
     LIMIT 1;
    IF v_store IS NOT NULL THEN RETURN v_store; END IF;

    -- Pre-settle attempt row (provider ref recorded before the payment row).
    SELECT att.store_id INTO v_store
      FROM public.payment_attempt AS att
     WHERE att.method = p_provider AND att.provider_ref = p_payment_ref
     ORDER BY att.created_at DESC
     LIMIT 1;
    IF v_store IS NOT NULL THEN RETURN v_store; END IF;
  END IF;

  -- Stripe Billing anchor: our subscription row's provider id (the reliable
  -- tenant link for invoice.* / customer.subscription.* events).
  IF p_provider = 'stripe' AND p_subscription_ref IS NOT NULL AND p_subscription_ref <> '' THEN
    SELECT sub.store_id INTO v_store
      FROM public.subscription AS sub
     WHERE sub.stripe_subscription_id = p_subscription_ref
     LIMIT 1;
    IF v_store IS NOT NULL THEN RETURN v_store; END IF;
  END IF;

  -- Provider-account anchor: the gateway accountId recorded on attempts and
  -- ingested events (nmi/sezzle account profiles are bound to one store).
  IF p_account_ref IS NOT NULL AND p_account_ref <> '' THEN
    SELECT att.store_id INTO v_store
      FROM public.payment_attempt AS att
     WHERE att.method = p_provider AND att.account_id = p_account_ref
     ORDER BY att.created_at DESC
     LIMIT 1;
    IF v_store IS NOT NULL THEN RETURN v_store; END IF;

    SELECT evt.store_id INTO v_store
      FROM public.gateway_event AS evt
     WHERE evt.method = p_provider AND evt.account_id = p_account_ref
     ORDER BY evt.created_at DESC
     LIMIT 1;
    IF v_store IS NOT NULL THEN RETURN v_store; END IF;
  END IF;

  RETURN NULL;
END;
$fn$;
