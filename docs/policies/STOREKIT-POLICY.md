# StoreKit policy (de-fork plan 3.5)

Implements the policy contract of `rs-docs/docs/defork/STOREKIT.md` §3–§5 in SellRight.
Engine owns routing, JWS verification, operation claims, lock planning and HTTP mapping.
A registered policy owns app-specific decisions.

## Code map

| Piece | File |
|---|---|
| Contract types, registry (`registerStoreKitPolicy`, `storeKitPolicyFor`) | `packages/api/src/licensing/storekit/policy.ts` |
| `sellright-default` policy and SellRight wire mapping (`sellrightRespond`) | `packages/api/src/licensing/storekit/default-policy.ts` |
| Notification and link orchestration over the policy, `withLockedSet` | `packages/api/src/routes/storekit-webhooks.ts` |
| Lock subjects `notification` and `link` (purchase identities, L1, plus bound licence, L2) | `packages/api/src/db/locks.ts` |
| `restoreActivations` gate on the apply helper | `packages/api/src/licensing/storekit-license.ts` |
| Fork-reference kit (test-only, heardright rules) | `packages/api/src/licensing/storekit/fork-reference-policy.kit.ts` |
| Shared Apple-like JWS fixture (test-only) | `packages/api/src/licensing/storekit/jws-fixture.ts` |
| Unit tests (registry, decideMaterialize, respond precedence) | `packages/api/src/licensing/storekit/policy.test.ts` |
| DB tests (T-K1, route + kit, T-K2 partial, T-K3 contract, T-K6) | `packages/api/src/licensing/storekit/policy.db.test.ts` |
| Lock-audit allow-list reseed | `packages/api/scripts/lock-audit.allowlist.json` |

## Flow

Notification (`POST /v1/webhooks/apple/storekit`):
1. Peek bundle (routing only), resolve store and app, verify the JWS. No transaction is open.
2. Ignored or identity-less notifications: claim only, in one transaction (unchanged).
3. Otherwise `withLockedSet(storeId, {kind:'notification', purchase})`:
   claim `apple-storekit:<uuid>` (conflict means no-op), `policy.cascade` for the restore gate, apply,
   and when the apply returns `no_purchase` and `policy.decideMaterialize` says yes, `policy.issue({purpose:'materialize'})` and apply again.
4. An exception rolls back the claim, so Apple's retry re-executes. `LockSetUnstable` returns 503.

Link (`POST /v1/shop/pro/link-storekit`):
1. Load app config, verify the primary JWS, resolve the customer. No transaction is open.
2. `policy.validateLink` (may verify paired proofs, no DB writes).
3. `withLockedSet(storeId, {kind:'link', purchases})` where purchases = primary (+ paired). `policy.issue({purpose:'link'})` runs inside.
4. `policy.respond(outcome)` yields the HTTP result. Error precedence follows STOREKIT §3 rule 3.

## Lock order and identities

- L1 purchase advisory locks: `purchaseLockKey` string, sorted by `hashtextextended`, de-duplicated (`acquirePurchaseLocks`).
- L2 licence rows: the purchase row's bound licence, read unlocked, re-planned under the locks; growth restarts (max 3), then 503.
- Purchase identity is `(store, environment, originalTransactionId)`. Operation identity is the notification UUID. The two are never mixed.

## Registration

- `sellright-default` registers itself as the fallback when `default-policy.ts` loads.
- A policy with `appKeys` serves those keys. A second policy for a served key, or a second fallback, throws at registration.
- Default behaviour: unchanged for every existing store (the default issues the same SQL in the same order, apart from the purchase advisory lock).

## Behaviour changes (deliberate, recorded)

- The link path verifies the primary JWS before the transaction (STOREKIT §4.2 B) instead of inside it.
- Every link and actionable notification takes the purchase advisory lock (STOREKIT O-5). This is one extra advisory lock per call; no wire change.
- Lock-set instability returns 503 on both routes (STOREKIT O-3). Previously an unhandled error (500).

## Fork-reference kit (test-only)

Reproduces, through the policy contract and the built-in route:
- platform outside {ios, ipados} rejected with the fork message (`routes/storekit-webhooks.ts:196`)
- upgrade product requires a verified paired proof (`:198–200`)
- materialize for every action except the upgrade product (`:117`)
- mobile source equality: product, bundle, environment, equal non-null `appAccountToken` (`storekit-license.ts:73–80`)
- credit used by a different upgrade key (`storekit-license.ts:115–122`, metadata part)
- restore does not re-activate tombstoned devices (`storekit-license.ts:478`)

## Extension, lock plan, registration, guard (STOREKIT §3, §5.3, §5.5)

- Route-level request extension: a policy's `linkRequestExtension` zod shape is parsed per request after the
  customer check; failures are a 400 `invalid link request`. The kit's `signedMobileTransactionInfo` reaches
  `validateLink` through `request.extensions`.
- `linkResponseExtension` is typed only. The OpenAPI document is built at startup from static route definitions,
  so extension shapes are not merged into the published spec (open).
- `lockPlan` hooks: every registered policy's `lockPlan` is unioned into the plan of each subject
  (`db/locks.ts` `registerLockPlanContributor`). The kit adds, for notifications and links, the upgrade dependents of
  the bound licence (and their orders), and for an order subject the upgrade source, its Apple purchase and siblings.
- Registration: the default fallback is installed by `createApp()` (`installDefaultStoreKitPolicy`, idempotent)
  before plugins run; no registration happens at module load. Plugins register through `ApiPlugin.init`.
- `assertHeld` (debug/test only; no-op when `NODE_ENV=production`): the engine calls it before every `issue` and
  `cascade`. It checks the brand came from `withLockedSet` in the same transaction, that promised purchase advisory
  keys are granted in `pg_locks`, and that promised L2/L3 rows were taken by this set (row locks are not visible in
  `pg_locks`, so rows are checked by bookkeeping).
- Dependent cascade (kit `cascade`): revoke or expire takes the source and its dependents to `revoked` and tombstones
  active activations with a generation bump; restore touches no dependent and never un-tombstones.
- The kit rejects a paired mobile licence that is not active and unexpired (fork `storekit-license.ts:101–103`).

## Not done (open against STOREKIT §8)

- `linkResponseExtension` in the published OpenAPI document (see above).
- Order-released credit (`releasedUpgradeOrder`), `order_reservation` and the settlement leg of T-K2 (PAYMENT-TIMING
  §3.2–3.4, migration 0089): owned by the payment lanes.
- T-K11 `validUpgradeOrder`: depends on reservations and is owned by the payment lanes.
- Device lease credential and `issueDeviceLease`; heardright lease wire is not reproduced.
- T-K4 heardright goldens from the old runtime (only the default-policy goldens exist, recorded from HEAD).
- T-K7 `LockOrderRecorder`, T-K8 `storekit_event`, T-K14 rollback compatibility, T-K15 sandbox/platform matrix,
  T-K16 pairwise interleaving matrix: prerequisites not in this lane.
- The `lock-audit` allow-list still records `applyStoreKitNotification` (#19).
