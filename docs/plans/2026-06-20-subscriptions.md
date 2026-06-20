# Plan — Subscriptions / recurring billing (SellRight, #2)

**Goal:** Sell recurring (monthly/yearly) plans via Stripe Billing that issue a license on the first paid invoice and extend that license's `expiresAt`/`updatesUntil` on every renewal — reusing the existing order → settle → license machinery, adding only the Stripe Billing wiring and a `subscription` link row.

**Architecture:** A subscription **is a SellRight order whose payment recurs.** Subscribing creates a `PendingPayment` order (one line, the recurring variant) + a Stripe **Checkout Session** (`mode:subscription`). The **first** `invoice.paid` settles that order through the existing `applyPaymentResult` (→ `Paid` → `issueLicensesForPaidOrder`), so the license is issued by the exact same code path as a one-time purchase. **Subsequent** `invoice.paid` events extend the issued license's entitlement dates. A new `subscription` row links our `order`/`license`/`customer` to the Stripe subscription. This is why `license.orderId`/`orderLineId` being `NOT NULL` is satisfied for free — there's always a real order.

**Visual Plan — subscription lifecycle**

```mermaid
flowchart TD
    sub["POST /v1/shop/subscribe {variantId}"] --> ord["create order (PendingPayment)\n+ Stripe Checkout Session (mode:subscription)\nsubscription_data.metadata = {storeId, orderCode, customerId}"]
    ord --> hosted["return hosted Checkout URL"]
    hosted --> css["webhook: checkout.session.completed"]
    css --> srow["upsert subscription row\n(status incomplete, link stripeSubscriptionId/customerId, orderId)"]
    srow --> inv1["webhook: invoice.paid\nbilling_reason = subscription_create"]
    inv1 --> settle["applyPaymentResult(order) -> Paid\n-> issueLicensesForPaidOrder ISSUES license"]
    settle --> link["subscription.licenseId = new license\nstatus=active, currentPeriodEnd"]
    link --> invN["webhook: invoice.paid\nbilling_reason = subscription_cycle"]
    invN --> ext["extendEntitlement(license):\nexpiresAt += licenseDurationDays\nupdatesUntil += updatesDurationDays"]
    inv1 -.payment_failed.-> pd["status past_due (no revoke — dunning)"]
    invN -.subscription.deleted.-> can["status canceled — license lapses at expiresAt"]
```

**Tech stack:** TypeScript, Hono + `@hono/zod-openapi`, Drizzle (Postgres `:5433`), Stripe Billing (`stripe` SDK, dual test/live mode — reuses `stripeClient(mode)`), Vitest (pure helpers + DB suite vs `sellright_test`; lifecycle via Stripe **Test Clocks** on the box). Admin: React + TanStack Query.

---

## ADR (decisions taken — defaults from `docs/SUBSCRIPTIONS-DESIGN.md`, accepted)
- **D1 Stripe Billing**, not a custom re-charge loop (dunning, SCA on renewals, hosted portal are worth the 0.5%).
- **D2 Checkout Session** (`mode:subscription`) for v1 (Stripe-hosted, handles SCA; Subscriptions-API/custom-UI later).
- **D3 Catalog model:** add `stripePriceId` + `billingInterval` to `product_variant`; **any variant with a `stripePriceId` is recurring.** Reuses the existing `licenseDurationDays`/`updatesDurationDays` for the per-cycle entitlement length.
- **D4 Renewal extends** `expiresAt` AND `updatesUntil` by the variant's duration days each paid cycle, stacking on the later of (current, now).
- **D5 Stripe Customer Portal** for self-serve cancel/update-card (one endpoint).
- **D6 Reuse** the dual-mode Stripe + the webhook tenant-resolver; subscription/invoice metadata carries `storeId`.
- **Decision (new, forced by `license.orderId NOT NULL`):** a subscription **always creates a backing order**; the first paid invoice settles it so license issuance is the *existing* code path, not a parallel one. **Riskiest assumption:** `subscription_data.metadata` propagates to every invoice's `subscription_details.metadata` (Stripe-documented) so `invoice.paid` can resolve `storeId` + the order. **Smallest test:** a Test-Clock cycle asserts invoice #2 carries the metadata and extends the license. **Blast radius:** additive (new table + columns + routes + webhook cases); no change to one-time checkout. **Reversibility:** additive migration; feature is dormant until a variant gets a `stripePriceId`.

---

## File map (all in `D:\Claude\sellright`)
| File | Change | Responsibility |
|---|---|---|
| `packages/api/src/db/schema.ts` | edit | new `subscription` table (+RLS) ; `product_variant.stripePriceId` + `billingInterval` |
| `packages/api/drizzle/<NNNN>_subscriptions.sql` | new | `subscription` table + FORCE RLS policy + 2 variant columns (hand-written + journal) |
| `packages/api/src/licensing/renewal.ts` | new | pure `extendEntitlement(current, durationDays, now)` |
| `packages/api/src/licensing/renewal.test.ts` | new | unit tests for `extendEntitlement` (stack / lapse / perpetual) |
| `packages/api/src/payments/stripe.ts` | edit | `createSubscriptionCheckout(mode, args)` + `createBillingPortal(mode, args)` |
| `packages/api/src/payments/subscriptions.ts` | new | webhook lifecycle: `onCheckoutCompleted`, `onInvoicePaid` (issue-or-extend), `onInvoiceFailed`, `onSubscriptionUpdated/Deleted`; non-route module (keeps `unsafeUnscopedDb`-free routes rule) |
| `packages/api/src/payments/webhook-reconcile.ts` | edit | extend `resolveStoreIdForStripeEvent` to read `invoice.subscription_details.metadata.storeId` + `checkout.session.metadata.storeId` |
| `packages/api/src/routes/payment-webhooks.ts` | edit | add cases: `checkout.session.completed`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.updated`, `customer.subscription.deleted` |
| `packages/api/src/routes/subscriptions.ts` | new | `POST /v1/shop/subscribe` (create order + Checkout Session) ; `POST /v1/shop/account/billing-portal` |
| `packages/api/src/routes/subscriptions.test.ts` | new | DB tests: subscribe creates order+session args; webhook issue-then-extend over two invoices |
| `packages/admin/src/pages/Subscriptions.tsx` | new | subscriptions list (status, customer, currentPeriodEnd) |
| `packages/admin/src/pages/CustomerDetail.tsx` | edit | show the customer's subscriptions |

---

## Task 1 — Schema: `subscription` table + variant recurring fields

**1a.** In `schema.ts`, add to `product_variant` (after `updatesDurationDays`, ~line 187):
```ts
    stripePriceId: text(),                 // null = not a recurring variant
    billingInterval: text(),               // 'month' | 'year' (informational; cycle driven by Stripe)
```

**1b.** Add the `subscription` table (mirror an existing store-scoped table's RLS — every store-scoped table gets FORCE RLS + the `store_id + app.current_store` policy; `rls-tables.test.ts` enforces this):
```ts
export const subscriptionStatus = pgEnum('subscription_status', ['incomplete', 'active', 'past_due', 'canceled']);

export const subscription = pgTable('subscription', {
  id: uuid().primaryKey().defaultRandom(),
  storeId: uuid().notNull().references(() => store.id),
  customerId: uuid().references(() => customer.id),
  orderId: uuid().references(() => order.id),          // the backing order (set at creation)
  licenseId: uuid().references(() => license.id),      // null until the first paid invoice issues it
  stripeSubscriptionId: text().notNull().unique(),
  stripeCustomerId: text(),
  priceId: text(),
  status: subscriptionStatus().notNull().default('incomplete'),
  currentPeriodEnd: timestamp({ withTimezone: true }),
  cancelAtPeriodEnd: boolean().notNull().default(false),
  createdAt: ts(),
  updatedAt: ts(),
});
```

**1c.** Hand-write `drizzle/<NNNN>_subscriptions.sql` (plain `db:generate` mis-fires on snapshot drift — same as 0032/0033): the `CREATE TYPE subscription_status`, `CREATE TABLE subscription`, `ALTER TABLE subscription ENABLE ROW LEVEL SECURITY; ALTER TABLE subscription FORCE ROW LEVEL SECURITY;` + the `CREATE POLICY ... USING (store_id = current_setting('app.current_store', true)::uuid) WITH CHECK (...)` (copy the exact policy shape from an existing table's migration), and `ALTER TABLE product_variant ADD COLUMN stripe_price_id text, ADD COLUMN billing_interval text;`. Add the `_journal.json` entry. **Verify** the new table is NOT in `EXEMPT` in `rls-tables.test.ts` so the RLS loop covers it (it isn't — good; the loop will assert it).

---

## Task 2 — Pure renewal helper (red→green)

**2a.** `packages/api/src/licensing/renewal.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { extendEntitlement } from './renewal.js';
const NOW = new Date('2026-06-20T00:00:00Z');
describe('extendEntitlement', () => {
  it('perpetual (null duration) stays perpetual', () => expect(extendEntitlement(new Date(), null, NOW)).toBeNull());
  it('renews from current period end when still active (stacks)', () => {
    const cur = new Date('2026-07-01T00:00:00Z');
    expect(extendEntitlement(cur, 30, NOW)).toEqual(new Date('2026-07-31T00:00:00Z'));
  });
  it('renews from now when lapsed (current in the past)', () => {
    const cur = new Date('2026-06-01T00:00:00Z');
    expect(extendEntitlement(cur, 30, NOW)).toEqual(new Date('2026-07-20T00:00:00Z'));
  });
  it('first issue (null current) starts from now', () => {
    expect(extendEntitlement(null, 30, NOW)).toEqual(new Date('2026-07-20T00:00:00Z'));
  });
});
```

**2b.** `packages/api/src/licensing/renewal.ts`:
```ts
/** Extend a subscription entitlement by one cycle. Stacks on the later of the
 *  current end or now, so renewing early adds time and renewing after a lapse
 *  restarts from now. null duration = perpetual (nothing to extend). */
export function extendEntitlement(current: Date | null, durationDays: number | null, now = new Date()): Date | null {
  if (durationDays == null) return null;
  const base = current && current.getTime() > now.getTime() ? current : now;
  return new Date(base.getTime() + durationDays * 86_400_000);
}
```

---

## Task 3 — Stripe helpers (Checkout Session + Portal)
In `packages/api/src/payments/stripe.ts`, add (use the existing `stripeClient(mode)`):
```ts
export async function createSubscriptionCheckout(mode: StripeMode, args: {
  priceId: string; successUrl: string; cancelUrl: string;
  customerEmail?: string; metadata: Record<string, string>; // {storeId, orderCode, customerId?}
}): Promise<{ url: string; sessionId: string }> {
  const stripe = stripeClient(mode);
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: args.priceId, quantity: 1 }],
    success_url: args.successUrl,
    cancel_url: args.cancelUrl,
    customer_email: args.customerEmail,
    // top-level subscription metadata PROPAGATES to every invoice.subscription_details.metadata
    subscription_data: { metadata: args.metadata },
    metadata: args.metadata, // also on the session for checkout.session.completed
  });
  if (!session.url) throw new Error('stripe did not return a checkout url');
  return { url: session.url, sessionId: session.id };
}

export async function createBillingPortal(mode: StripeMode, args: { customerId: string; returnUrl: string }): Promise<string> {
  const stripe = stripeClient(mode);
  const ps = await stripe.billingPortal.sessions.create({ customer: args.customerId, return_url: args.returnUrl });
  return ps.url;
}
```

---

## Task 4 — Tenant resolution for subscription/invoice events (DB-primary, not metadata-dependent)

**Jury P0 fix:** do NOT make tenant resolution depend on Stripe propagating `subscription_data.metadata` to invoices. The reliable anchor is **our own `subscription` row**, which `checkout.session.completed` always creates from `session.metadata.storeId` (metadata *we* set on a session object *we* created — no propagation assumption). Resolution order for subscription/invoice events:

1. `session.metadata.storeId` (for `checkout.session.completed`) — always present, validated UUID.
2. our `subscription` row by `stripeSubscriptionId = invoice.subscription` → `storeId` (works for every invoice once the subscription row exists).
3. `invoice.subscription_details.metadata.storeId` (bonus, if Stripe propagated it).
4. **unresolvable → return 5xx so Stripe RETRIES** (Stripe retries with backoff up to ~3 days). The only window where 1–3 all miss is `invoice.paid` arriving *before* `checkout.session.completed` AND with no propagated metadata; the retry resolves it once the session event lands. This removes the metadata-propagation assumption from the critical path entirely.

```ts
// webhook-reconcile.ts — new resolver used by subscription/invoice cases:
export async function resolveStoreIdForSubscriptionEvent(obj: {
  metadata?: { storeId?: string | null } | null;            // checkout.session
  subscription?: string | { id?: string } | null;           // invoice.subscription
  subscription_details?: { metadata?: { storeId?: string | null } | null } | null;
}): Promise<string | null> {
  const m = obj.metadata?.storeId;
  if (m && UUID.test(m)) return m;
  const subId = typeof obj.subscription === 'string' ? obj.subscription : obj.subscription?.id;
  if (subId) {
    const [row] = await unsafeUnscopedDb.select({ storeId: s.subscription.storeId })
      .from(s.subscription).where(eq(s.subscription.stripeSubscriptionId, subId)).limit(1);
    if (row?.storeId && UUID.test(row.storeId)) return row.storeId;
  }
  const sm = obj.subscription_details?.metadata?.storeId;
  return sm && UUID.test(sm) ? sm : null;
}
```
The route returns **5xx (not 200) when this returns null for a subscription/invoice event** so the delivery is retried (idempotency makes the retry safe). One-time payment/refund/dispute resolution is unchanged (still `resolveStoreIdForStripeEvent`).

---

## Task 5 — Webhook lifecycle module (`packages/api/src/payments/subscriptions.ts`)
Non-route module (so routes stay free of raw tenant lookups). All functions take `(tx, storeId, event-object)`; the route claims idempotency + `withStore` (existing pattern in `payment-webhooks.ts`). Core logic:
- **`onCheckoutCompleted(tx, storeId, session)`** — upsert `subscription` by `stripeSubscriptionId` (status `incomplete`), set `stripeCustomerId`, `priceId`, `orderId` (from `session.metadata.orderCode` → order lookup), `customerId`.
- **`onInvoicePaid(tx, storeId, invoice)`** — **create-or-find** the `subscription` (P1: Stripe events are NOT ordered, so `invoice.paid` may arrive before `checkout.session.completed`; resolve the backing order from `invoice.subscription_details.metadata.orderCode` and upsert the row by `stripeSubscriptionId` if absent — never assume checkout.session.completed ran first). Then: if `licenseId` is null (first cycle / `billing_reason==='subscription_create'`): settle the backing order via `applyPaymentResult` with a **synthesized** `PaymentResult { state:'Settled', providerRef: invoice.payment_intent ?? invoice.id, metadata:{ stripeInvoiceId } }` — which runs the existing `issueLicensesForPaidOrder`; then read back the new license for that order and set `subscription.licenseId`. Else (`subscription_cycle`): look up the license's variant durations (`license.orderLineId → orderLine.variantId → productVariant.{licenseDurationDays,updatesDurationDays}`) and `tx.update(license)` with `extendEntitlement(license.expiresAt, licenseDurationDays)` + `extendEntitlement(license.updatesUntil, updatesDurationDays)`. Always set `status='active'`, `currentPeriodEnd = invoice.lines.data[0].period.end` (verify field at impl), write an `auditLog` row. **Idempotency** is the route's `event.id` claim AND, for the issue branch, `issueLicensesForPaidOrder`'s own per-orderLine guard (a duplicate `invoice.paid` re-settle is a no-op because the order is already `Paid` and the license already exists). **Amount source of truth (P1):** the backing order's `grandTotal` is set from the variant price at creation and must equal the Stripe price amount; record `invoice.amount_paid` in the payment metadata for reconciliation, and treat **Stripe as the authority for *whether* money moved** (we only settle on `invoice.paid`) while our order total stays the catalog price. A drift between variant price and Stripe price is an operator misconfiguration — surfaced by the reconciliation field, not silently trusted.
- **`onInvoiceFailed`** — `status='past_due'`; do NOT revoke (dunning).
- **`onSubscriptionUpdated`** — sync `status`, `cancelAtPeriodEnd`, `currentPeriodEnd`.
- **`onSubscriptionDeleted`** — `status='canceled'`; leave the license to lapse at `expiresAt` (do not revoke immediately).

(Full function bodies follow the `webhook-reconcile.ts` style: small, `tx`-scoped, drizzle `select/update/insert`. Written at implementation time against the exact Stripe field names.)

---

## Task 6 — Routes (`packages/api/src/routes/subscriptions.ts`)
Mirror the shop/account route patterns:
- **`POST /v1/shop/subscribe`** `{ variantId }` — **requires auth** (P2: a recurring plan needs a `customerId` for license ownership + a `stripeCustomerId` for the portal; guest subscriptions are out of scope for v1). Require the variant has a `stripePriceId` (else 400). Create a `PendingPayment` order with one line for that variant. **Dependency to verify at impl (P2):** a server-side single-variant order-creation helper must be reusable here; if the existing order creation is welded to the cart/checkout request, extract a small `createOrderForVariant(tx, {storeId, customerId, variantId})` first. Then `createSubscriptionCheckout(mode, { priceId, customerEmail, metadata:{storeId, orderCode, customerId}, success/cancel urls from shop config })`; return `{ url }`.
- **`POST /v1/shop/account/billing-portal`** (auth required) → look up the customer's `stripeCustomerId` from their latest `subscription`; `createBillingPortal` → return `{ url }`.

## Task 7 — Webhook route wiring (`payment-webhooks.ts`)
Add the five `case`s to the existing `switch (event.type)` inside the `withStore` block (after the mode-bind + idempotency claim), each delegating to the Task-5 functions. `checkout.session.completed` + `invoice.*` + `customer.subscription.*`.

## Task 8 — Admin UI
- `Subscriptions.tsx`: list (mirror `Orders.tsx` list scaffolding) — columns: status badge, customer email, plan (priceId/appKey), `currentPeriodEnd`, `cancelAtPeriodEnd`. Read `GET /v1/admin/subscriptions` (add a thin admin list route mirroring the orders list).
- `CustomerDetail.tsx`: a "Subscriptions" section for that customer.

## Task 9 — Tests
- **Pure:** `renewal.test.ts` (Task 2) ✓.
- **DB (`subscriptions.test.ts`, vs `sellright_test`):** (1) `subscribe` creates a PendingPayment order + returns checkout args with the right metadata (mock the Stripe client); (2) simulate `checkout.session.completed` → subscription row `incomplete`; (3) simulate `invoice.paid` (subscription_create) → order `Paid`, a license issued, `subscription.licenseId` set, status `active`; (4) simulate a second `invoice.paid` (subscription_cycle) → the SAME license's `expiresAt`/`updatesUntil` advanced by the variant duration (no new license); (5) `invoice.payment_failed` → `past_due`, license untouched.
- **Live (box, manual):** Stripe **Test Clock** drives a real create→renew→cancel cycle against `sellright_test`.

---

## Self-review
- **Spec coverage:** create flow ✓ (Task 6), issue-on-first-invoice via existing settle ✓ (Task 5), extend-on-renewal ✓ (Tasks 2+5), dunning/cancel ✓ (Task 5), portal ✓ (Tasks 3+6), admin ✓ (Task 8), tenant resolution ✓ (Task 4), schema+RLS ✓ (Task 1). 
- **Reuse:** issuance is the *existing* `issueLicensesForPaidOrder` (no duplicate license logic); dual-mode Stripe + idempotency + `withStore` are the *existing* webhook spine.
- **Riskiest assumption** (metadata propagation to invoices) is pinned by Task 9 case (4) + the box Test-Clock run.
- **RLS:** `subscription` is store-scoped with FORCE RLS; `rls-tables.test.ts` will assert it automatically (not in EXEMPT).

## Review gates
- **/council:** REFINE → fixed (event-ordering create-or-find, amount source-of-truth, auth on /subscribe, PaymentResult synthesis, order-helper extraction flagged).
- **/jury jury-plan (3 jurors):** NEEDS-REVISION (avg 5.7) → resolved:
  - *Riskiest-assumption/metadata-propagation + no-fallback + missing-metadata* → **Task 4 redesigned**: tenant resolved from OUR `subscription` row (linked by `checkout.session.completed`'s session metadata we control), invoice-metadata demoted to bonus, unresolvable → **5xx retry**. The plan no longer collapses if propagation fails — it never depends on it. Validatable in plain Stripe test mode (no Test Clocks): a unit/DB test feeds an `invoice.paid` with empty metadata + a known `stripeSubscriptionId` and asserts resolution via the DB row.
  - *invoice-before-checkout not validated* → **Task 9 case added**: deliver `invoice.paid` with NO prior subscription row → assert create-or-find creates it + issues the license; then a duplicate delivery is a no-op (idempotency).
  - *amount drift no reconciliation* → `onInvoicePaid` writes an `auditLog` `subscription_amount_mismatch` row when `invoice.amount_paid !== order.grandTotal` (operator-visible; not silently trusted).
  - *no webhook monitoring* → every subscription event writes an `auditLog` row (actor `stripe:webhook`, action, sub id, outcome); at one-operator scale that + Stripe's own failed-webhook dashboard is the monitor. A metrics counter is deferred (named, not neglected).
  - *migration no rollback* → the `<NNNN>_subscriptions.sql` ships a commented `-- DOWN` block: `DROP TABLE subscription; DROP TYPE subscription_status; ALTER TABLE product_variant DROP COLUMN stripe_price_id, DROP COLUMN billing_interval;`.
  - *alternative not considered* → ADR notes the rejected alternative (custom re-charge loop / nullable license.orderId parallel path); backing-order reuse wins on correctness + reuse.

### Critical Files for Implementation
- `packages/api/src/db/schema.ts` (subscription table + variant fields — migration root)
- `packages/api/src/payments/subscriptions.ts` (issue-then-extend lifecycle — the heart)
- `packages/api/src/licensing/renewal.ts` (the pure extension math)
- `packages/api/src/routes/payment-webhooks.ts` (lifecycle wiring + idempotency)
- `packages/api/src/routes/subscriptions.ts` (subscribe + portal)
