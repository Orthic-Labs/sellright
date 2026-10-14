# Data retention & GDPR erasure notes

## Account deletion (`DELETE /v1/shop/account`)

The request needs a signed-in customer whose email is verified (otherwise 403 `EMAIL_NOT_VERIFIED`). It returns 409 `ACTIVE_SUBSCRIPTION_EXISTS` while the customer has a subscription that is not canceled. Otherwise the handler (`packages/api/src/routes/account.ts`) makes these changes in one database transaction:

- hard-deletes: addresses, sessions, customer_token rows, payment methods,
  loyalty ledger rows (points are forfeited), product reviews written by the
  customer (matched by customer id or author email), the customer row itself.
- anonymizes: orders (customerId and the shipping/billing address snapshots
  nulled, an `anonymized_at` marker added to the order metadata, and the address
  snapshots and reason removed from the order's `order_edit` rows; the order
  record is kept for accounting, and the handler does not remove
  `metadata.contact.email`), orders linked to the account only by an unproven
  email match (customerId nulled, nothing else scrubbed), gift cards /
  promotion usage / subscriptions / licenses / carts (customerId nulled, record
  kept; active device activations on the customer's licenses are revoked first),
  `email_outbox` rows addressed to the customer's email (recipient + payload
  scrubbed, row kept for delivery/ops history).
- deletes: `subscriber` rows (newsletter and waitlist opt-ins) matching the
  customer's email — these are independent, email-keyed marketing consent
  records, not derived from the customer row, so they don't get cleaned up for
  free by cascading deletes and must be erased explicitly. One-shot `restock_request` rows, which also hold an
  email address, are not touched by this handler.

## `audit_log` — retained, not erased

`audit_log` rows (admin actions: refunds, cancellations, settings changes,
staff/permission edits, etc.) are **not** deleted by account erasure and are
left unscrubbed, except `edit_address` entries on the erased customer's
anonymized orders, whose `before`, `after` and `reason` fields are removed.
The retention is intentional, not an oversight:

- The data subject of an audit_log entry is typically the **admin/staff actor**
  performing the action, not the shopper. Where a shopper's email appears
  (e.g. inside an action's `data` payload), it is incidental context for a
  security/accounting record, not the record's subject.
- The stated basis for retention (a legal position, not checked against code)
  is **legitimate interest** (GDPR Art. 6(1)(f)):
  fraud investigation, dispute/chargeback defense, financial audit trail, and
  abuse of admin privileges all require an audit trail that admins themselves
  cannot cause to disappear (including indirectly, by having a customer
  request erasure).
- If a specific jurisdiction's DPA guidance requires redacting shopper PII from
  historical audit_log payloads on request, do that as a targeted, logged
  redaction of the affected `data` field(s) — never a blanket delete of the
  audit trail.

This note documents the scope of `DELETE /v1/shop/account` as implemented in
`packages/api/src/routes/account.ts`.
