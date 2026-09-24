# Extending SellRight

SellRight is the generic commerce product; a downstream fork (e.g. RightSites)
owns its own routes, tables, env vars, and host mapping. This document lists
every extension seam in `packages/api` that lets a fork add those WITHOUT
editing SellRight source — `app.ts`, `env.ts`, `store-context.ts`,
`schema-*.ts`, and `email/mailer.ts` stay untouched.

Every seam below defaults to SellRight's own prior behavior exactly — an
unconfigured checkout is unchanged.

## 1. Extra routes: `registerApiPlugin` (`src/plugins.ts`)

Register a Hono/OpenAPIHono sub-app and an optional init hook from your own
entrypoint, before calling `createApp()`.

```ts
// your-fork/src/index.ts
import { OpenAPIHono } from '@hono/zod-openapi';
import { registerApiPlugin } from '@sellright/api/src/plugins.js';
import { createApp } from '@sellright/api/src/app.js';

const myRoutes = new OpenAPIHono();
myRoutes.get('/v1/my-app/ping', (c) => c.json({ ok: true }));

registerApiPlugin({
  name: 'my-app',
  routes: myRoutes,
  init: (app) => { /* e.g. app.use(...) for a plugin-only middleware */ },
});

const app = createApp(); // mounts myRoutes AFTER every built-in route, then runs init
```

## 2. Extra tables: `src/db/extensions/` (`drizzle.config.ts`)

Drop your own Drizzle `pgTable(...)` module under `src/db/extensions/` — the
`schema` array in `drizzle.config.ts` globs `src/db/extensions/**/*.ts`
alongside `src/db/schema.ts`, so `pnpm db:generate` picks it up automatically.

```ts
// src/db/extensions/schema-myapp.ts
import { pgTable, uuid, text } from 'drizzle-orm/pg-core';
import { store, ts } from '../schema-core.js';

export const myappWidget = pgTable('myapp_widget', {
  id: uuid().primaryKey().defaultRandom(),
  storeId: uuid().notNull().references(() => store.id),
  name: text().notNull(),
  createdAt: ts(),
});
```

Import it directly from your own route files (`../db/extensions/schema-myapp.js`)
— it is not auto-added to the shared `s.*` namespace exported by `schema.ts`.

## 3. Extra env vars: `extendEnv` (`src/env.ts`)

```ts
import { extendEnv } from '../env.js';
import { z } from 'zod';

export const myEnv = extendEnv(
  {
    MY_APP_FEATURE_FLAG: z.enum(['0', '1']).default('0'),
    MY_APP_WEBHOOK_SECRET: z.string().optional(),
  },
  (merged) => {
    // optional boot-time validator; return an array of error strings to abort boot
    if (merged.NODE_ENV === 'production' && !merged.MY_APP_WEBHOOK_SECRET) {
      return ['MY_APP_WEBHOOK_SECRET must be set in production'];
    }
  },
);

myEnv.MY_APP_FEATURE_FLAG; // '0' | '1'
myEnv.NODE_ENV; // SellRight's own env fields are still present
```

## 4. Many hosts → one store, with prefix stripping (`store-context.ts`)

`store.config.hostnames` already maps several unrelated hostnames to one
store row. `STORE_HOST_STRIP_PREFIXES` additionally strips a configurable
leading label (e.g. `www.`, `buy.`, `get.`, `store.`) before matching, so one
registered hostname also matches its purchase-flow subdomains:

```bash
STORE_HOST_STRIP_PREFIXES=www,buy,get,store
```

```json
// store.config
{ "hostnames": ["myapp.example"] }
```

`buy.myapp.example` and `get.myapp.example` now resolve to the same store.
Unset (default): no stripping, identical to today.

## 5. Dev/CI default store (`store-context.ts`)

```bash
DEV_DEFAULT_STORE_SLUG=myapp
```

Only affects non-production fallback resolution. Unset (default): `damned`,
identical to today.

## 6. Forbidden sender domains (`email/sender-policy.ts`)

```bash
FORBIDDEN_SENDER_DOMAINS=damneddesigns.com,otherbrand.com
```

Checked once at boot (`env.ts`, against `SMTP_FROM`/`FROM_EMAIL`/
`EMAIL_FROM_BY_APP`) and again on every send (`email/mailer.ts`), via the same
`isForbiddenSenderDomain` matcher. Unset (default, empty list): enforces
nothing.

```ts
import { isForbiddenSenderDomain } from '../email/sender-policy.js';
isForbiddenSenderDomain('info@damneddesigns.com', ['damneddesigns.com']); // true
```

## 7. Configurable app/device headers + fallback store (`routes/apps.ts`)

```bash
APPS_APP_KEY_HEADERS=x-myapp-app,x-app-key
APPS_DEVICE_HEADER=x-myapp-device
APPS_LICENSE_HEADER=x-myapp-license
APPS_FALLBACK_STORE_SLUG=myapp-consolidated
```

- `APPS_APP_KEY_HEADERS` / `APPS_DEVICE_HEADER` / `APPS_LICENSE_HEADER`
  default to SellRight's historical literal header names
  (`x-viewright-app,x-app-key`, `x-viewright-device`, `x-viewright-license`).
- `APPS_FALLBACK_STORE_SLUG` (unset by default) lets a consolidated
  multi-tenant deployment resolve every unknown app key to one shared store
  (`licensing/app-store-fallback.ts`) instead of 404ing.

```ts
import { appKeyHeaderNames, firstHeader } from '../licensing/app-headers.js';
firstHeader(c, appKeyHeaderNames()); // reads whichever header(s) you configured
```

## 8. Entitlements provider seam (`licensing/entitlement-provider.ts`)

The four public license lifecycle routes in `routes/apps.ts` —
`POST /api/licenses/activate`, `/api/licenses/refresh`,
`/api/licenses/deactivate`, `/api/licenses/trial` (each also served at the
matching `/v1/licenses/...` path) — call an optional, registered
`EntitlementProvider`'s hook INSIDE the same store-scoped transaction as the
route's own DB work. A hook can:

- **add fields** to the route's JSON response (e.g. a signed offline
  entitlement token, richer lifecycle metadata) by returning an object; or
- **veto** the request by throwing `EntitlementVeto(httpStatus, code, message)`
  — the veto (like any other error a hook throws) propagates out of the
  route's `withStore(...)` callback UNCAUGHT, so the transaction rolls back
  everything the route did (activation upsert, freshly-minted trial license,
  find-or-create customer, ...) before it becomes an HTTP response.

Nothing registered (the default) means every route's response is byte-for-byte
what it was before this seam existed.

```ts
// your-fork/src/index.ts — before createApp()
import { registerEntitlementProvider, EntitlementVeto } from '@sellright/api/src/licensing/entitlement-provider.js';

registerEntitlementProvider({
  async onActivate(tx, ctx) {
    // ctx: { storeId, appKey, license, activationId, activationToken, deviceId, now }
    const token = signMyEntitlementToken(ctx.license, ctx.deviceId);
    if (!token) throw new EntitlementVeto(503, 'signing_unavailable', 'License signing is temporarily unavailable.');
    return { signedToken: token };
  },
  async onRefresh(tx, ctx) { /* ctx: { ..., license, activationId, deviceId, now } */ },
  async onDeactivate(tx, ctx) { /* ctx: { storeId, appKey, activationToken } */ },
  async onTrial(tx, ctx) { /* ctx: { storeId, appKey, email, licenseKey, customerId, outcome } */ },
});
```

A route body ALWAYS calls the hook via `callEntitlementHook(hook, tx, ctx)`
(a no-op returning `null` when no hook is registered) and never catches what
it throws inside the transaction — only the outer `withEntitlementVeto(c, fn)`
wrapper, OUTSIDE `withStore(...)`, catches `EntitlementVeto` and turns it into
`{ ok: false, status: code, message }` at `httpStatus`. Any other error the
hook throws rethrows to the app's generic, sanitizing error handler — never
echoed to the client, never a partial commit either way.

**Mapping a consumer's inline entitlement-signing logic onto the hooks** (the
shape this seam was built to replace — a fork's own copy of `routes/apps.ts`
with signed-token issuance inlined into each route):

| Consumer's inline logic | Becomes |
|---|---|
| Building the versioned entitlement contract (`buildEntitlements`) + planning the offline lifecycle (`planLicenseLifecycle`) + calling `signEntitlement(...)` after a successful device activation, adding `signedToken`/`entitlements`/`validUntil`/`licenseKind`/... to the activate response | `onActivate` hook: read `ctx.license`, compute the same fields, `return {...}` them |
| The same signing/lifecycle logic re-run on `/licenses/refresh`, keyed off the re-validated activation | `onRefresh` hook |
| `recordCanonicalEntitlementIssuance(tx, {...})` called right after a signed token is minted, inside the same transaction | The hook's own `tx` work inside `onActivate`/`onRefresh` — call it there instead of after; a later throw in the SAME hook now correctly rolls it back too (the inline fork version had no such rollback) |
| `503 signing_unavailable` / `400 device_id_required` responses when signing fails or a required field is missing | `throw new EntitlementVeto(503, 'signing_unavailable', ...)` / `throw new EntitlementVeto(400, 'device_id_required', ...)` |
| Nothing today on `/licenses/deactivate` (the fork's version is a plain passthrough to `deactivateDevice`) | `onDeactivate` is available for future use (e.g. revoking a cached signed token) but doesn't need a hook body yet |
| `withCurrentDevicePolicy` / pooled-seat overrides in the trial route | **Not** part of this seam — that's the existing `registerDevicePolicy` seam (`licensing/device-policy.ts`); leave those calls where they are |

Once the fork's `routes/apps.ts` fork is replaced by this provider, the fork
no longer needs its own copy of `routes/apps.ts` at all — it can depend on
SellRight's routes directly and just register the provider.
