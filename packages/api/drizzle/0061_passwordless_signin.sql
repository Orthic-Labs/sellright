-- HAND-WRITTEN: see docs/runbooks/migrations.md — do NOT regenerate via drizzle-kit.
-- 0061 — passwordless sign-in + Sign in with Apple (ported upstream from RightSites).
--
-- 1) customer_token.kind CHECK gains 'magic_link': tokens are minted by
--    POST /v1/shop/auth/magic-link/request and consumed atomically by
--    /v1/shop/auth/magic-link/consume — a single conditional
--    UPDATE ... WHERE used_at IS NULL ... RETURNING, so concurrent
--    redemptions of one token can only ever issue one session.
--    The CHECK is re-created in place; 'email_change' (0057) is preserved in
--    the widened list and the FORCE RLS tenant policy (0023) is untouched.
-- 2) customer.apple_user_id: the Sign-in-with-Apple `sub` for account linking
--    (auth/apple.ts, POST /v1/shop/auth/apple). Unique PER STORE where present —
--    customer identity is tenant-scoped in SellRight (customer_store_email is
--    the precedent), so the same Apple user may legitimately hold accounts in
--    two stores. NB: RightSites' downstream variant is globally unique; keep
--    the shapes distinct-named so a merge can't conflate them.
ALTER TABLE customer_token DROP CONSTRAINT customer_token_kind_check;
ALTER TABLE customer_token ADD CONSTRAINT customer_token_kind_check
  CHECK (kind IN ('password_reset', 'email_verify', 'set_password', 'email_change', 'magic_link'));
ALTER TABLE customer ADD COLUMN IF NOT EXISTS apple_user_id text;
CREATE UNIQUE INDEX IF NOT EXISTS customer_store_apple_user_id_unique
  ON customer (store_id, apple_user_id) WHERE apple_user_id IS NOT NULL;
