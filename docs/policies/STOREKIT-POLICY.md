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

## Not done (open against STOREKIT §8)

- Route-level request and response extension merge (`linkRequestExtension`, `linkResponseExtension`). The fork's `signedMobileTransactionInfo` therefore reaches `validateLink` only programmatically; tests drive the paired proof through `issue` directly.
- `lockPlan` contributions from policies (dependent licences and orders). The default policy has none, and the kit does not lock dependents.
- Order-released credit (`releasedUpgradeOrder`) and `order_reservation` (PAYMENT-TIMING §3.2–3.4, migration 0089).
- Device lease credential and `issueDeviceLease`; the kit issues activations, so heardright lease wire is not reproduced.
- T-K2 randomised interleavings (≥200 seeds) with capture and the upgrade order; only a 5-round concurrent-notification check exists.
- T-K4 golden recordings from the old runtime; T-K5 lock-set growth with `pg_locks` checks; T-K7 `LockOrderRecorder`; T-K8 `storekit_event`; T-K9 zero open transactions during verification (pool instrumentation); T-K11 `validUpgradeOrder`; T-K12 cascade ordering with tombstones; T-K14 rollback compatibility; T-K15 sandbox/platform matrix; T-K16 pairwise interleaving matrix.
- Runtime `assertHeld` guard and the ESLint ban on lock statements (§5.5).
- Plugin registration through `ApiPlugin.init(app)`. Registration is module-level for now.
- The `lock-audit` allow-list still records `applyStoreKitNotification` (#19). It is called only under the set, but the static audit does not follow calls.
