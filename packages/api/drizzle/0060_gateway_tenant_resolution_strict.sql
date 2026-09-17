-- HAND-WRITTEN: see docs/runbooks/migrations.md
-- SR-02 strict tenant resolution (supersedes the 0053 loose resolver).
--
-- The 0053 function picked the FIRST matching row (ORDER BY created_at DESC
-- LIMIT 1) and consulted account_ref only as a fallback after ref lookups.
-- Two stores holding the same provider_ref — a test-mode ref colliding across
-- accounts, an imported row + a live row sharing a ref — silently resolved to
-- the newest row, so a webhook could apply to the WRONG tenant.
--
-- Strict semantics: collect the DISTINCT set of store_ids across ALL
-- applicable lookups and resolve only when the set has exactly one member —
-- zero or more than one returns NULL (fail closed). No ORDER BY/LIMIT can
-- hide a conflict.
--
-- Caller-supplied bindings narrow candidate rows, never widen them:
--   p_account_ref — payment_attempt/gateway_event candidates must have
--     account_id = p_account_ref; payment rows must have
--     gateway_account = p_account_ref. A ref hit on a different account is
--     EXCLUDED — if exclusions leave zero rows the result is NULL, never a
--     fallback to the unfiltered hit.
--   p_mode ('test'/'live') — payment.gateway_mode, payment_attempt.mode and
--     gateway_event.mode must equal it; rows with NULL mode do not match a
--     supplied mode. subscription rows carry no account/mode and stay
--     unbound (the stripe_subscription_id anchor is provider-unique anyway).
--
-- The old 4-arg function must be DROPPED, not left as an overload: Postgres
-- prefers an exact-arity match over a defaulted-param match, so keeping it
-- would silently route every existing 4-arg call to the LOOSE version.
DROP FUNCTION IF EXISTS public.resolve_store_for_gateway_event(text, text, text, text);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.resolve_store_for_gateway_event(
  p_provider text,
  p_payment_ref text DEFAULT NULL,
  p_subscription_ref text DEFAULT NULL,
  p_account_ref text DEFAULT NULL,
  p_mode text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_stores uuid[];
BEGIN
  IF p_provider IS NULL OR p_provider NOT IN ('stripe', 'nmi', 'sezzle') THEN
    RETURN NULL;
  END IF;

  -- Normalize: empty/blank refs are no-ref; mode matches case-insensitively.
  p_payment_ref := NULLIF(btrim(p_payment_ref), '');
  p_subscription_ref := NULLIF(btrim(p_subscription_ref), '');
  p_account_ref := NULLIF(btrim(p_account_ref), '');
  p_mode := NULLIF(lower(btrim(p_mode)), '');

  -- DISTINCT store_ids across every applicable lookup. With account/mode
  -- supplied, `col = p_...` is NULL for unbound rows and the OR fails — so a
  -- supplied binding both narrows ref hits and excludes NULL-identity rows.
  WITH candidates AS (
    -- Settled ledger row (stripe payment_intent / nmi transactionid /
    -- sezzle order uuid in payment.provider_ref).
    SELECT pay.store_id
      FROM public.payment AS pay
     WHERE p_payment_ref IS NOT NULL
       AND pay.method = p_provider
       AND pay.provider_ref = p_payment_ref
       AND (p_account_ref IS NULL OR pay.gateway_account = p_account_ref)
       AND (p_mode IS NULL OR pay.gateway_mode = p_mode)
    UNION
    -- Pre-settle attempt row (provider ref recorded before the payment row).
    SELECT att.store_id
      FROM public.payment_attempt AS att
     WHERE p_payment_ref IS NOT NULL
       AND att.method = p_provider
       AND att.provider_ref = p_payment_ref
       AND (p_account_ref IS NULL OR att.account_id = p_account_ref)
       AND (p_mode IS NULL OR att.mode = p_mode)
    UNION
    -- Stripe Billing anchor: our subscription row's provider id (the reliable
    -- tenant link for invoice.* / customer.subscription.* events).
    SELECT sub.store_id
      FROM public.subscription AS sub
     WHERE p_provider = 'stripe'
       AND p_subscription_ref IS NOT NULL
       AND sub.stripe_subscription_id = p_subscription_ref
    UNION
    -- Provider-account anchors: the gateway accountId recorded on attempts
    -- and ingested events (nmi/sezzle account profiles bind to one store).
    SELECT att.store_id
      FROM public.payment_attempt AS att
     WHERE p_account_ref IS NOT NULL
       AND att.method = p_provider
       AND att.account_id = p_account_ref
       AND (p_mode IS NULL OR att.mode = p_mode)
    UNION
    SELECT evt.store_id
      FROM public.gateway_event AS evt
     WHERE p_account_ref IS NOT NULL
       AND evt.method = p_provider
       AND evt.account_id = p_account_ref
       AND (p_mode IS NULL OR evt.mode = p_mode)
  )
  SELECT array_agg(s.store_id) INTO v_stores
    FROM (SELECT DISTINCT store_id FROM candidates) AS s;

  -- Exactly one distinct store resolves; zero or several fail closed.
  IF v_stores IS NULL OR cardinality(v_stores) <> 1 THEN
    RETURN NULL;
  END IF;
  RETURN v_stores[1];
END;
$fn$;
