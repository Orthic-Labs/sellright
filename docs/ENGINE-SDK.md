# Engine SDK (`@sellright/api`)

Status: implemented on branch `feat/defork-engine-sdk` (plan v14, Phase 2 items 2.1-2.7). The module dispositions below come from the 0.1 symbol graph (`import-graph.json`, upstream `82d53dc`, fork `fc8715e8`: 35 modules, 86 symbols) and the draft `IMPORT-DISPOSITION.md`; they are still a **proposal pending owner approval** (the contract is data: `packages/api/exports/contract.json`).

## 1. `createApp` (2.1)

```ts
import { createApp } from '@sellright/api';
const engine = await createApp({ plugins, env, migrationsTable });
await engine.start({ handleSignals: true });   // listen + jobs
await engine.shutdown();
```

| option | meaning |
|---|---|
| `plugins` | `EnginePlugin[]` (hook order below). |
| `env` | environment source, default `process.env`. Parsed and validated **inside** `createApp` (`KEY_FILE` secrets resolved, production gates, sender policy). |
| `migrationsTable` | engine-track journal table (`string` or `{schema, table}`), default `drizzle.__drizzle_migrations`. |
| `migrations` | `'verify'` (default) or `'skip'`. The serving role never applies DDL. |
| `migrationsDir` | engine drizzle folder, default the one packaged with the artifact. |
| `allowPrivilegedRuntimeRole` | test-only override of the privilege check; refused unless `NODE_ENV=test`. |

Lifecycle (fixed order; `engine.executedPhases` records it):

`configure -> preRoute -> routes -> schema -> migrations -> services` run inside `createApp`; `jobs` runs in `start()`; `shutdown` in `shutdown()`.

| phase | plugin hook | notes |
|---|---|---|
| configure | `configure(ctx)` | `ctx.extendEnv(shape, validate)` parses plugin variables from the same resolved source. The only place env may be extended. |
| preRoute | `preRoute(app, ctx)` | middleware / response policies. After request-id + access log, before CORS and every route (the legacy-error-shape policy of C.1 goes here). |
| routes | `routes` (app or `(ctx) => app`) | mounted at `/` after every built-in route (never shadows an exact built-in path). |
| schema | `schema` (tables or `(ctx) => tables`) | table names (`schema.name`) must not collide with the engine's or another plugin's (`SCHEMA_COLLISION`). |
| migrations | `migrations: {folder, table?, schema?}` | each track's journal is **verified**; any unapplied entry stops boot (`PendingMigrationsError`). Applying is the migrate step (section 4). |
| services | `services(ctx)` | register entitlement providers, tier catalogs, device policies here, never by import side effect. |
| jobs | `jobs(ctx) -> PluginJob[]` | interval jobs, leader-locked as `plugin:<plugin>:<job>`; run only when `JOBS_ENABLED=1` (same gate as engine jobs). |
| shutdown | `shutdown(ctx)` | after HTTP drained, before the pool closes; reverse plugin order; failures are logged, never block the pool close. |

`EngineContext` (`ctx`) carries `env` (read-only), `pool` (runtime role), `log`, `logError`, `fingerprint`, `engineVersion`, `pluginNames`. Plugins never import `env` or the pool as module singletons.

**Shutdown order** (`engine.shutdownSteps`): `stop-admitting` (new requests get 503 `SHUTTING_DOWN`, `Connection: close`) -> `cancel-jobs` (scheduler timers cleared, in-flight passes awaited, LISTEN connection released) -> `drain-http` (`server.close`; connections still open after the timeout are force-closed) -> `plugin-shutdown` -> `close-resources` (engine-owned extra pools) -> `close-pool`. Signal path (`handleSignals`): SIGTERM/SIGINT run `shutdown`, then `process.exit(0)`; a watchdog `exit(1)` fires at `shutdownTimeoutMs` (default 10 s); a second signal during shutdown is ignored.

**One engine per process.** A second `createApp` before `shutdown()` is refused (`ENGINE_ACTIVE`). `createApp` is also refused (`RUNTIME_PREINITIALISED`) if any module touched `env` or the pool before it ran.

### How "env parsed and pool created inside createApp" is achieved
`env`, `pool` and `unsafeUnscopedDb` remain importable names (130 modules use them) but are lazy views over a holder initialised by `createApp` (`initEnv` / `initPools`). Importing a module opens no connection and reads no env: `src/sdk/import-purity.test.ts` imports every engine module and asserts neither exists afterwards. Code that never calls `createApp` (operator scripts, the test runner, `buildHttpApp()`) gets an implicit initialisation from `process.env` on first use, exactly as before. Import-time reads that had to become lazy: `store-context` (`DEV_DEFAULT_STORE` -> `devDefaultStore()`), `auth/cookies` (`CUSTOMER_COOKIE_MAX_AGE_SECONDS` -> `customerCookieMaxAgeSeconds()`), `email/mailer`, `licensing/sign`, `routes/contact`, `payments/tenant-resolution` (its own pool, now lazy and registered for close), `lib/logger`.

`src/index.ts` is a thin caller (`createApp({ migrations: 'skip' })`, `start({ handleSignals: true })`). Plugins registered with the legacy `registerApiPlugin` still mount (`plugins.ts` is deprecated, not exported). The Hono builder is `buildHttpApp()` in `app.ts`; `createApp` there remains as a deprecated alias so existing tests are unchanged. The old index-level `shutdown.test.ts` is replaced by `src/sdk/signals.db.test.ts`.

## 2. Exports contract (2.2)

`package.json` `exports` publishes: `.` (SDK), `./db`, `./schema`, `./auth`, `./http`, `./log`, `./licensing`, `./storekit`, `./ops`, `./exports/contract.json`, `./package.json`. Everything else (`dist/**`, `src/**`) fails Node resolution with `ERR_PACKAGE_PATH_NOT_EXPORTED`. Each barrel is `src/exports/<surface>.ts`; the contract test (`src/sdk/exports-contract.test.ts`) asserts every `public` symbol is exported from its surface, no `moved`/`replaced` symbol is exported anywhere, and the barrels export nothing beyond the contract.

Decisions (public / moved / replaced per module; totals 68 public, 3 moved, 15 replaced of 86):

| module | surface | public | moved (plugin-owned) | replaced |
|---|---|---|---|---|
| `auth/cookies` | /auth | `customerCsrfValid` | - | - |
| `auth/email` | /auth | `normalizeEmail` | - | - |
| `auth/rate-limit` | /auth | `clientIp` | - | - |
| `auth/session` | /auth | `customerToken`, `resolveCustomer` | - | - |
| `db/client` | /db | `Tx`, `withStore` | - | `pool`, `unsafeUnscopedDb` |
| `db/schema` | /schema | `schema` | - | - |
| `db/schema-core` | /schema | `store`, `ts` | - | - |
| `db/schema-orders` | /schema | `license` | - | - |
| `env` | - | - | - | `env`, `extendEnv` |
| `lib/logger` | /log | `err`, `log` | - | - |
| `licensing/activations` | /licensing | `findActivationByToken`, `recordCanonicalEntitlementIssuance` | - | - |
| `licensing/app-headers` | /licensing | `appKeyHeaderNames`, `deviceHeaderName`, `firstHeader` | - | - |
| `licensing/device-leases` | /licensing | `LeaseEnvelope`, `Platform`, `issueDeviceLease`, `removeDeviceOffline`, `renewDeviceLease`, `revokeDeviceRemote` | - | - |
| `licensing/device-policy` | /licensing | `registerDevicePolicy` | - | `derivePool`, `usesBoundedDevicePools`, `withCurrentDevicePolicy` |
| `licensing/entitlement-provider` | /licensing | `ActivateEntitlementContext`, `EntitlementFields`, `EntitlementVeto`, `RefreshEntitlementContext`, `registerEntitlementProvider` | - | `withEntitlementVeto` |
| `licensing/entitlements` | /licensing | `buildEntitlements`, `canReceiveTieredUpdate`, `registerTierCatalog`, `resolveAuthorizationTier` | - | - |
| `licensing/issue` | /licensing | `newLicenseKey` | - | - |
| `licensing/license-lifecycle` | /licensing | `planLicenseLifecycle` | - | - |
| `licensing/mint` | /licensing | `mintLicense` | - | - |
| `licensing/release-auth` | - | - | - | `isReleaseServiceToken` |
| `licensing/runtime-artifact-manifest` | /licensing | `createRuntimeArtifactManifestTools` | `RuntimeArtifactId` | - |
| `licensing/sign` | /licensing | `SignedPayload`, `signEntitlement`, `signLeaseEnvelope`, `verifyToken` | - | - |
| `licensing/storekit-config` | /storekit | `deploymentConfigFor`, `loadStoreKitAppConfig` | - | - |
| `licensing/storekit-license` | /storekit | `ensureStoreKitLicense`, `isSandboxStoreKitLicense` | - | - |
| `licensing/storekit-verify` | /storekit | `verifyStoreKitTransactionForDeployment` | - | - |
| `licensing/tokens` | /licensing | `bearerToken`, `hashActivationToken` | - | - |
| `licensing/trial` | - | - | `TrialPlatform`, `trialDaysForPlatform` | `TRIAL_DAYS`, `trialExpiresAt` |
| `licensing/update-tier` | /licensing | `PUBLIC_PATCH_CHANNELS`, `isPatchChannel`, `normalizeReleasePlatform`, `parsePatchRelease`, `patchChannel`, `validateReleaseRegistration` | - | - |
| `plugins` | - | - | - | `registerApiPlugin` |
| `routes/admin-helpers` | /http | `HttpError`, `J`, `errBody`, `guard`, `requireAdmin`, `requirePermission`, `requireStore`, `requireWrite` | - | - |
| `routes/apps` | /http | `publicAppStore` | - | - |
| `routes/apps.limit` | /http | `makeKeyedLimiter` | - | - |
| `routes/shop-config` | - | - | - | `shopConfig` |
| `routes/store-context` | /http | `resolveStoreFromCtx` | - | - |
| `store-context` | /http | `StoreCtx`, `resolveStore` | - | `DEV_DEFAULT_STORE`, `resolveStoreForRequest` |

Open questions from the draft, as implemented (all reversible by editing the barrels + `contract.json`): (1) subpath groups, not one flat entry; (2) the pool reaches plugins as `ctx.pool`, `pool`/`unsafeUnscopedDb` are not exported; operator scripts use `createOwnerDb(url)` from `/ops` (no ambient credential); (3) `registerDevicePolicy`, `registerEntitlementProvider`, `registerTierCatalog` stay public functions, called from the `services` phase; (4) `newLicenseKey` is exported (conditional on 3.5); (5) the single-instance assertion also covers `@hono/zod-openapi` (the three required: `@sellright/api`, `drizzle-orm`, `pg`). `publicAppStore` and `makeKeyedLimiter` only gained the `export` keyword upstream; `RuntimeArtifactId`, `TrialPlatform`, `trialDaysForPlatform` are *moved* (not exported) per the coordinator.

Regenerate the contract: `node packages/api/scripts/gen-exports-contract.mjs <IMPORT-DISPOSITION.md>`.

**Deep-import gate.** `exports-contract.test.ts` scans every workspace package other than `api` for `@sellright/api/...` specifiers not in the exports map (with negative fixtures); the packed test proves Node itself rejects `@sellright/api/dist/...`.

## 3. Artifacts (2.3)

`pnpm --filter @sellright/api build` writes `dist/` and `BUILD-INFO.json` (`{sha, dirty, time, node}`; no file when not a git checkout, never a guessed value). `pnpm pack` produces a tarball with `dist` (compiled tests excluded), `drizzle`, `exports` (`contract.json`) and `BUILD-INFO.json`. The sample plugin pins `@sellright/api` as an **exact** peer (`0.1.0`) with `drizzle-orm`, `pg`, `@hono/zod-openapi`, `zod` as ranges.

`packages/sample-plugin` imports only public subpaths. Its test (`pnpm test:sdk-packed`) builds and packs both packages, installs the tarballs into a clean temp directory with the committed lockfile fixture `packages/sample-plugin/test/fixtures/consumer.pnpm-lock.yaml` (`--frozen-lockfile`; regenerate with `SDK_REGEN_CONSUMER_LOCK=1`), runs `boot.mjs` there against `defork_sdk_test` and asserts: single resolved instance of `@sellright/api`, `drizzle-orm`, `pg`, `@hono/zod-openapi`; deep imports fail with `ERR_PACKAGE_PATH_NOT_EXPORTED`; artifact contents; migrate step (engine then plugin track); privileged role rejected; composed boot (phases, plugin routes, preRoute header, env extension, plugin table); route inventory; shutdown order. `scripts/build-sdk-artifacts.sh` produces `artifacts/sdk/` (engine tgz, sample-plugin tgz, admin bundle tgz whose `dist/BUILD-INFO.json` is written by `write-build-info.mjs`). `deploy/sdk/Dockerfile` builds the composed image from those packed tarballs only (`deploy/sdk/composed/`: `server.mjs` runs `createApp`, `migrate.mjs` is the owner-credential release step). The image is not built or run in this change: the host's docker needs sudo (*unverified*).

## 4. Privilege check and migrations (2.6)

`createApp` runs `assertRuntimeRoleUnprivileged(pool)` before any plugin hook: the runtime role must be `NOSUPERUSER` and `NOBYPASSRLS` (SR-01), otherwise boot fails and the pool is closed. This replaces the old argv-sniffing check in `db/client.ts` (which ran only for `index.*`). The migrator credential is separate: `runMigrations({ databaseUrl: <owner>, plugins })` from `@sellright/api/ops` applies the engine track, then each plugin track in plugin order, each in its own journal table (`drizzle.__drizzle_migrations` for the engine; plugins default to `drizzle.__drizzle_migrations_<name>`; sharing a table is an error). The runtime role needs `SELECT` on the journal tables for `verify` (unverified against the production role grants; `migrations: 'skip'` is the documented fallback and what `index.ts` uses to keep today's behaviour).

## 5. Read-only system endpoints (2.7)

Both require installation-administrator authority (`is_installation_admin`, the only such account per install) AND the per-store `owner` role on the `x-store-slug` store (admin session); 401 / 403 otherwise. Owning another store of the same install never grants access (review F1; `admin-system-info.db.test.ts`).

- `GET /v1/admin/system/build-info`: engine name/version, `BUILD-INFO.json` (or `null`), node version, sha256 of `drizzle/meta/_journal.json` and its head tag, plugin names.
- `GET /v1/admin/system/effective-config`: `schema: "config/v1"`, `store.slug`, and two sections.
  - `intended` (must be equal old vs new): `storeConfig` (`hostnames`, `legalManifests` as sha256 of canonical JSON per app, `auth` flags, a content fingerprint of the whole config), non-secret `env` values, `secrets`, `plugins.<name>` (plugin contributions).
  - `deployment` (compared against an approved old/new table): `build`, process pid/start, bound and configured port, host, paths (asset, download, maintenance flag, catalog), `database` (host, port, name, role; never the password), provider mode and account ids (Stripe mode and key mode prefixes, NMI/Sezzle mode and `paymentAccounts` ids), job state (enabled, names, maintenance flag), migration tables, plugin names and contributions.
  - Secrets appear **only** as fingerprints (`sdk/fingerprint.ts`): public-key sha256 for the licence signing key; salted HMAC (`HMAC-SHA256(key = installation salt, message = "sellright/config/v1:<NAME>" + NUL + secret)`, 16 hex) for symmetric secrets; `sha256` prefix (12 hex) for bearer credentials. Plugins add theirs through `effectiveConfig(ctx)` using `ctx.fingerprint` (the RightSites release credential and runtime-artifact public key belong there). The HMAC key is a per-installation random salt (32 bytes, `installation_setting.config_fingerprint_salt`, created once; review F3), never a secret.

## 6. Route inventory (2.5)

`routeInventory(app)` lists every concrete method+path registered (including `.get()`, `.on()` multi-method and path-param routes, normalised to `{id}`), middleware paths, and which routes are absent from `/v1/openapi.json`. `src/sdk/create-app.db.test.ts` compares the composed engine with `src/sdk/route-inventory.golden.json` (regenerate with `UPDATE_ROUTE_GOLDEN=1`), asserts no OpenAPI operation lacks a route, and checks a plugin's `.get()`/`.on()` routes appear as undocumented. Legacy-shape routes (plan 2.5): `legacyErrorShape()` (scoped by the plugin's `preRoute` to `/v1/sample/*`) and `legacyErrorResponses()` + `x-legacy-error-shape` document real examples; the packed smoke asserts `legacyExampleViolations(doc)` is empty and the live 409 body equals the documented example.

## 7. Test commands

```
pnpm --filter @sellright/api typecheck
DATABASE_URL=postgres://sellright@127.0.0.1:5433/defork_sdk_test pnpm --filter @sellright/api test       # unit project
DATABASE_URL=...defork_sdk_test pnpm --filter @sellright/api test:db                                   # db project
DATABASE_URL=...defork_sdk_test pnpm test:sdk-packed                                                    # packed-artifact gate (needs network for the clean install)
```
