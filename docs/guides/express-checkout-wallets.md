# Express checkout: Apple Pay, Google Pay, Link and Klarna

Checkout shows Apple Pay / Google Pay buttons at the top (Stripe Express Checkout Element) for any store whose Stripe
card gateway is configured. The feature is generic: no per-brand code or flag.

## Where the buttons show

- **Checkout** (top of the page, with the "Or continue below" line): the shopper's cart.
- **Cart drawer** (platform `components/cart/Cart.tsx`, above CHECKOUT, every brand): the shopper's cart, same flow.
- **Product page**, where a brand view places `ExpressBuyButtons` from `~/platform/views` under ADD TO CART:

  ```tsx
  <ExpressBuyButtons sku={props.selection.variantSku} currency={props.product.currencyCode} buttonHeight={48} />
  ```

  `sku` null (no complete option selection) renders no button and never opens a sheet. `buttonHeight` (40–55px,
  clamped) should match ADD TO CART. Buy-now charges exactly one unit of that variant through its own single-line
  server cart: `POST /v1/shop/cart { items: [{ sku, quantity: 1 }] }` sent without credentials, so it belongs to no
  customer and no login merge can fold it into the shopper's cart. Its token lives only in the component (never the
  `sr_cart` cookie); the shopper's cart is never read or changed. A new variant gets a new buy-now cart; unused ones
  expire with the cart TTL. Confirmation, purchase analytics and the cart-retire check (which only retires the cookie's
  cart) are unchanged.

The express row offers Apple Pay, Google Pay, Link and Klarna (`paymentMethods` `auto`; PayPal and Amazon Pay `never`)
on every instance. Klarna in the Express Checkout Element uses the same shipping address / shipping rate events and
confirm flow as the wallets (Stripe documents no per-method shipping restriction), and Stripe declines a Klarna payment
confirmed at a different amount than pre-authorized, which `x-expected-amount` rules out. Link and Klarna must be
enabled in the Stripe dashboard; Klarna also needs the domain registered.

Every button uses the "Buy" call to action (`buttonType: { applePay: 'buy', googlePay: 'buy' }`).

## When the buttons show

All of these must hold, otherwise nothing renders:

- `/v1/shop/config` reports Stripe usable for the store's current mode (mode-matched secret + publishable key).
- The cart is non-empty and no order exists yet for this checkout view.
- The API returns an express quote for the page's destination country (shipping available, every line in stock).
- Stripe reports Apple Pay, Google Pay, Link or Klarna available on this device, browser and **domain**. Apple Pay needs the domain
  registered (below); Google Pay needs it for Elements as well.

## Per-store setup (ops)

For each store, once Stripe keys are saved, and again whenever a storefront domain is added:

1. Make sure the store's `storefrontUrl` and/or `hostnames` settings list every public domain the storefront is served
   on. A bare hostname entry (`example.com`) also registers `www.example.com`.
2. Admin → Settings → Payments → Stripe → **live** → "Register Apple Pay / Google Pay domains". Run it for **test** too
   if you test on a sandbox account (live registrations are also applied to sandboxes by Stripe).
   API equivalent: `POST /v1/admin/payments/settings/stripe/{mode}/payment-method-domains` (owner/manage role; agents
   are denied).
3. Read the result: each domain shows `created` / `updated` / `unchanged` / `failed` and its Apple Pay / Google Pay
   status. Re-running is safe: existing registrations are reused, re-enabled when disabled, re-validated when Apple Pay
   is not yet active; nothing is duplicated. Every run writes an `audit_log` row (`payment_method_domain_register`).
4. In the Stripe dashboard, Apple Pay and Google Pay must be enabled as payment methods (Settings → Payment methods).

No file needs to be hosted. With the PaymentMethodDomain API Stripe performs Apple Pay merchant validation itself; the
legacy `/.well-known/apple-developer-merchantid-domain-association` file is not used
(<https://docs.stripe.com/payments/payment-methods/pmd-registration>).

## How the money stays server-authoritative

1. `POST /v1/shop/cart/{token}/express-quote` (`{ country, shippingMethodCode?, couponCodes?, redeemPoints? }`) prices the
   cart's own lines for the wallet's destination country: live stock (sold out → 409 `OUT_OF_STOCK`), eligible shipping
   methods (none → 409 `SHIPPING_UNAVAILABLE`), destination tax, coupons, points. Its `cart.quoteHash` is the same hash
   `GET /v1/shop/cart/{token}` returns for that context. Called on page load, on every `shippingaddresschange` and
   `shippingratechange`; the wallet amount is set only from these responses.
2. On wallet confirm the storefront runs PLACE ORDER's own flow (checkout: `submitOrderFlow`; drawer and buy-now:
   `components/checkout/express-order.ts`): live cart read (the shopper's cart under the cart lock; a buy-now cart by its
   own token) that fails closed on any unavailable line, `POST /v1/shop/checkout` with `acceptedQuoteHash` = the wallet quote's hash (the server reprices and
   409s `QUOTE_CHANGED` on any difference; no order, no stock taken).
3. `POST /v1/shop/orders/{code}/payment-intent` carries `x-expected-amount` = the wallet total. The intent is always
   minted for the server's amount due; a different amount due mints nothing (409 `AMOUNT_MISMATCH`).
4. The wallet payment confirms that intent and redirects to the normal confirmation page, so `purchase` analytics and
   server conversions fire exactly as for a card payment (same order, same event ids). The webhook / `/payment/refresh`
   settlement is unchanged.

A refused wallet payment closes the sheet with a message. If the order was already created, the page stays on that
order with the normal payment form, so the shopper can still pay by card.
