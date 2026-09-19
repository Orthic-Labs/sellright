# Blog automation contract

The existing blog API now advertises `seoContract: revision-v1` and
`createContract: audit-receipt-v1`. This is an API capability, not evidence that a
particular downstream server or public storefront has been upgraded.

GET `/v1/admin/blog/{id}` returns `seoRevision`, a deterministic SHA-256 identity of
the stored row. PATCH accepts `expectedRevision`. It obtains a PostgreSQL row lock,
reads and compares the current row, and performs the update in the same store-scoped
transaction. A competing change returns HTTP 409 without applying the stale patch.
Legacy callers may omit the condition; unattended clients must not. Publication and
rollback are ordinary separately authorized conditional updates, not an exception.

POST `/v1/admin/blog` accepts `Idempotency-Key` (1–128 bounded ASCII characters).
Concurrent identical requests are serialized by a transaction-scoped advisory lock.
The existing store-scoped `audit_log` records the immutable request hash and created
post identity in the same transaction as the insert. Repeated requests return the
same ID/slug. Changed payloads, another post using the slug, or a deleted recorded
post return HTTP 409; they are never resolved by creating a suffixed duplicate.
Retain `entity=blog_post, action=idempotent_create` audit rows for the lifetime of
clients' retry keys. Do not prune them as disposable diagnostic logs. No secret,
article body or bearer token is stored in that receipt.

POST/PATCH accept the existing schema's `featuredAssetId`, including null to clear.
The asset must belong to the selected store. A key-share lock prevents deletion
between that check and establishing the reference. This does not upload an image;
the existing authenticated multipart `/v1/admin/assets` endpoint owns upload and
conversion. Asset dimensions/alt and public rendering still need verification.

Run the disposable database suite with the existing `db` Vitest project:

```sh
pnpm --filter @sellright/api test:db src/routes/admin-blog-protocol.db.test.ts
```

It exercises real PostgreSQL concurrent requests, stale publish rejection,
create retries, key/payload conflicts, deleted receipts, tenant asset scope and
existing authorization gates. Its mocked session lookup is not authentication
or machine-token lifecycle qualification. No schema migration or new dependency
is needed; the existing blog, asset and audit-log tables are used.
