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
