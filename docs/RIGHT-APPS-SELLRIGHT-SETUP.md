# Right Apps SellRight Setup

Right Apps should run as its own SellRight instance: its own database, Stripe
keys, webhook secret, admin, backups, and artifact storage. Inside that instance,
each app is a SellRight store:

- `viewright`
- `coderight`
- `heardright`
- `mailright`
- `scraperight`

Provision them with:

```bash
ADMIN_EMAIL=you@example.com pnpm --filter @sellright/api provision:right-apps
```

Use fresh Right Apps Stripe credentials on the API instance:

```env
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
STOREFRONT_URL=https://viewright.cc
```

Host the Right Apps admin at:

```txt
https://admin.spoares.com
```

That is cleaner than `spoares.com/admin` for the current admin SPA because the
admin frontend uses root-relative API calls like `/v1/admin/login`. With a
dedicated subdomain, nginx can serve the admin build at `/` and proxy `/v1/*`
to the Right Apps API without path rewriting. `spoares.com/admin` is possible
later, but it needs a SPA base path plus API rewrite rules.

Each Cloudflare Pages storefront build sets:

```env
VITE_SELLRIGHT_API_URL=https://api.rightapps.com
VITE_SELLRIGHT_STORE_SLUG=viewright
```

Use the matching slug for each app site. A same-origin Pages Function proxy can
also forward checkout/catalog `/v1/*` calls to `https://api.rightapps.com/v1/*`
and inject `x-store-slug`, avoiding browser CORS.

Software products are normal SellRight products whose variants carry:

- `fulfillmentType`: `license`, `digital_download`, or `update_pass`
- `appKey`: e.g. `viewright`
- `licenseSeats`: `1`, `3`, `5`, etc. for device/activation limits
- `updatesDurationDays`: e.g. `365`
- `licenseDurationDays`: `null` for perpetual

Plan variants can combine duration and device count, e.g.:

- `ViewRight Pro - 1 year - 1 device`: `licenseDurationDays=365`, `updatesDurationDays=365`, `licenseSeats=1`
- `ViewRight Pro - 3 years - 3 devices`: `licenseDurationDays=1095`, `updatesDurationDays=1095`, `licenseSeats=3`
- `ViewRight Pro - Lifetime - 5 devices`: `licenseDurationDays=null`, `updatesDurationDays=null`, `licenseSeats=5`

On payment settlement, SellRight issues entitlements from paid license,
digital-download, and update-pass order lines.

The desktop apps should use the app-native licensing facade:

```txt
POST /api/licenses/activate
GET  /releases/latest.json
```

Activation body:

```json
{
  "app": "viewright",
  "deviceId": "generated-device-id",
  "licenseKey": "VR-...",
  "version": "0.1.0"
}
```

Activation response:

```json
{
  "ok": true,
  "status": "active",
  "licenseId": "lic_...",
  "activationToken": "sr_act_...",
  "updatesUntil": null,
  "message": "Activated"
}
```

The app stores `activationToken` in OS secure storage and sends it for update
checks:

```txt
Authorization: Bearer sr_act_...
X-ViewRight-App: viewright
X-ViewRight-Device: generated-device-id
```

`/releases/latest.json` validates the activation token/device pair and returns
the raw Tauri updater manifest when the license is active and update-eligible.

SellRight also keeps generic internal API routes for tooling and non-Tauri
clients:

```txt
POST /v1/apps/:appKey/licenses/activate
GET  /v1/apps/:appKey/updates/latest
GET  /v1/apps/:appKey/downloads/:artifactKey
```

Admin creates update manifests and optional downloadable artifacts with:

```txt
POST /v1/admin/apps/releases
```
