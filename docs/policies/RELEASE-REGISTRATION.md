# Release registration policy host (defork plan 3.2)

The engine owns `POST /v1/admin/apps/releases` (`packages/api/src/releases/release-registration.ts`). Plugins customise it through `ApiPlugin.releaseRegistration` (`releases/registration-policy.ts`); they never mount this route themselves.

## Contract

Request body (zod, extra keys passed through to the hook): `{appKey, version, channel='stable', platform?: string|null, manifest, artifacts?: [{artifactKey, path, sha256?, sizeBytes?}], ...extra}`. Response `{id}`.

Order of evaluation:

1. **Authenticate.** If the bearer matches a registered policy's `serviceCredential.sha256` (sha256 of token, constant-time compare), the call is a service call: `x-store-slug` (default `serviceCredential.storeSlug`) must equal `storeSlug`, else 403 `release service token is restricted to <slug>`; the store is `storeSlug`. Otherwise an admin session is required (401), with store write access and the `releases` permission (403). A bearer that matches no credential is treated as a session token (so a wrong token is 401). A service credential never authenticates an admin session and an admin session never matches a credential.
2. **Claim and validate.** If no plugin registered a policy, any app is accepted (admin session only; engine default). If any policy exists, `apps` acts as an allow-list: the app must be claimed (a policy without `apps` is catch-all) else 400 `invalid release payload`. A service call may only publish apps claimed by the policy that owns its credential. `channels` (if set) must include `channel`. Then `validate(body, {storeId, auth})` runs; any throw gives 400 `invalid release payload`; its returned body is what is written and must keep the same `appKey`.
3. **Write, one transaction (`withStore`).** Upsert `app_release` on `(store_id, app_key, channel, platform, version)` setting `manifest`, `published_at = now`; then insert `download_artifact` rows. On an existing `(store_id, artifact_key)` the behaviour depends on the claiming policy's `repointArtifacts`: omitted/false (default, SellRight's historical `ON CONFLICT DO NOTHING`) keeps the existing row untouched; true upserts it, setting `app_release_id, path, sha256, size_bytes` (fork behaviour). Any failure rolls back both (500, nothing written). With `repointArtifacts` a duplicate `artifactKey` inside one request is such a failure (Postgres cannot affect a row twice).

Admin session and apps (fork behaviour, kept deliberately for parity): an admin session is bound to the admin's own store, not to a policy; any admin with the `releases` permission may publish a policy-claimed app into their own store. The `apps`/`channels` claims still apply to admin calls, but only the service credential is tenant-bound. A policy that needs more can enforce it in `validate` (it receives `{storeId, auth}`).

Same-version republish: identical to the fork. With `platform` non-null the existing row is updated in place (same id). With `platform: null` the table constraint (`app_release_unique`, no `NULLS NOT DISTINCT`) treats NULLs as distinct, so a second row is inserted (COMPAT C6 / 6.4). The engine does not change this; a plugin that wants to forbid null platform does so in `validate`.

## Startup conflicts

`createApp()` calls `assertNoReleaseRegistrationConflicts` before mounting and throws when: two plugins' policies claim the same app (a catch-all overlaps everything); two policies share a credential hash; a credential is not 64-hex or lacks `storeSlug`; a policy claims an empty `apps` list; a plugin mounts `POST /v1/admin/apps/releases`; or two plugins mount the same method+path (`ALL` middleware entries are ignored). Built-in routes may still be shadowed-by-order as before, except the host-owned release route. After every plugin `init(app)` has run, `assertHostRouteUnshadowed` also fails startup if the host route's route-table entry count changed (a plugin registered POST/ALL on it from `init()`).

## Fork mapping (for the plugin lane port of `release-routes.ts`)

| Fork (`rightsites-plugin/`) | Engine hook |
|---|---|
| `release-auth.ts` `requireReleaseServiceTokenStore`: `isReleaseServiceToken(auth, RELEASE_TOKEN_SHA256)`; slug `x-store-slug ?? RIGHTSITES_STORE_SLUG`; 403 `release service token is restricted to <slug>` | `serviceCredential: {sha256: <RELEASE_TOKEN_SHA256>, storeSlug: <RIGHTSITES_STORE_SLUG>}`; same status and text |
| `requireReleaseWriteStore` admin fallback (`requireAdmin`, `requireStore`, `requireWrite`, permission `releases`) | engine default path, unchanged |
| `validateReleaseRegistration(body, 'update', RIGHT_SUITE_APP_KEYS)` in try/catch, 400 `invalid release payload` | `apps: <app keys>` plus `repointArtifacts: true` (fork upserts `download_artifact`), `validate: (body) => validateReleaseRegistration(body, 'update', keys)` (returns the parsed body; it requires `platform` darwin/windows, `channel` `stable`, `artifactManifest`); `channels: ['stable']` is an optional early reject |
| `CreateReleaseIn` incl. `artifactManifest: z.unknown()` | engine schema is `.passthrough()`, so `artifactManifest` reaches `validate` |
| Upsert of `app_release` + `download_artifact` in `withStore` | engine transaction, same targets and `set` clauses; the artifact upsert needs `repointArtifacts: true` |
| Route registration of `POST /v1/admin/apps/releases` | **removed from the plugin** (would fail startup); `GET` feeds, patches and runtime-artifact routes stay plugin routes |
| `apps.ts` plain admin insert for that path | replaced by the host (now an upsert for admin sessions too) |

Behavioural deltas vs the fork when ported: none on the write path, provided `repointArtifacts: true`. Engine-only change vs old SellRight `apps.ts`: the `app_release` write is an upsert, so a same-version republish (platform non-null) updates manifest and `published_at` instead of failing with a unique violation. Artifact rows keep SellRight's `DO NOTHING` unless the policy opts in.

Not covered here (stay in the plugin): `POST /v1/admin/apps/patches`, runtime-artifact registration, update feeds.

## Tests

`packages/api/src/releases/release-registration.db.test.ts` (db project): both auth paths, wrong tenant, wrong token, invalid app/channel/hook rejection, cross-policy credential, republish with platform and null platform, artifact keep (default) and repoint (opt-in), trigger-forced partial-write rollback (also on republish), init()-registered route, startup conflicts.
