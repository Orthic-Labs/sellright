# Entitlement authorization policy and frozen signed claims

Plan items 3.6 and 3.7. Code: `packages/api/src/licensing/entitlement-policy.ts`, `sign.ts`. Tests: `entitlement-policy.test.ts`, `entitlement-policy.matrix.db.test.ts`, `sign.golden.test.ts` (golden: `licensing/test-vectors/signed-v2.golden.json`).

## 1. Interface

One registered policy (`registerEntitlementPolicy`, `clearEntitlementPolicy`). Nothing registered = default policy = pre-policy engine behaviour.

| Member | Purpose | Default |
|---|---|---|
| `requestExtensions[activate\|refresh\|lease_issue\|trial]` | zod schema over the raw JSON body; result is `ctx.ext`; invalid => 400 `INVALID_REQUEST` (or, with `invalidExtension: 'internal'`, the raw ZodError => 500 `internal error`, the legacy wire) | none (`ext = {}`) |
| `invalidExtension` | `'bad_request'` keeps 400 `INVALID_REQUEST` for invalid typed extensions; `'internal'` opts a policy into the legacy 500 (the fork test kit sets it, COMPAT G06). Base-schema failures are 500 either way. | `'bad_request'` |
| `preRoute(ctx)` | runs right after body parse on the three activate routes, BEFORE store resolution, the rate limiter and any DB work; returns `{status:400\|403, message, code?}` to refuse (mapped to `HttpError`) | none |
| `authorize(ctx)` | allow / deny `notfound` / deny `rejected_platform(reason)`; runs in the caller's store transaction (`ctx.tx`) | allow |
| `claims(ctx)` | additive signed claims (`entitlementScope`) | none |
| `leaseUnlimited(ctx)` | bypass the per-pool lease cap | false |
| `trial(ctx)` | `{days, metadata?}` for `start` and `resend` | `{days: TRIAL_DAYS (14)}` |

A policy may also throw `EntitlementVeto` (rolls back, returned as `{ok:false,status,message}`).

## 2. Paths consulted (matrix of record)

Every granting or refreshing path consults the policy; `entitlement-policy.matrix.db.test.ts` asserts the path id per route, including both alias paths.

| Path id | Entry points | allow | deny `notfound` | deny `rejected_platform` |
|---|---|---|---|---|
| `activate` | `POST /api/licenses/activate`, `POST /v1/licenses/activate` (alias, one handler), `POST /v1/apps/{appKey}/licenses/activate`; `activateLicenseOnDevice` | 200 `Activated` | 404 `{ok:false,status:'not_found',message:'License not found or inactive'}` (path-param route: 404 `LICENSE_NOT_FOUND`) | 400 `{ok:false,status:'rejected_platform',message:reason}` (path-param route: 400 `REJECTED_PLATFORM`); no activation row is written |
| `refresh` | `POST /api/licenses/refresh`, `/v1/licenses/refresh`; `findActivationByToken` | 200 `ok:true` | 200 `{ok:false,status:'invalid',message:'License is no longer active'}` | same as notfound |
| `update_feed` | `GET /releases/latest.json`; `findActivationByToken({path:'update_feed'})` | proceeds to release lookup | 401 `Invalid activation token` | same as notfound |
| `lease_issue` | `issueDeviceLease` (plugin routes `/v1/pro/{appKey}/devices/lease`, StoreKit/bridge/Windows-link redeem call it) | `ok` | `notfound` | `rejected_platform{reason}` (plugin maps to 400) |
| `lease_renew` | `renewDeviceLease` | `ok` (lease id rotates) | `revoked` (410 in the plugin); lease id NOT rotated | same as notfound |
| `trial_start` | `POST /api/licenses/trial`, `/v1/licenses/trial` | `trial()` decides days and extra metadata | n/a (throw `EntitlementVeto` to refuse) | n/a |
| `trial_resend` | same routes, existing unexpired trial | `trial()` decides the days shown; persisted `priorMetadata` is passed | n/a | n/a |
| `storekit_link` | `POST /v1/shop/pro/link-storekit` (`issueStoreKitActivation`, called after the purchase is verified and linked to the customer, before any activation token is minted or seat consumed) | 200 `{ok,activationToken,lease}` | 400 `license could not be activated` | 400 with the policy's reason; no `license_activation` row is written |
| `windows_link` | plugin Windows link request calls `authorizeEntitlement({path:'windows_link'})` | proceed | plugin maps to its own result | plugin maps to 403 + reason |

Not consulted, by design: `deactivate` (frees a seat, grants nothing); `GET /v1/apps/{appKey}/updates/latest` (keys on the license key, not an activation; identical to the fork, which also does not gate it; see open items).

Alias handling: `/api/licenses/activate` and `/v1/licenses/activate` are registered by one `apps.on('POST', [...])` call, so decisions and bytes are identical on both.

Alias behaviour change (P36-5, not a fork-parity change): `/v1/licenses/activate` was a RightSites-only route; it is now served by the engine. For a store on the default policy this is NEW exposure: the route answered 404 before and now answers activations. Because `/v1/*` sits behind the maintenance gate and `/api/*` does not (`app.ts` maintenance middleware), the `/v1` alias now also pauses during maintenance, the same way every other `/v1` route does. Admission rules for the alias must mirror `/api/licenses/activate` before it is exposed on any store; this is an owner decision (recorded in the changelog), not an approved wire change.

## 3. Mapping from the RightSites fork

| Fork rule (COMPAT) | Fork code | Policy expression |
|---|---|---|
| C11 legacy activate: not active, or sandbox-origin, or mobile scope, or invalid upgrade => notfound | `activations.ts:92` | `authorize(activate)` returns deny `notfound` when `isSandboxStoreKitLicense` or `scope==='mobile'` or `!validUpgradeLicense` |
| C11 activation lookup for refresh/updates, same predicates | `activations.ts:220` | `authorize(refresh\|update_feed)`, same predicates |
| C11 lease issue: invalid upgrade => notfound; sandbox on `computer` pool, or platform not allowed by scope => 400 text `Mobile Pro authorizes iPhone & iPad only; Full Pro is required for computers.` | `device-leases.ts:125-129` | `authorize(lease_issue)` using `ctx.pool`, `ctx.platform`; returns `rejected_platform(reason)` |
| C11 lease renew: sandbox + stored `computer`, or mobile scope + pool != `mobile` => revoked | `device-leases.ts:293-294` | `authorize(lease_renew)` using stored `ctx.pool` |
| C11 Windows link: sandbox-origin => 403 + text | `pro-devices.ts:378`, `windows-link.ts:87` | `authorize(windows_link)` returns `rejected_platform(text)` |
| C12 HeardRight mobile lease pool unlimited | `device-leases.ts:135` | `leaseUnlimited`: `appKey==='heardright' && pool==='mobile'` |
| Scope claim on the signed token and the lease envelope when mobile | `device-leases.ts:230,239,307,316`, `sign.ts:41,47,146` | `claims` returns `{entitlementScope:'mobile'}` |
| C10 trial: HeardRight macOS 30 days, other platforms/none 14; other apps 14 | `apps.ts:318` | `trial(start)`; `trialDaysForPlatform`/`TrialPlatform` move into the plugin policy (IMPORT-DISPOSITION: moved) |
| C10 resend term from the persisted platform | `apps.ts:374-379` | `trial(resend)` reads `ctx.priorMetadata.platform` |
| C10 `metadata.platform` persisted on every trial (any app) | `apps.ts:394` | `trial(start)` returns `metadata:{platform: ext.platform ?? null}` |
| Trial request `platform` enum `macos\|windows\|ios` | `apps.ts:298-303` | `requestExtensions.trial` |
| Watch `deviceClass` never activates | `activation-guards.ts`, `suite-policies.ts:49` | `requestExtensions.activate` + `preRoute` throws `HttpError(400, WATCH_REASON)` before store/rate-limit/lookup |

`entitlement-policy.fork-reference.testkit.ts` is an executable version of this table (test kit only, not imported by the engine); `entitlement-policy.matrix.db.test.ts` runs it through every path. The real plugin policy binds `validUpgrade` to `heardright-mobile-upgrade#validUpgradeLicense`.

Known differences when the fork is expressed as a policy:
- Watch `deviceClass`: the policy `preRoute` seam runs before store resolution, the rate limiter and any lookup, and throws `HttpError(400, <fork message>)`, so the rate limiter is never consumed and unknown keys/apps get the same 400 as the fork. The bytes are checked against `test-vectors/legacy-activate-refusals.golden.txt` (`entitlement-policy.legacy-golden.test.ts`, `/v1` and `/api`) after a test-side mirror of the fork's legacy-error-shape transform; the production transform is the plugin's (rs-compat `rightsites-plugin/legacy-error-shape.ts`). The path-param route answers 400 with code `DEVICECLASS_WATCH_...` (the same code as the fork); its bytes are *unverified* against the fork's runtime body.
- An invalid typed extension (e.g. `platform:'plan9'`) is a clean 400 `INVALID_REQUEST` by default. A policy that needs the fork's wire sets `invalidExtension: 'internal'` and gets the legacy 500; the fork test kit does so. Engine default policy: 400 (unapproved change for SellRight stores; no shipped client sends these values).
- StoreKit link (P36-2): the engine's `POST /v1/shop/pro/link-storekit` grants through `issueStoreKitActivation` only, which consults `storekit_link`. The fork instead routes the HeardRight link through `issueDeviceLease` (`storekit-webhooks.ts:222-224`, signed lease response). The engine answers the fork's lease-shaped JSON with `signature: null`. The HeardRight plugin must either replace this route or bind its policy so the link returns a signed lease; not verified here.
- `findActivationByToken` now returns `pool` in its row (additive).

## 4. Signed claims (3.7)

Frozen v:2 order (`V2_FIELD_ORDER`, pinned literally by `sign.golden.test.ts`):

`v, id, app, tier, features, device_id, iat, exp, license_kind, entitlement_stage, license_issued_at, confirmation_due_at, entitlement_scope`

Rules: optional claims are omitted when absent (never null-filled, except `confirmation_due_at` when explicitly `null`, as before); new claims may only be appended and optional; the lease envelope has no version field, and carries `entitlementScope` last, only when the policy supplies it. The golden pins tokens and lease-envelope canonical bytes for fixed inputs under a fixed test-only key (Ed25519 is deterministic). Default-policy golden cases were verified byte-identical against the pre-change `sign.ts` signer. An independent minimal verifier (native-verifier shape: verify over decoded first segment, then read claims by name) accepts every golden token. Shipped native verifiers in `docs/defork/verifiers/` were not available here: *unverified* against them.

Capability negotiation: the client may send `x-entitlement-versions: 2,3`. `negotiateSignedVersion` picks the highest version both sides support; no header, garbage, or no overlap yields `v:2`. `registerSignedFormat({v, fieldOrder, extraClaims})` registers a future format (v > 2 only; v:2 can never be replaced or registered twice). Routes thread the offer into the plugin hook contexts (`offeredVersions`) and into `issueDeviceLease`/`renewDeviceLease` (`offeredVersions`); `signEntitlement({offeredVersions})` performs the negotiation. A client that never offers a higher version always receives a byte-identical v:2 token.
