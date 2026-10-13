# Cache policy: plugin-registered cacheable exceptions (2026-10-13)

Problem: `cachePolicy()` (packages/api/src/cache-policy.ts) rewrites every response to `private, no-store` unless the path is on the static `CACHEABLE_EXCEPTIONS` list, so the packed engine overwrites the RightSites plugin's frozen release-feed headers (docs/defork/COMPAT.md C6, C7). `/v1/pro/revocations` is already on the static list; the release feeds are not.

## Engine API (this change)

- `registerCacheableExceptions(entries: readonly CacheableException[])` exported from `cache-policy.ts`.
- `ApiPlugin.cacheableExceptions?: readonly CacheableException[]`, applied by `registerApiPlugin` before the plugin is stored (all-or-nothing).
- Entry: `{ path: string | RegExp, source, reason }`. `source` and `reason` must be non-empty. String paths start with `/`; RegExp paths are anchored `^...$`.
- Throws on: duplicate or overlap (static list, earlier registration, same batch); hard-denied paths (catalog, cart, checkout, stock, inventory, availability, price, feeds, admin, account, auth, orders, customer segments); RegExps that match any denied probe path.
- Kept only on 200 GET/HEAD; POST/other statuses stay `private, no-store`; `cache-tag` always stripped. Static list unchanged.

## Call the RightSites plugin must make (rs-int, NOT edited here)

In the plugin's `registerApiPlugin({...})` call (rightsites-plugin entry) add:

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

Header values to keep (already set by the plugin; frozen in COMPAT.md C6):

| Path | Cache-Control | Plugin line |
|---|---|---|
| `/v1/apps/:appKey/releases/status.json` | `public, max-age=300` | release-routes.ts:102 |
| `/releases/patches.json` | `public, max-age=300` | release-routes.ts:127 |
| `/v1/pro/revocations` | `public, max-age=60` | license-revocations.ts:120 (already on the engine static list; nothing to register) |

Not to register (they must stay no-cache/no-store, COMPAT.md C6): `/v1/apps/:appKey/releases/latest.json` (`no-cache, no-store, must-revalidate`, or `private, no-store` with a bearer), `/v1/apps/:appKey/releases/patches.json` (`no-cache, no-store, must-revalidate`), runtime-artifact resolve (`private, no-store`).

## Open point for the RightSites owner

`/releases/patches.json` derives the app from the `X-ViewRight-App` / `X-App-Key` header, and both feeds vary on the `platform` query. A shared cache must key on the header for `/releases/patches.json`; the engine only keeps the header, it does not add `Vary`. Confirm the CDN cache key (or add `Vary` in the plugin) before relying on the 300s TTL for that path. This does not change the frozen header value.
