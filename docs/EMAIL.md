# Email Delivery

SellRight sends transactional email through `packages/api/src/email/mailer.ts`.
The mailer uses Nodemailer SMTP and no-ops with a log line when SMTP is not
configured.

## Base SMTP

Configure the API in `packages/api/.env`:

```env
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=sender@example.com
SMTP_PASS=app-password
SMTP_FROM=sender@example.com
SMTP_ENABLED=true
STOREFRONT_URL=https://store.example.com
```

`SMTP_ENABLED` may be omitted; email auto-enables when `SMTP_HOST` is set. Set
`SMTP_ENABLED=false` to force the no-op path for demos or load tests.

## Vendure Gmail Aliases

SellRight also understands the Gmail env names used by the older Vendure
stores:

```env
GMAIL_USER=sender@example.com
EMAIL_PASS=app-password
FROM_EMAIL=sender@example.com
```

When `SMTP_*` values are empty, `GMAIL_USER` + `EMAIL_PASS` automatically map to
`smtp.gmail.com:587`.

## Per-App Sender Routing

Shared stores can route email by app. This is used by RightSites, where one
`rightsites` store sells multiple app brands.

```env
EMAIL_FROM_BY_APP=appkey=hello@app.example,otherapp=hello@other.example
STOREFRONT_URL_BY_APP=appkey=https://app.example,otherapp=https://other.example
```

Checkout derives the app key from the purchased product variants'
`product_variant.app_key`. If all order lines belong to one app, confirmation
email uses that app's sender and storefront URL. If a cart mixes apps or no app
key is available, SellRight falls back to `SMTP_FROM` and `STOREFRONT_URL`.

Keep the mapped sender addresses configured as allowed Gmail/Workspace senders;
otherwise Gmail may reject or rewrite the visible `From`.


## Abandoned-cart recovery email

Job `abandoned-cart-recovery` (`packages/api/src/jobs/abandoned-cart-recovery.ts`, every 15 minutes, leader-locked) sends **one** `cart_recovery` email per abandoned cart through `email_outbox`.

| Setting | Default | Effect |
|---|---|---|
| `CART_RECOVERY_DELAY_HOURS` | `2` | Hours after a cart is flagged abandoned (`CART_ABANDON_HOURS`, default 4, measured from last activity) before the reminder is enqueued. `0` disables the job. Keep it below `CART_RETENTION_DAYS * 24` (default 24), otherwise the cart is purged before it is eligible. |
| `store.config.marketing.cartRecovery` | enabled | Set to `false` to opt a store out. |

Eligible carts: status `abandoned`, non-empty, email captured, not converted, `recovery_emailed_at IS NULL` (migration 0108), abandoned for at least the delay and no more than 7 days, and the address has no `unsubscribed` subscriber row. The cart is stamped `recovery_emailed_at` in the same transaction as the outbox insert, so a cart is never mailed twice.

The email's button is a signed link, `GET /v1/shop/cart/recover/{cartId}?exp&sig` (HMAC-SHA256 over store, cart and expiry; 7-day lifetime; secret chain `CONTACT_FORM_SECRET`, `LICENSING_HMAC_SECRET`, `COOKIE_SECRET`, `DOWNLOAD_URL_SECRET`). It carries the internal cart id, never the cart token. A valid link redirects to the storefront page `/cart/recover/#t=<token>` (token in the fragment), which sets the `sr_cart` cookie and continues to `/checkout/`. Invalid signature returns 403, expired returns 410, and a converted, merged or purged cart redirects to the store home.
