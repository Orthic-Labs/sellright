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
