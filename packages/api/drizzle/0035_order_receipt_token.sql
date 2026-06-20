-- Custom SQL migration file, put your code below! --

-- Checkout-migration (Stripe): a high-entropy receipt token returned by
-- POST /v1/shop/checkout and carried (?rt=) to the confirmation page + the Stripe
-- return_url. The public order-by-code read (GET /v1/shop/orders/{code}) grants
-- access only when this token matches OR the authed customer owns the order —
-- never bare-code (an order code is SR+10 hex, ~enumerable; bare-code would leak
-- PII). Additive, nullable: pre-existing orders have NULL (read only by the
-- authed owner). RLS posture on "order" is unchanged (already FORCE-RLS'd).
ALTER TABLE "order" ADD COLUMN IF NOT EXISTS "receipt_token" text;
-- DOWN
-- ALTER TABLE "order" DROP COLUMN "receipt_token";
