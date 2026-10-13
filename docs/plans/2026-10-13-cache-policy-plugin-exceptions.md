# Cache policy: plugin-registered cacheable exceptions (2026-10-13)

Problem: `cachePolicy()` (packages/api/src/cache-policy.ts) rewrites every response to `private, no-store` unless the path is on the static `CACHEABLE_EXCEPTIONS` list, so the packed engine overwrites the RightSites plugin's frozen release-feed headers (docs/defork/COMPAT.md C6, C7). `/v1/pro/revocations` is already on the static list; the release feeds are not.

## Engine API (final)

- SDK plugins (what the packed engine consumes): `EnginePlugin.cacheableExceptions?: readonly CacheableException[]`. `CacheableException` is exported as a type from the package entry (`@sellright/api`). `buildHttpApp` validates and applies the entries per app instance during `createApp()`; startup throws on any invalid entry. Nothing is global, so rebuilding an app does not trip a duplicate error.
- Legacy `ApiPlugin.cacheableExceptions` (applied by `registerApiPlugin`) and `registerCacheableExceptions(entries)` remain for in-repo/legacy callers; neither is exported from the package entry (`registerApiPlugin` is `replaced` in exports/contract.json).
- Entry: `{ path: string | RegExp, source, reason }`. `source` and `reason` must be non-empty. String paths start with `/`; RegExp paths are anchored `^...$` and must not use the `g` or `y` flag.
- Registration throws on: duplicate or overlap with the static list, an earlier registration (global or another SDK plugin) or the same batch (string/regex checked in both directions; two regexes only by identical source+flags); hard-denied paths; RegExps that match any denied probe path. All-or-nothing.
- Hard deny policy (`isDeniedCachePath`): everything under `/v1/shop/` and `/v1/checkout`, `/v1/openapi.json`, and any path segment naming stock, inventory, availability, price(s), product(s), catalog, cart, checkout, feed(s), collection(s), jsonld, admin, account, auth, order(s), customer(s), session(s), me. Compared on the raw and the decoded, lower-cased, slash-collapsed path.
- Runtime enforcement: the same deny policy is applied to the actual request path before any plugin-registered exception is honoured, so a loose RegExp cannot cache a protected route. Static entries are exempt (reviewed in cache-policy.ts).
- Additional deny entries: any `latest` segment (`/releases/latest.json`, `/v1/apps/x/updates/latest`, `/v1/apps/x/releases/latest.json`: licensed update manifests) and everything under `/v1/apps/x/updates/`.
- Registered (plugin) exceptions are stricter than static ones at request time: (a) honoured only when the handler ITSELF set a cacheable Cache-Control (explicit `public` / `s-maxage` / `max-age>0`, none of `no-store` / `no-cache` / `private`); a response with no Cache-Control, e.g. an authenticated licence check, gets `private, no-store`; (b) never honoured when the request carries a credential: `Authorization`, `Proxy-Authorization`, `Cookie`, `X-API-Key`, `X-ViewRight-License`, `X-Activation-Token`, or the header named by `APPS_LICENSE_HEADER` (app-identifier headers such as `X-ViewRight-App` are not credentials). Static entries keep their previous behaviour.
- Kept only on 200 GET/HEAD; POST/other methods and non-200 stay `private, no-store`; `cache-tag` always stripped. Static list and existing behaviour unchanged.

## Call the RightSites plugin must make (rs-int, NOT edited here)

On the RightSites `EnginePlugin` object (the same object that carries `routes` and `releaseRegistration`) add:

```ts
cacheableExceptions: [
  {
    path: /^\/v1\/apps\/[A-Za-z0-9_-]+\/releases\/status\.json$/,
    source: 'rightsites-plugin/release-routes.ts',
    reason: 'public release status: latest published patch/update version numbers per app; no stock, no visitor state; frozen 300s wire contract for shipped clients',
  },
  {
    path: '/releases/patches.json',
    source: 'rightsites-plugin/release-routes.ts',
    reason: 'signed security-patch manifest for the header-derived app; no stock, no visitor state; frozen 300s wire contract for shipped clients',
  },
],
```

Header values to keep (already set by the plugin; frozen in COMPAT.md C6; the engine now REQUIRES the handler to set them: it will not add one):

| Path | Cache-Control | Plugin line |
|---|---|---|
| `/v1/apps/:appKey/releases/status.json` | `public, max-age=300` | release-routes.ts:102 |
| `/releases/patches.json` | `public, max-age=300` | release-routes.ts:127 |
| `/v1/pro/revocations` | `public, max-age=60` | license-revocations.ts:120 (already on the engine static list; nothing to register) |

Not to register (they must stay no-cache/no-store, COMPAT.md C6): `/v1/apps/:appKey/releases/latest.json` (`no-cache, no-store, must-revalidate`, or `private, no-store` with a bearer), `/v1/apps/:appKey/releases/patches.json` (`no-cache, no-store, must-revalidate`), runtime-artifact resolve (`private, no-store`).

## Open point for the RightSites owner

`/releases/patches.json` derives the app from the `X-ViewRight-App` / `X-App-Key` header, and both feeds vary on the `platform` query. A shared cache must key on the header for `/releases/patches.json`; the engine only keeps the header, it does not add `Vary`. Confirm the CDN cache key (or add `Vary` in the plugin) before relying on the 300s TTL for that path. This does not change the frozen header value.
