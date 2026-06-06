-- Capture a recovery email on guest carts (no account yet) for abandoned-cart
-- recovery. Nullable; account carts still resolve email via the customer join.
-- (drizzle-kit generate re-emitted prior hand-authored 0005-0010 drift; this
-- migration is reduced to the single intended change — the meta snapshot is kept
-- so future generates diff cleanly.)
ALTER TABLE "cart" ADD COLUMN IF NOT EXISTS "email" text;
