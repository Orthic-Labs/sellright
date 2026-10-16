# Instrumentation (de-fork plan 2.9, migration 0088)

Everything here is additive and R0-compatible: new columns are nullable or defaulted, so the previous release's INSERT/UPDATE statements keep working. Health predicates consume these fields by projection name (`HEALTH-PREDICATES.md`); this file documents what the engine writes.

## Claim columns (`webhook_delivery`, `email_outbox`, `push_outbox`)

| Column | Meaning | Written by |
|---|---|---|
| `claimed_at` | when the current worker claimed the row; NULL when not claimed | set in the claim `UPDATE` (every claim, including stale reclaim); nulled on sent/delivered, retry, dead, and by the webhook reaper |
| `first_failed_at` | first reported failure; never overwritten | `coalesce(first_failed_at, now())` on every failure outcome (retry, dead, push `unregistered`) |
| `webhook_delivery.updated_at` | last touch (the table had none) | instrumented worker claim/finalize and the reaper (application-side) |

**No trigger (R0 only).** A trigger on an existing table would change old-runtime write behaviour (R1), so 0088 adds none and no R1-deferred migration is shipped. Consequence: an old worker never writes `claimed_at`/`updated_at`, so after a rollback `GREATEST(updated_at, created_at)` for a webhook row claimed by an old worker is stale (conservative: it can only look older, never newer). The migration backfills existing `processing` webhook rows to `created_at` (what the old reaper used); because the table is FORCE RLS and the migration has no `app.current_store`, it lifts FORCE for that one UPDATE and restores it (otherwise it updates 0 rows).

Projection contract: candidate epoch = `claimed_at`; old-runtime epochs ignore `claimed_at` (an old worker reclaiming leaves a stale candidate value). Rows left `processing` with NULL `claimed_at` by old workers are the runner's backfill target. The email/push reclaim predicate stays `updated_at < now() - 10 min`; the webhook reaper now keys on `updated_at` instead of `created_at`.

## `payment_attempt.provider_status` / `provider_observed_at`

Advanced only by a successful provider retrieval bound to the attempt (`payments/provider-observation.ts`, monotonic in `provider_observed_at`). Never from webhook payloads, failed/unavailable fetches, or identity-mismatched responses.

Vocabulary is MAINTENANCE-INVENTORY 4.6 (normative), pinned by `payments/provider-vocabulary.test.ts`:

| Method | Retrieval paths that write | `provider_status` | Terminal |
|---|---|---|---|
| Stripe (intent) | `reconcileStripeOrder`, `resolveIntentForCancel` (retrieve, then post-cancel response), `cancelOpenIntentsForOrder` (cancel response, in a savepoint) | PaymentIntent `status` verbatim | `succeeded`, `canceled` |
| NMI (charge) | `verifyGatewayAttempt` via `queryNmiPaymentObserved`; only when the response identifies this attempt's single transaction | `settled` / `failed` from the verified result (raw `condition` is not stored), else `unresolved:<reason>` | `settled`, `failed` |
| Sezzle (session) | `verifySezzleAttempt`, gateway recovery GET (uuid == providerRef); one function `sezzleObservedStatus(order, {amount, currency})` | `captured` (captures exactly cover the amount, no refund/dispute), `declined` (denied/deleted), `held` (approved, uncaptured), `open`, or `unresolved:<reason>` (invalid/partial/excess capture, refund/dispute, expired authorization) | `captured`, `declined` |

Not written: refund attempts (NMI/Sezzle refund discovery), Sezzle webhook binding GET (`resolveSezzleSessionAttempt`), NMI synchronous sale response, Stripe webhook snapshots. `TERMINAL_PROVIDER_STATUSES` in `provider-observation.ts` is the table form. A partial capture or dispute is never `captured`.

## `storekit_event`

Columns: `id, store_id, operation_id, stage{verify,apply,replay}, outcome{ok,failed}, error, resolved_by_event_id, created_at` (FORCE RLS; `created_at` is `clock_timestamp()`; CHECK: only `failed` rows may carry a resolver). Writer: `licensing/storekit-events.ts`.

Resolution: successful `verify` resolves earlier `verify` failures of the same `(store_id, operation_id)` only; an `apply` success resolves earlier `apply` failures of the same operation, written in the apply transaction (so only a committed apply resolves); `replay` never resolves. Unresolved StoreKit = `stage='apply' AND outcome='failed' AND resolved_by_event_id IS NULL` (partial index `storekit_event_unresolved_idx`).

Operation ids: verify rows `payload:<sha256 of signedPayload>` (relies on Apple re-sending identical bytes: *unverified*; a re-signed retry leaves only a non-gating verify failure); apply/replay rows `notification:<notificationUUID>` from the verified payload; link endpoint `link:<sha256(appKey + signed transaction)>` for both stages.

Bounds and failure isolation: unauthenticated verify-failure rows are written at most once per payload digest per hour and under a per-(ip, bundle/appKey) budget of 30/hour (`storekit-verify-failure` limiter); rows are never written for an unknown bundle. Apply/replay/verify-ok inserts made inside a customer-affecting transaction run in a SAVEPOINT (`db/savepoint.ts`; raw SAVEPOINT because `tx.transaction()` over a PoolClient would issue a real BEGIN/COMMIT) and a failure is logged, never rolled into the caller's work; the same holds for the `cancelOpenIntentsForOrder` observation. A definitive link refusal (seat limit, unknown licence, account conflict) records an apply `ok` so it concludes the operation and resolves an earlier thrown apply failure. No retention prune is added (bounded by the limits above; a prune of old resolved/verify rows is a follow-up).

Wired in this repo (StoreKit lives in the engine): `POST /v1/webhooks/apple/storekit` (verify ok/failed, apply ok in the apply tx, apply failed recorded after rollback then rethrown so Apple retries, replay on duplicate UUID) and `POST /v1/shop/pro/link-storekit` (verify; apply ok on completed activation; apply failed only for thrown errors, not 401/409/400 domain refusals). Notifications whose bundle id resolves to no app have no tenant and are not recorded. Errors are stored without SQL/params.

## Open items for consumers
- Nothing re-observes `failed` NMI attempts or settled-then-stale Stripe `failed` attempts on a schedule; the gate's "stale observation" rule will count them until a reconcile pass or operator verify refreshes them.
- The plan's fork (RightSites) must call `recordStoreKitEvent`/`recordStoreKitEventDetached` from any fork-only StoreKit handlers once it adopts the engine.

## Webhook reaper default (INSTR-1)
The engine default stays dry-run (`JOBS_WEBHOOK_REAPER_APPLY` unset), so other SellRight stores are unchanged. RightSites' candidate configuration sets `JOBS_WEBHOOK_REAPER_APPLY=1` (DECISIONS X-33, listed in the 7.1 intended-config table), and HEALTH F2 relies on it: without it a crashed claim stays `processing` forever. The reaper keys on `updated_at` (set at claim) and nulls `claimed_at` on release.
