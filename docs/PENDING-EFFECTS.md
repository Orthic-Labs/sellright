# Pending effects and the settlement chokepoint

Engine implementation of de-fork plan 2.8. Normative design: `SETTLEMENT-OPS.md` and
`INVOICE-DISPOSITIONS.md` (RightSites `docs/defork/`). This file documents what the engine
ships and where it deliberately does something the design leaves open.

## Tables (migration 0090)
| Table | Purpose |
|---|---|
| `settlement_operation` | One row per settlement FACT, `UNIQUE (store_id, operation_kind, operation_id)`. Invoice classification + `authorized_effects` are frozen here. Also carries `snapshot` (`order_purge`) and the operator columns (`operator_resolution`, CHECK-tied; partial unique index allows one entitlement-bearing resolution per target). 11 kinds (CHECK). |
| `order_pending_effect` | The effects an operation authorizes (`resolution jsonb` NULL for held outcomes; review queue = `status=terminal AND resolution IS NULL AND resolved_by IS NULL`). `UNIQUE (store_id, operation_kind, operation_id, effect_kind)`, composite FK to the operation, `resolved_by` -> operation, `result jsonb`. Effect kinds (CHECK): `license_issue, license_extend, edit_reconcile, loyalty_earn, notification, admin_review`. |
| `applied_operation_receipt` | `(effect_id, provider_ref)` plus `store_id`/`created_at` for RLS. Reserved for external effects; none exist today. |
| `subscription_invoice_payment` | Orderless invoice money (`payment.order_id` is NOT NULL). INVOICE-DISPOSITIONS 7.2 columns/indexes; FK `store(id)` kept (D-2). |

All four are `FORCE ROW LEVEL SECURITY` with the `tenant_isolation` policy.

## `recordSettlementOperation(tx, op)` — `src/payments/settlement/record.ts`
Declarative: `{ storeId, kind, operationId, classification?, resolution?, mutations[], effects[] }`.
It never opens a transaction, checks the transaction is scoped to `op.storeId`, validates mutation and
effect eligibility per kind (`ops.ts`, exhaustive `satisfies Record<SettlementKind, ...>`), takes advisory
locks (provider-ref lock for ref-bearing payments, then the order row), and:
* monotone kinds (`payment_state_progress`, `payment_mode_corrected`): guarded mutation, no row, no effects;
* once kinds: inserts the operation row; a conflict is a replay (no mutation, no effect rows);
* `operator_resolution`: target must exist, `skip` records the decision only, `apply` runs the allowed
  mutations/effects and sets `resolved_by` on the target's terminal effect rows; a second entitlement-bearing
  resolution for the same target is refused;
* `order_purge`: payments are snapshotted on the operation row first, then payments and the order are deleted.

Effects are inserted `pending` in the same transaction. `effectMode: 'inline'` (default) then runs them
before commit in rank order (`executeEffectsNow`), which keeps observable behaviour identical to the old direct
calls (a handler failure aborts the settlement). `'deferred'` leaves them for the worker.

Built-in operation use (SellRight equivalents of the plan's sites):
| Site | Operation |
|---|---|
| `payments/settle.ts` `applyPaymentResult` | `payment_settled` / `payment_state_progress` (+ `payment_gateway_identity`), then `order_paid_transition(order.id)`; balance payments: `order_edit_balance_settled(edit)` when the edit's own `record_payment` clears the balance (`editId`), else `payment_settled(payment.id)` with `{edit_reconcile, loyalty_earn}` |
| `payments/subscriptions.ts` `onInvoicePaid` | `stripe_invoice_paid(invoice.id)` — ONE operation, no nesting |
| `payments/stripe-reconcile.ts` | `duplicate_capture_recorded(payment.id)` (no issuance) |
| `routes/checkout.ts` | zero total / full gift-card cover: `order_paid_transition(order.id)`; partial gift card: `payment_settled` |
| `routes/admin-order-ops.ts` | draft order (maybe created Paid + manual payment): `order_paid_transition`; purge: `order_purge` |
| `routes/payment-webhooks.ts` | `payment_mode_corrected` |
| `orders/order-edit-service.ts` | `order_edit_balance_settled(edit.id)` for the zero-balance reconcile |
| `import/orders.ts`, `scripts/seed-demo.ts` | allowlisted (`historical_import`, `synthetic_seed` kinds exist and are effect-free) |

## Effects worker — `src/payments/settlement/effects.ts`
Claim: `UPDATE ... SET status='processing', claim_token=gen_random_uuid(), claimed_at=now()` over due `pending`
rows and `processing` rows older than 5 minutes (reclaimed with a NEW token), `FOR UPDATE SKIP LOCKED`, an
earlier-rank sibling blocks a later one. Every status write checks `claim_token`; a fenced write matches zero
rows and rolls its transaction back (local mutations included). One transaction per effect: the handler's
mutations and `done` commit together. Retries `least(2^attempts*30s, 1h)`, terminal after 8 attempts or a
precondition that cannot hold, plus an `admin_review` row; `terminal` is admin-visible (audit row
`effect_terminal`, `effect.terminal` webhook event, `effects` on `GET /v1/admin/payment-reconciliation`, retry via
`POST /v1/admin/payment-reconciliation/effects/:id/retry`). "Not ready" retries (renewal before its first
invoice) are bounded by a 72 h horizon instead of the attempt budget. External handlers use the effect id as the
provider idempotency key and write the receipt in the `done` transaction.

Runs from the API scheduler (`pending-effects` leader job, 15 s) and as `node dist/scripts/effects-worker.js [--once]`
(`pnpm effects:worker`).

### Handlers (`handlers.ts`) and behaviour preservation
The old inline calls moved behind the kinds without changing what they write. Where the two original paths
ordered things differently, the variant is in the payload: `loyalty_earn{settle}` bootstraps the purchase
account first (as `enqueuePaidEffects` did), `notification{checkout}` bootstraps after rewards (as checkout did)
and keeps the checkout email/Live Activity push; `notification{settle}` keeps event, confirmation, list
enrolment and push. `license_issue` for a first-cycle invoice also links the licence to the subscription and
persists `settlement_operation.license_id`. Deferred effects first check the order is still in the paid
lifecycle (refund-before-effects goes `terminal`, never silently issues).

## Invoices (`invoice.ts`)
`billing_reason` -> classification (SETTLEMENT-OPS 4); legacy/unknown reasons use the `InvoiceHistoryPolicy` port
(`initialInvoice`, `disposition`). **Engine default deviates from the design note on one point:** the design says
the default `initialInvoice` returns `unresolved`; the shipped default resolves from LOCAL evidence only (licence
already linked, or a prior `first_cycle` operation for the order => not initial; no evidence => initial), because
the existing suites deliver invoices without a `billing_reason` and require the legacy behaviour. A plugin
replaces it wholesale (`setInvoiceHistoryPolicy`) and may return `unresolved`. Stripe `account id` is not known to
the SellRight webhook; `InvoiceContext.accountId` defaults to `'default'` and `mode` comes from the verified signature.
Dispositions `ignored_non_subscription`/`voided` are not produced by the engine (the plugin port can return them;
they record the operation with no effects).

## AST CI check — `scripts/assert-settlement-chokepoint.mjs`
`pnpm assert:settlement` (wired into root `verify:db`). TypeScript compiler API with a type checker; rules S1-S8
as in SETTLEMENT-OPS 7.3. Allowed locus: the body of `recordSettlementOperation` in `record.ts`, and
`scripts/settlement-chokepoint.allowlist.json` (count-checked, each with a positive fixture):
`A-IMPORT-ORDERS` (2), `A-SEED-DEMO` (1), `A-EFFECT-ENGINE` (the engine's own `order_pending_effect` /
`settlement_operation` link writes in `effects.ts`; this entry is an addition to the design's list).
Fixtures: `scripts/settlement-chokepoint.fixtures/{fail,pass}`; self-test `src/db/assert-settlement-chokepoint.test.ts`.
