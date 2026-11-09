# Data retention & GDPR erasure notes

## Account deletion (`DELETE /v1/shop/account`)

On self-service erasure the handler (`packages/api/src/routes/account.ts`):

- hard-deletes: addresses, sessions, customer_token rows, payment methods, the
  customer row itself.
- anonymizes: orders (customerId, shipping/billing address snapshot nulled —
  financial records are kept for accounting but scrubbed of PII), gift cards /
  promotion usage / subscriptions / licenses (customerId nulled, record kept),
  `email_outbox` rows addressed to the customer's email (recipient + payload
  scrubbed, row kept for delivery/ops history).
- deletes: `subscriber` rows (newsletter/waitlist/restock opt-ins) matching the
  customer's email — these are independent, email-keyed marketing consent
  records, not derived from the customer row, so they don't get cleaned up for
  free by cascading deletes and must be erased explicitly.

## `audit_log` — retained, not erased

`audit_log` rows (admin actions: refunds, cancellations, settings changes,
staff/permission edits, etc.) are **not** scrubbed or deleted by account
erasure, and this is intentional, not an oversight:

- The data subject of an audit_log entry is typically the **admin/staff actor**
  performing the action, not the shopper. Where a shopper's email appears
  (e.g. inside an action's `data` payload), it is incidental context for a
  security/accounting record, not the record's subject.
- Retention is justified under **legitimate interest** (GDPR Art. 6(1)(f)):
  fraud investigation, dispute/chargeback defense, financial audit trail, and
  abuse of admin privileges all require an audit trail that admins themselves
  cannot cause to disappear (including indirectly, by having a customer
  request erasure).
- If a specific jurisdiction's DPA guidance requires redacting shopper PII from
  historical audit_log payloads on request, do that as a targeted, logged
  redaction of the affected `data` field(s) — never a blanket delete of the
  audit trail.

No code change accompanies this note; it documents the existing, deliberate
scope of `DELETE /v1/shop/account`.

## Retention periods by table (2026-11-09 audit, DB-M1 / DB-M2 / DB-M6)

Deleted by a scheduled job (batched, oldest first, hourly; each job can be switched to a dry run with its `*_APPLY=0`):

| Table | What is kept | Deleted after | Job |
|---|---|---|---|
| `session` | Hashed session tokens (shopper and admin) | 7 days after `expires_at`; imported legacy sessions as soon as `legacy_expires_at` has passed | `session-reaper` (`JOBS_SESSION_REAPER_APPLY`) |
| `email_outbox` | Full email payload and recipient address | `sent` after 30 days; `dead` (gave up) after 90 days; pending and processing never | `outbox-retention` (`JOBS_OUTBOX_RETENTION_APPLY`) |
| `push_outbox` | Device token and push payload | `sent` after 30 days; `dead` after 90 days | `outbox-retention` |
| `webhook_delivery` | Event payload sent to a merchant endpoint | `delivered` after 30 days; `failed` (dead) after 90 days | `outbox-retention` |
| `edge_purge_pending` | URLs queued for a Cloudflare purge | Deleted when the purge succeeds; `dead` rows after 30 days | `cache-purge-drain` |

Account erasure still scrubs `email_outbox` rows addressed to the customer immediately (see above), independent of the
30/90-day windows.

Kept indefinitely **on purpose** (no delete job, and none should be added without a separate decision):

| Table | Why it is kept | Growth today (2026-11-09) |
|---|---|---|
| `audit_log` | Admin action trail for fraud, dispute and financial audit (see the section above) | Largest: Damned, 870 rows, 384 kB |
| `payment_attempt` | Gateway attempt ledger behind every payment, refund and dispute: financial record | Small |
| `gateway_event` | Verified provider webhook events, the evidence for payment state changes and disputes | Small |
| `stock_movement` | Append-only inventory ledger; stock counts are reconcilable only with the full history | Small |
| `storekit_event` | Licensing/entitlement event log; the evidence for entitlement grants and reversals | Small |

Financial records (orders, payments, refunds) follow the merchant's accounting retention duty and are anonymised, not
deleted, on erasure. Revisit an archive job for any of the five tables above only when its size warrants it (growth
review: the database report's table sizes, re-read each audit); an archive must move rows to cold storage, never drop them.
