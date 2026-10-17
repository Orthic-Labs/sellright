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
`SMTP_ENABLED=false` to turn off the env-configured SMTP transport for demos or
load tests.

When `SMTP_HOST` is not set, the mailer uses the SMTP settings saved for the
store on the admin Email settings page. When `SMTP_HOST` is set, it always wins
and the admin page is read-only. The Compose deployment passes only `SMTP_HOST`,
`SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` and `SMTP_FROM` from `deploy/.env` to the
API (`deploy/compose.yaml`); `SMTP_ENABLED`, the Gmail aliases and the per-app
variables below are not forwarded there.

## Vendure Gmail Aliases

SellRight also understands the Gmail env names used by the older Vendure
stores:

```env
GMAIL_USER=sender@example.com
EMAIL_PASS=app-password
FROM_EMAIL=sender@example.com
```

When `SMTP_*` values are empty, `GMAIL_USER` + `EMAIL_PASS` automatically map to
`smtp.gmail.com:587`. `SMTP_FROM` falls back to `FROM_EMAIL`, then `GMAIL_USER`,
then `noreply@sellright.local`.

## Per-App Sender Routing

Shared stores can route email by app. This is meant for one store that sells
several app brands (see `EMAIL_FROM_BY_APP` in `packages/api/src/env.ts`).

```env
EMAIL_FROM_BY_APP=appkey=hello@app.example,otherapp=hello@other.example
STOREFRONT_URL_BY_APP=appkey=https://app.example,otherapp=https://other.example
```

Order confirmation, refund and order-edit emails derive the app key from the
purchased product variants' `product_variant.app_key`. If all order lines belong
to one app, the email uses that app's sender and storefront URL. If an order
mixes apps or no app key is available, SellRight falls back to the store's own
`emailFrom` (or `fromEmail`) and `storefrontUrl` settings, then to `SMTP_FROM`
and `STOREFRONT_URL`.

Keep the mapped sender addresses configured as allowed Gmail/Workspace senders;
otherwise Gmail may reject or rewrite the visible `From` (unverified: Gmail
behavior cannot be checked from this repository).

