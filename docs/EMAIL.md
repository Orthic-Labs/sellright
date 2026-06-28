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

Shared stores can route email by app. This is used by RightApps, where one
`rightapps` store sells multiple app brands.

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

