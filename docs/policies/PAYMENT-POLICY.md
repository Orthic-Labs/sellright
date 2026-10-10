# Payment policy (de-fork plan 3.4, steps 4-6)

Implements the policy contract of `rs-docs/docs/defork/PAYMENT-TIMING.md` §3-§5 as built in SellRight.
The engine owns attempt rows, provider calls, sweeps and HTTP mapping. A registered policy owns
app-specific decisions. Default (`sellright-default`) allows everything; orders without reservations
behave exactly as before.

## 1. Hooks

| Hook | Status | Call site |
|---|---|---|
| `beforePaymentAttempt(tx, input)` | implemented (step 4) | before the attempt row, replay lookup, provider session or PaymentIntent (`payments/policy/host.ts`, `gateway-payment.ts`, `routes/pay.ts` mint loop) |
| `beforeCapture`, `authorizeInvoiceEffect`, `revalidateForIssuance` | not yet | later steps, with their call sites |

A policy receives the order row already locked under `HeldLocks` (from `withLockedSet`) and the
order's reservation rows in any state. Hooks never call a provider and never write `payment` or
`payment_attempt` rows.

## 2. Composition and veto

- Policies run in registration order. The first veto wins and throws `PaymentPolicyVetoError`; the
  caller's transaction rolls back (no attempt row, no provider call).
- A veto is stateless: the same request is re-evaluated by the policy on the next call.
- A veto returns HTTP 409 with `error.code` = the veto's `code`, or `PAYMENT_POLICY_VETO` when the veto
  carries no code (`PAYMENT_POLICY_VETO_CODE`, registered in `lib/api-error.ts`). `message` is
  customer-visible; `extra.state` passes through.
- Each hook runs in `SAVEPOINT policy_hook`. A SQL or runtime error inside a hook rolls back to the
  savepoint and surfaces as `PaymentPolicyUnavailableError` (HTTP 503, `PAYMENT_POLICY_UNAVAILABLE`);
  nothing the hook wrote persists and the outer transaction is never left aborted.
- A duplicate policy id is a startup error.

## 3. Reservations (`order_reservation`, migration 0091)

States: `held` -> `consumed` (settlement) -> `released`. Live owner is unique per `(store, kind, owner_key)`
over `held|consumed`.

- **Consume (R2)**: `recordSettlementOperation` (the settlement chokepoint) consumes the order's held rows
  in the same transaction as the payment row and the Paid transition, for kinds `payment_settled`,
  `order_paid_transition`, `stripe_invoice_paid` and `order_edit_balance_settled`. It is a no-op for orders
  without held rows (checked without locks first) and for orders that are not `Paid|PartiallyRefunded` after
  the apply. A rolled-back settlement leaves the hold held. Implementation: `consumeForSettlement`
  (`payments/reservation.ts`), which takes the order row then the held rows (global order L3 -> L4).
- **Release (R3/R4)**: a release is requested by a cancel path (`requestRelease`) and takes effect only when
  the order is `Cancelled|Refunded` and `providerQuiescent` holds, evaluated under the order lock.
  Provider-terminal observations call `releaseOnProviderTerminal` in the same transaction:
  - a confirmed Stripe cancellation (`setAttempt` writing `cancelled`: webhook, reconcile, sweeps, order edit);
  - the orphan pre-mint resolution that cancels a row with no provider object.
  Standalone callers use `settleOrderReleases`.
- **Retryable failure keeps the hold**: a declined or `requires_payment_method` intent with an error writes
  `failed` and never releases. A later success on the same intent consumes the hold.
- **Cancellation race**: when the sweep's cancel loses to a succeeded PaymentIntent, the sweep settles
  (consume). When it wins, the attempt is `cancelled`, the order stays alive and the hold stays `held`.
- Money that lands after a release follows I1 (recorded, `payment_after_cancel`). Operator overrides
  (`released_unverified`) are an admin-route concern, not implemented here.

## 4. Deadlines and sweeps

Deadline: `PAYMENT_INTENT_DEADLINE_MIN` (env, default **60**, decision X-10). Age is measured from
`payment_attempt.created_at`.

Sweeps run from `jobs/release-stale-allocations.ts` under its `apply` gate (`JOBS_RELEASE_STALE_APPLY=1`)
and leader lock, per store, in this order:

1. `discoverStaleUntrackedIntents`: Stripe search for untracked intents on stale orders (existing).
2. `sweepStaleStripeIntents`: checkout intents on `PendingPayment` orders older than the stale TTL and
   `Cancelled` orders (existing). Pre-mint rows are not resolved here.
3. `sweepStaleBalanceIntents` (new, G1): intents on `Paid|PartiallyRefunded` orders whose attempt is older
   than the deadline. Each is resolved at Stripe: succeeded settles; `processing` or `requires_capture`
   holds (never cancelled); anything else is cancelled at Stripe.
4. `sweepOrphanPreMints` (new, X-9): open attempts with `provider_ref NULL` and key
   `stripe-pi-pending:<mintKey>` older than the deadline. `createPaymentIntent` now records the mint key as
   PaymentIntent metadata (`mintKey`). A PI with the key is **bound** (`provider_ref` set; the pending
   iteration key is kept so a replay of the same mint key still collapses onto the row). A clean search with no PI is **cancelled**, and the order's
   requested holds are released if quiescent. An untracked PI without a mint key and with the same amount
   is ambiguous and fails closed.

Failure handling (2-4): exponential backoff in `attempt.context.recovery` (`nextAt`); after
`STRIPE_SWEEP_MAX_TRIES` (5) the attempt is `recovery.manual`, a `stripe_intent_unresolvable` audit alert is
written, and the sweeper stops touching it. Manual dispositions (`cancel-intent`, `override-release`) are
the admin routes of PAYMENT-TIMING §5.3, not yet implemented.

An order with an unresolved open or processing intent, or an open pre-mint row, is not quiescent and is
excluded from the stale-order cancel claim until resolved.

## 5. Quiescence

`providerQuiescent(tx, store, order, { stripeDiscoverable })` is true only when no attempt (other than
refunds) is non-terminal (`settled|cancelled`, except `failed` NMI, and `failed` Sezzle with
`recovery.authorization_released`), no `Pending|Authorized` payment exists, and, for a Stripe-enabled
store, the order is not on discovery hold and has either intents or a clean discovery check.

## 6. Tests

`payments/reservation-cancel-or-consume.db.test.ts` (db project, `*_test` database) covers PAYMENT-TIMING
T-S1 (decline then success), T-S2 (both cancellation interleavings and release on a confirmed cancellation),
T-S3 (balance intent cancelled past the deadline, fresh and processing intents untouched, manual after five
tries), the orphan pre-mint cases (bind, cancel, ambiguous, search error), and consume atomicity with the
settlement. Stripe is mocked at the retrieve/search/cancel seam.

Not covered in this step: `reservation-release-sweep` (the 15-minute safety net for a lost release event),
the admin disposition routes, and the policy hooks listed as not yet implemented in section 1.
