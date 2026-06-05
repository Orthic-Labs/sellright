# E-commerce Backend Research → SellRight Architecture (2026-06)

> **Method.** Web research (June 2026) across the subsystems SellRight actually
> uses: multi-tenant Postgres RLS, monolith-vs-microservices/composable, API
> idempotency, the transactional-outbox / dual-write problem, payment-webhook
> reliability, inventory reservation/oversell, and Postgres scaling. Sources are
> cloud-vendor prescriptive guidance (AWS), primary vendor engineering (Stripe),
> recent (2025–2026) engineering write-ups, and one peer-reviewed-style paper.
> Peer-reviewed literature on *applied* commerce-backend patterns is thin —
> idempotency, outbox, and RLS multi-tenancy are **industry patterns**, not
> academic results — so the strongest evidence is authoritative engineering
> guidance, which is what's cited here. Every recommendation is tagged
> **[aligned]** (we already do this), **[small change]**, or **[v2]**.

---

## 1. Multi-tenant isolation (PostgreSQL RLS)

**What the research says.** AWS's prescriptive guidance is unambiguous: **the
application must connect as a NON-owner role**, because "if your application code
connects to the database as the same PostgreSQL role as the table owner… your
security policies aren't in effect by default" — the owner bypasses RLS unless
the table is `FORCE`d. Tenant context is set via a **runtime session variable**
(`current_setting('app.current_tenant')`) at connection-acquire time, *not*
per-tenant DB users. Two caveats: (a) `BYPASSRLS`/superuser roles ignore policies;
(b) **session variables "may be incompatible with server-side connection pooling
such as pgBouncer"** unless you verify how it shares session state.

**SellRight today.** Exactly this model: `app.current_store` GUC, fail-closed
`nullif(...)::uuid`, `FORCE` on every store-scoped table, registry tables `NO
FORCE`. **But the app currently connects as the table owner** (dev), so isolation
rests entirely on `FORCE` being present everywhere.

**Recommendations.**
- **[small change — already gate item 1]** Run the app as a dedicated **non-owner
  login role**. This is the *canonical* AWS pattern, not just our internal
  conclusion — three independent reviews + the cloud-vendor reference agree.
- **[small change]** **PgBouncer compatibility is a real constraint to design for
  now.** SellRight's `withStore()` uses **`SET LOCAL app.current_store` inside a
  transaction** — this is **safe with PgBouncer transaction-pooling mode** (the
  GUC is scoped to the txn and reset at commit). *Session-level* `SET` would
  break under transaction pooling. So: keep the `SET LOCAL`-in-txn discipline,
  and when PgBouncer lands (§7), use **transaction** pooling mode and never set
  the store GUC outside a transaction. Document this as a hard rule.
- **[aligned]** Keep registry tables `NO FORCE`; keep the planned `pnpm verify`
  assertion that every `store_id` table has `FORCE` (defense-in-depth even once
  the non-owner role makes a miss fail-closed).

Sources: [AWS — Multi-tenant RLS](https://aws.amazon.com/blogs/database/multi-tenant-data-isolation-with-postgresql-row-level-security/) ·
[Nile — Shipping multi-tenant SaaS with RLS](https://www.thenile.dev/blog/multi-tenant-rls) ·
[Mastering Postgres RLS for multi-tenancy](https://ricofritzsche.me/mastering-postgresql-row-level-security-rls-for-rock-solid-multi-tenancy/)

---

## 2. Monolith vs microservices vs composable

**What the research says.** The 2025–2026 correction is real: enterprises are
**returning to modular monoliths / "moduliths"** because microservices bring
"high coordination, deployment, and security costs." For commerce specifically,
the "composable/MACH" wave produced a documented **"composable regret"** — going
fully composable without platform-engineering maturity *multiplied* integration
backlogs, and **mid-market composable TCO runs 100–200% higher** than a well-run
platform. Guidance now: composable only wins past ~15 integrations + a dedicated
platform team + multi-brand/region scale.

**SellRight today.** Modular monolith, single deployable API, from-scratch. A
solo operator running two brands.

**Recommendations.**
- **[aligned]** The **modular-monolith + from-scratch** choice is *exactly* what
  current research endorses for this scale — the council's "use Medusa/microservices"
  suggestions run against the 2025–2026 evidence. This strengthens the
  "non-goals" section: cite the composable-regret/TCO data as the rationale, so
  the decision is evidence-backed, not just preference.
- **[v2 awareness]** Keep clean internal module boundaries (you already have:
  `routes/`, `money/`, `payments/`, `import/`, `manifest/`) so that *if* one
  component ever needs independent scaling, it can be extracted — modulith-first,
  extract-on-evidence, never microservices-by-default.

Sources: [foojay — Monolith vs Microservices 2025](https://foojay.io/today/monolith-vs-microservices-2025/) ·
[fabric — Monolith vs Microservices for e-commerce](https://fabric.inc/blog/commerce/monolith-vs-microservices) ·
[Bitcot — Composable vs MACH (TCO / regret)](https://www.bitcot.com/composable-commerce-vs-mach-architecture/) ·
[ResearchGate — Decomposing E-Commerce Monoliths (paper)](https://www.researchgate.net/publication/395258758_Microservices_Architecture_Decomposing_E-Commerce_Monoliths_into_Scalable_Independent_Services)

---

## 3. API idempotency (the Stripe pattern)

**What the research says.** Stripe's canonical design: **client generates a UUID
per intent**, sends it in an `Idempotency-Key` header on mutating POSTs; the
server promises "same key → same response." The key fix for partial failures:
**record the external side effect inside the same DB transaction as the key
claim.** Keys live in a **shared** store (so multiple servers agree) with a TTL ≥
the retry window (Stripe: 24 h).

**SellRight today.** `pay` is idempotent via `processed_event` keyed on an
`idempotency-key` header (claim-before-side-effect, in-txn). **Checkout
(order-creation) is NOT idempotency-keyed** — a retried/duplicated checkout POST
could create a second order.

**Recommendations.**
- **[small change]** Extend the **`Idempotency-Key` header to `/v1/shop/checkout`**
  (and any mutating admin POST that matters), reusing the existing
  `processed_event` claim-in-txn mechanism. The storefront generates the key once
  per checkout attempt. Closes the "double-submit creates two orders" gap and
  matches the Stripe-canonical contract we already half-implement.
- **[aligned]** Claim-before-side-effect in the same txn — `pay` already does
  this; apply the same shape to checkout.

Sources: [Stripe — Designing robust APIs with idempotency](https://stripe.com/blog/idempotency) ·
[Designing idempotent API endpoints for payments](https://medium.com/@akash22675/designing-idempotent-api-endpoints-for-payments-16845cc1079e)

---

## 4. The dual-write problem & transactional outbox

**What the research says.** When a service commits state **and** must publish an
event/notify another system, doing them as two operations risks the **dual-write
problem** (commit succeeds, publish crashes → divergence). The fix is the
**transactional outbox**: write the domain change *and* an outbox row in the same
DB transaction, then a relay publishes from the outbox. It guarantees
**at-least-once** (not exactly-once), so **consumers must be idempotent** (an
inbox/dedup table of processed event IDs). Relay options: **polling** (simpler,
higher latency — right for low volume) vs **CDC/Debezium** (high throughput,
complex). Cost: every business write now also writes an outbox row.

**SellRight today.** No event bus yet, but three planned seams are exactly
dual-writes: (a) the **SSE cache-invalidation** channel (DB change → notify
edge/CDN), (b) the **BullMQ job** layer (emails, recovery, settlement), and (c)
the **Regime-B SellRight→Vendure reconciliation exporter** in the cutover plan.
We already have the *inbox* half — `processed_event`.

**Recommendations.**
- **[v2]** When SSE/BullMQ land, use a **DB-backed `outbox` table + a polling
  relay** — *not* Kafka/Debezium. For a modular monolith at this volume, polling
  is the documented right choice; it avoids the CDC tooling tax and reuses
  Postgres. The existing `processed_event` table is the matching inbox.
- **[small change]** Frame the **cutover reconciliation exporter** (roadmap §3A
  Regime B) as an outbox consumer: orders/payments written on SellRight emit
  outbox rows; the exporter drains them into Vendure. Same mechanism, reused.
- **[aligned]** Keep treating "exactly-once" as "at-least-once + idempotent
  consumer" — never claim true exactly-once.

Sources: [Transactional Outbox — trade-offs (2025)](https://www.softwarecraftsperson.com/posts/2025-10-08-transactional-outbox-pattern/) ·
[microservices.io — Transactional outbox](https://microservices.io/patterns/data/transactional-outbox.html) ·
[AWS — Transactional outbox pattern](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html)

---

## 5. Payment-webhook reliability

**What the research says.** Layer three defenses: **"retries handle minutes,
replay handles hours, reconciliation handles everything else."** Concretely:
return **2xx within ~20 s** (Stripe marks late as failed) — verify signature,
then **process async** via a queue; handler must be **idempotent** (dedup on
event ID); use **exponential backoff + jitter + a dead-letter queue**; run a
**periodic reconciliation cron** against the provider API (Stripe keeps events
~30 days) to catch missed webhooks; log every webhook to a queryable store; track
SLOs (delivery %, p95/p99 latency, queue depth, dedup hits).

**SellRight today.** No real gateway yet; the roadmap (post-Codex) already added
retry-safe webhooks + verify-fallback + daily reconciliation to gate item 5.

**Recommendations.**
- **[aligned + small change]** Gate item 5 is on the right track. Add the
  specifics this research makes concrete: **2xx-fast then async** (don't do
  fulfillment work inside the webhook request), **DLQ** for exhausted retries
  with safe replay, **signature + timestamp-window verification**, and **log
  every webhook** to the same observability sink as gate item 6.
- **[aligned]** Daily provider↔`payment` reconciliation (already added) is the
  "handles everything else" layer — keep it.

Sources: [Hookdeck — Webhooks at scale](https://hookdeck.com/blog/webhooks-at-scale) ·
[Stripe webhook reliability patterns (2025)](https://dev.to/diven_rastdus_c5af27d68f3/stripe-webhook-reliability-patterns-every-saas-should-implement-2pg1) ·
[Handling payment webhooks reliably](https://medium.com/@sohail_saifii/handling-payment-webhooks-reliably-idempotency-retries-validation-69b762720bf5)

---

## 6. Inventory reservation & oversell prevention

**What the research says.** The **soft-reservation** pattern is standard: track
**available vs reserved** separately; reserve at checkout, then **commit or
release** on payment outcome. Concurrency control via **optimistic locking with a
version column**, or serialize hot SKUs through a broker. There is an inherent
**consistency-vs-performance trade-off** — stronger guarantees cost latency.
SAGA-style flows reserve → pay → commit/compensate.

**SellRight today.** **Already the soft-reservation model**: `stock.on_hand` vs
`stock.allocated`, atomic allocation at checkout via a conditional `UPDATE`,
release on cancel, and (just verified) **consume on ship** (on_hand−, allocated−).
This is the recommended pattern, already built and tested.

**Recommendations.**
- **[aligned]** The on_hand/allocated split + conditional-UPDATE allocation is
  exactly the soft-reservation pattern — no change needed to the model.
- **[small change]** Add the **reservation-expiry** half explicitly: an
  abandoned `PendingPayment` order holds `allocated` forever today. A scheduled
  job (the planned BullMQ layer) should **release allocations for stale unpaid
  orders** after a timeout — the "release" arm of reserve→commit/release. The
  rulebook already calls for "allocate at order-creation + release on timeout";
  this research confirms it and it's not yet built.
- **[v2]** If a single hot SKU ever sees true contention (drops), add an
  **optimistic-locking version column** on `stock` or serialize that SKU; not
  needed at current volume.

Sources: [Inventory reservation in the SAGA pattern (e-commerce)](https://dev.to/jackynote/managing-inventory-reservation-in-saga-pattern-for-e-commerce-systems-2d14) ·
[Queue-it — Why sites oversell & how to avoid it](https://queue-it.com/blog/overselling/) ·
[System Design Handbook — Inventory management](https://www.systemdesignhandbook.com/guides/design-inventory-management-system/)

---

## 7. PostgreSQL scaling for commerce

**What the research says.** **Connection pooling is the highest-ROI change** —
PgBouncer multiplexes thousands of clients onto a small backend pool (OpenAI
reported 50 ms→5 ms connection time). **Partition large tables by time range** in
the 100 GB–1 TB phase (orders-by-month is the textbook case). Write-heavy tuning:
**autovacuum/VACUUM** matters (dead rows eat 10–30 % CPU/IO), WAL tuning,
async-processing offload. **Don't shard or add read-replicas to fix a
connection/write problem** — match the fix to the actual bottleneck.

**SellRight today.** One shared `pg.Pool`, no PgBouncer, no partitioning; browse
load already offloaded to the static catalog manifest (no DB on home/shop/PDP).
13.5 k orders today — nowhere near the partitioning threshold.

**Recommendations.**
- **[small change, when traffic warrants]** Add **PgBouncer in transaction-pooling
  mode** as the first scaling lever — compatible with our `SET LOCAL`-in-txn store
  GUC (see §1). Highest ROI, low effort.
- **[v2]** Partition the **`order` / `order_line`** tables by time **only at the
  100 GB–1 TB phase** — premature now. Add the hot-path indexes
  (`order(store_id,state,created_at)`, `order(customer_id)`,
  `product(store_id,name)`) *before* admin lists get slow — that's the near-term
  win.
- **[aligned]** Static-manifest browse path already removes the read-heavy
  workload from Postgres — a good structural decision the research validates
  (offload, don't scale, what you can).
- **[v2]** Tune **autovacuum** on the high-write tables (`order`, `order_line`,
  `stock_movement`, `cart_line`) before real volume.

Sources: [PlanetScale — Scaling Postgres connections with PgBouncer](https://planetscale.com/blog/scaling-postgres-connections-with-pgbouncer) ·
[VeloDB — 7 ways to scale PostgreSQL](https://www.velodb.io/glossary/ways-to-scale-postgresql) ·
[Percona — PgBouncer connection pooling](https://www.percona.com/blog/pgbouncer-for-postgresql-how-connection-pooling-solves-enterprise-slowdowns/)

---

## 8. Net recommendations for SellRight (prioritized)

| # | Change | Type | Where |
|---|---|---|---|
| 1 | Run app as **non-owner DB role** + `FORCE` assertion (canonical AWS pattern) | small change | gate item 1 |
| 2 | **`Idempotency-Key` on `/v1/shop/checkout`** (reuse `processed_event`) | small change | new — pre-launch |
| 3 | **Reservation-expiry job** — release `allocated` on stale unpaid orders | small change | rulebook gap; BullMQ |
| 4 | Webhook: **2xx-fast → async + DLQ + signature/timestamp verify + log** | small change | gate item 5 detail |
| 5 | **PgBouncer (transaction pooling)** as first scaling lever; `SET LOCAL`-only store GUC | small change | §3A scalability |
| 6 | Hot-path **indexes** on order/product before lists slow | small change | §3A scalability |
| 7 | **Outbox table + polling relay** for SSE/BullMQ/cutover-exporter (not Kafka) | v2 | §3.13, §4, §3A Regime B |
| 8 | Partition `order`/`order_line` by time; autovacuum tuning | v2 (100 GB+) | §3A scalability |
| 9 | Cite **composable-regret/TCO** evidence in the from-scratch/non-microservices non-goal | doc | §0 non-goals |

**Already validated, no change:** the RLS model, soft-reservation inventory
(on_hand/allocated), claim-in-txn idempotency on `pay`, modular-monolith +
from-scratch choice, and the static-manifest browse offload are all *exactly* what
current research recommends. The newest data mostly **confirms** the architecture
and sharpens five small, pre-launch changes (1–6) plus three v2 items (7–8) and
one evidence citation (9).

---

## 9. Sources (full list)

**RLS / multi-tenancy:**
https://aws.amazon.com/blogs/database/multi-tenant-data-isolation-with-postgresql-row-level-security/ ·
https://www.thenile.dev/blog/multi-tenant-rls ·
https://ricofritzsche.me/mastering-postgresql-row-level-security-rls-for-rock-solid-multi-tenancy/

**Architecture (monolith / composable):**
https://foojay.io/today/monolith-vs-microservices-2025/ ·
https://fabric.inc/blog/commerce/monolith-vs-microservices ·
https://www.bitcot.com/composable-commerce-vs-mach-architecture/ ·
https://www.researchgate.net/publication/395258758_Microservices_Architecture_Decomposing_E-Commerce_Monoliths_into_Scalable_Independent_Services

**Idempotency:**
https://stripe.com/blog/idempotency ·
https://medium.com/@akash22675/designing-idempotent-api-endpoints-for-payments-16845cc1079e

**Outbox / dual-write:**
https://www.softwarecraftsperson.com/posts/2025-10-08-transactional-outbox-pattern/ ·
https://microservices.io/patterns/data/transactional-outbox.html ·
https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html

**Payment webhooks:**
https://hookdeck.com/blog/webhooks-at-scale ·
https://dev.to/diven_rastdus_c5af27d68f3/stripe-webhook-reliability-patterns-every-saas-should-implement-2pg1 ·
https://medium.com/@sohail_saifii/handling-payment-webhooks-reliably-idempotency-retries-validation-69b762720bf5

**Inventory:**
https://dev.to/jackynote/managing-inventory-reservation-in-saga-pattern-for-e-commerce-systems-2d14 ·
https://queue-it.com/blog/overselling/ ·
https://www.systemdesignhandbook.com/guides/design-inventory-management-system/

**Postgres scaling:**
https://planetscale.com/blog/scaling-postgres-connections-with-pgbouncer ·
https://www.velodb.io/glossary/ways-to-scale-postgresql ·
https://www.percona.com/blog/pgbouncer-for-postgresql-how-connection-pooling-solves-enterprise-slowdowns/

> Citation note: these are authoritative engineering / cloud-vendor / primary-vendor
> sources, not peer-reviewed papers (applied commerce-backend patterns live in
> industry practice, not academia). URLs captured from live search June 2026.
