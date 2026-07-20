# Subscriber System — Newsletter + Waitlist (2026-07-19)

Status: **SHIPPED** — live in RightSites production (2026-07-20). See "As built"
at the bottom for what changed during implementation and what is still open.

## Why this exists

SellRight already has a newsletter endpoint. It loses data.

`POST /v1/shop/newsletter-signup` (`packages/api/src/routes/shop-extra.ts:112-155`)
resolves the store, reads `store.config.listmonk`, and POSTs the address to
Listmonk's `/api/subscribers`. It persists **nothing**. Two paths silently drop
the signup while returning `{ok: true}` to the browser:

1. Listmonk not configured (`lm?.url && lm?.apiToken` false) — the whole block is
   skipped, the address is discarded, the caller is told it worked.
2. Listmonk configured but failing — the `fetch` throws, the `catch` logs it, and
   the handler still returns `{ok: true}`.

So the current newsletter is only as durable as an unmonitored third-party HTTP
call made inside a request that reports success either way.

Three further gaps:

- **Single opt-in.** The signup sends `status: 'enabled'`, subscribing the address
  with no confirmation, while `packages/storefront/src/routes/newsletter/confirm/[subscriber]/`
  exists and is never reached by this path. Consent is asserted, not proven.
- **Two integration paths.** The storefront's confirm/unsubscribe routes call
  Listmonk directly from SSR via `ListmonkService`; the API calls it separately.
  Two credential surfaces, two failure modes, no shared state.
- **No waitlist.** Pre-launch interest lives in five standalone Cloudflare Workers
  (HeardRight, MailRight, ViewRight, CodeRight, ScrapeRight), each with its own KV
  namespace and Resend integration, none joined to `customer`. At launch you cannot
  tell who converted.

## Decision

**The `subscriber` table becomes the source of truth. Listmonk is demoted to a
best-effort downstream sync target.**

This is the outbox pattern the repo already applies to email and webhooks
(`0038_email_outbox.sql`, `0031`/`webhook_delivery`): commit locally in the
request transaction, push to the outside world in a background job with retry.
The existing newsletter endpoint is the one place that still does the outbound
call inline and treats its failure as success.

**One table serves both newsletter and waitlist**, discriminated by `kind` +
`topic`. A waitlist is a newsletter whose list happens to be named after an
unreleased product; modelling them separately would duplicate confirmation,
unsubscribe, rate limiting, and admin export twice.

## Schema

New table, migration `packages/api/drizzle/0041_subscriber.sql` (hand-written,
must carry the `-- HAND-WRITTEN: see docs/runbooks/migrations.md` marker and be
added to the `HAND_WRITTEN` array in
`packages/api/src/db/assert-hand-written-migrations.ts`).

| column | type | notes |
|---|---|---|
| `id` | uuid PK | `gen_random_uuid()` |
| `store_id` | uuid NOT NULL → `store.id` | RLS tenant key |
| `email` | text NOT NULL | store lowercased/trimmed |
| `name` | text | optional |
| `kind` | text NOT NULL | `'newsletter'` \| `'waitlist'` |
| `topic` | text NOT NULL DEFAULT `''` | `''` for general newsletter; app key (`'scraperight'`) for waitlist |
| `status` | text NOT NULL DEFAULT `'pending'` | `pending` → `confirmed` → `unsubscribed`; also `bounced` |
| `token` | uuid NOT NULL DEFAULT `gen_random_uuid()` | capability token for confirm + unsubscribe links |
| `confirmed_at` | timestamptz | |
| `unsubscribed_at` | timestamptz | |
| `last_sent_at` | timestamptz | per-address confirmation-email cooldown (see mailbomb guard) |
| `source` | text | `'storefront'` \| `'checkout'` \| `'import'` \| `'api'` |
| `meta` | jsonb | utm / referrer / app version |
| `listmonk_synced_at` | timestamptz | downstream marker; NULL = not yet pushed |
| `created_at` / `updated_at` | timestamptz | `now()` |

Constraints and indexes:

- `UNIQUE (store_id, email, kind, topic)` — one row per person per list.
  **`topic` is `NOT NULL DEFAULT ''` specifically so this works.** Postgres treats
  NULLs as distinct in unique constraints, so a nullable `topic` would allow
  unlimited duplicate general-newsletter rows for the same address. Do not
  "clean this up" to a nullable column.
- `UNIQUE (token)` — lookup key for confirm/unsubscribe.
- `INDEX (store_id, kind, topic, status)` — admin list/count queries.
- `INDEX (status, listmonk_synced_at)` — the sync job's claim query.
- RLS: `ENABLE` + `FORCE ROW LEVEL SECURITY` + `tenant_isolation` policy on
  `store_id = current_setting('app.current_store', true)::uuid`, both `USING` and
  `WITH CHECK`. Copy the shape from `0038_email_outbox.sql:38-40`.
  `rls-tables.test.ts` auto-discovers store-scoped tables, so this table is
  covered by the isolation suite automatically once the policy is right.
- Include a `-- DOWN` comment block listing the reverse statements, matching 0038.

Drizzle table definition goes in `packages/api/src/db/schema-content.ts`
(alongside `customerToken`, `blogPost`, `affiliate` — the marketing/content side),
not `schema-core.ts`.

## Endpoints

### Public

**`POST /v1/shop/newsletter-signup`** — keep the path and the existing
`{email, name?}` body for backward compatibility; the storefront helper
`srNewsletterSignup` (`packages/storefront/src/utils/sellright.ts:170`) already
calls it. Extend the body with optional `kind` (default `'newsletter'`),
`topic` (default `''`), `source`, and `meta`.

New behavior:

1. Per-IP throttle first, unchanged — reuse `newsletterRetryAfter` /
   `recordNewsletterAttempt` from `shop-extra.newsletter-limit.ts`.
2. Resolve store via `resolveStoreFromCtx`.
3. In **one** `withStore` transaction: upsert the subscriber row, and if a
   confirmation email is due, `enqueueEmail(tx, storeId, {...})` in that same
   transaction. This is the whole point — the address and the email that proves
   it are committed atomically, and the scheduler owns delivery with retry and
   dead-lettering.
4. **No outbound Listmonk call in the request path.** Delete that block.
5. Return `{ok: true}` unconditionally (see enumeration note below).

Upsert semantics by existing status:

- no row → insert `pending`, enqueue confirmation.
- `pending` → do **not** duplicate; re-enqueue confirmation only if
  `last_sent_at` is older than the cooldown.
- `confirmed` → no-op, no email. Do not reveal that they are already subscribed.
- `unsubscribed` → back to `pending` and re-send confirmation. They asked again;
  re-consent is the correct handling, not permanent suppression.

**`GET /v1/shop/subscriber/confirm/:token`** → `status='confirmed'`,
`confirmed_at=now()`. Idempotent: confirming twice succeeds. Unknown token
returns the same generic response as a valid one.

**`POST /v1/shop/subscriber/unsubscribe/:token`** and a `GET` variant for the
email link landing page → `status='unsubscribed'`, `unsubscribed_at=now()`.
Idempotent. Ship the `POST` form because RFC 8058 one-click unsubscribe
(`List-Unsubscribe-Post: List-Unsubscribe=One-Click`) is what Gmail and Yahoo
require of bulk senders — without it, deliverability degrades regardless of how
clean the list is.

### Admin

Extend `packages/api/src/routes/admin-marketing.ts` (it already owns Listmonk):

- `GET /v1/admin/subscribers` — filter by `kind`, `topic`, `status`; paginated.
- `GET /v1/admin/subscribers/export` — CSV.
- `GET /v1/admin/subscribers/stats` — counts by kind/topic/status, for a
  per-app waitlist number on the dashboard.

Write an `auditLog` row for export (it is a bulk PII read), matching the
`listmonk_sync` audit pattern at `admin-marketing.ts:252`.

## Listmonk sync job

New job in `packages/api/src/jobs/`, registered in `scheduler.ts` alongside
`auto-deliver` and `webhook-reaper`, following their leader-lock convention
(`jobs/leader-lock.ts`).

Claims `status='confirmed' AND listmonk_synced_at IS NULL`, pushes each to
Listmonk with `status: 'enabled'`, sets `listmonk_synced_at`. Must use
`safeOutboundFetch` — the Listmonk URL is admin-supplied config and the existing
code correctly treats it as an SSRF vector (`shop-extra.ts:145-150`). Skip
entirely when Listmonk is unconfigured; rows simply stay unsynced and nothing is
lost, which is the fix.

Only `confirmed` subscribers sync. Pending, unconfirmed addresses must never
reach the mailing list.

## Decisions made during implementation

These resolve gaps this spec left open. They are settled, not proposals.

- **Cooldown vs re-consent precedence.** The spec required both "unsubscribed →
  re-send confirmation" and "one confirmation per address per hour" without
  saying which wins when both apply. Resolved: `unsubscribed → pending` is
  EXEMPT from the cooldown. The cooldown exists to stop an attacker replaying
  signup for a victim's address, and that attack drives `pending → pending`,
  which is still rate-limited. Reaching `unsubscribed` requires the capability
  token, which only ever went to the address owner, so re-consent is
  necessarily user-initiated. Without the exemption, someone who unsubscribes
  by accident and immediately resubscribes gets silence and never lands on the
  list.
- **Trim before validation.** `z.email()` rejects `"  a@b.com "` outright, so a
  handler-side `.trim()` never sees it. The schema is
  `z.string().trim().pipe(z.email())` so a 400 is reserved for genuinely
  malformed addresses.
- **CSV formula injection (CWE-1236) on the admin export.** `name` arrives on
  the public unauthenticated endpoint and lands in a file an admin opens in
  Excel, where a leading `=`, `+`, `-`, `@`, TAB or CR makes the cell a live
  formula. Cells matching that are prefixed with an apostrophe before RFC 4180
  quoting.
- **Migration journal.** A hand-written migration must ALSO be registered in
  `drizzle/meta/_journal.json`. drizzle-kit applies only what the journal
  lists — an unregistered file is silently skipped while
  `drizzle-kit migrate` still reports "migrations applied successfully", and
  `pnpm db:assert-hand-written` still passes because the marker is present.
  Verify a migration by checking the table exists, never by trusting that
  output.
- **DB-backed tests must be registered in `package.json` twice**: excluded from
  `test` and listed in `test:db`. A new DB test in neither list breaks
  `pnpm test`.

## Security

- **Mailbomb guard.** The current per-IP limit does not stop a distributed
  attacker from repeatedly signing up a victim's address to make us send them
  confirmation emails. Enforce a per-address cooldown (1 confirmation per
  address per hour) using `last_sent_at`, checked inside the transaction. The
  per-IP limit stays as the first gate.
- **Enumeration.** Always return `{ok: true}` and an identical response shape
  whether or not the address was already subscribed, and for unknown confirm
  tokens. The existing endpoint already gets this right; preserve it.
- **Token strength.** `gen_random_uuid()` is 122 bits of randomness — fine for a
  capability URL. Do not derive the token from the email.
- **Confirm-link prefetch.** Corporate mail scanners follow links in email, which
  can auto-confirm a GET. This is accepted (it is how essentially all double
  opt-in works) and noted here so it is not rediscovered as a bug.
- **Known limitation, unchanged:** the in-memory IP throttle does not survive
  across multiple API instances. Pre-existing; out of scope.

## Files

| file | change |
|---|---|
| `packages/api/drizzle/0041_subscriber.sql` | new — hand-written migration, marker + DOWN block |
| `packages/api/src/db/assert-hand-written-migrations.ts` | add `0041_subscriber.sql` to `HAND_WRITTEN` |
| `packages/api/src/db/schema-content.ts` | new `subscriber` table |
| `packages/api/src/routes/shop-extra.ts` | rewrite signup: persist + enqueue, drop inline Listmonk call |
| `packages/api/src/routes/shop-extra.subscriber.ts` | new — confirm + unsubscribe routes |
| `packages/api/src/email/templates.ts` | new `subscriberConfirm`, `waitlistConfirm` templates |
| `packages/api/src/jobs/listmonk-sync.ts` | new — background sync |
| `packages/api/src/jobs/scheduler.ts` | register the sync job |
| `packages/api/src/routes/admin-marketing.ts` | admin list / export / stats |
| `packages/api/src/routes/shop-extra.newsletter.test.ts` | extend for persistence + upsert paths |
| `packages/api/src/routes/shop-extra.subscriber.test.ts` | new — confirm/unsubscribe/idempotency |

## Out of scope

Migrating the five Cloudflare waitlist Workers onto this endpoint. The schema is
designed to receive them (`kind='waitlist'`, `topic=<appKey>`), and
`SCRAPERIGHT_WAITLIST` currently holds zero rows so the migration is free today,
but cutting the Workers over is a separate change to the RightSites repo.

## Verification

```bash
cd packages/api
DATABASE_URL=postgres://sellright:<pw>@127.0.0.1:5433/sellright_test pnpm db:migrate
DATABASE_URL=postgres://sellright:<pw>@127.0.0.1:5433/sellright_test pnpm test
pnpm db:assert-hand-written
pnpm verify
```

Tests must target `sellright_test`. The RLS suite TRUNCATEs and refuses any
database whose name does not end in `_test`.

---

## As built (2026-07-20)

Shipped to RightSites production. Five brand sites post to
`/v1/shop/newsletter-signup` same-origin (nginx proxies `/v1/` to
`rightapps-api` on every brand vhost), so there is no CORS surface and no
per-app Cloudflare Worker in the path.

| site | kind | topic |
|---|---|---|
| heardright.app | `newsletter` | `heardright` |
| viewright.cc | `newsletter` | `viewright` |
| mailright.cc | `waitlist` | `mailright` |
| coderight.cc | `waitlist` | `coderight` |
| scraperight.cc | `waitlist` | `scraperight` |

Released apps are `newsletter`, unreleased are `waitlist`. Shipping an app is a
`kind` flip on its rows — nothing moves between lists.

### Defects found and fixed during implementation

- **Cooldown discarded data.** The signup handler returned before the row
  update when a repeat signup landed inside the 1-hour cooldown, so a
  multi-step form's second request (CodeRight posts the address, then survey
  answers) had its `meta` silently dropped while still returning `{ok:true}`.
  The cooldown now suppresses the *email* only; the row updates either way, and
  `last_sent_at` advances only on an actual send so repeat posts cannot starve
  the send by pushing the window forward.
- **Confirm links and sender ignored the app.** On a multi-tenant store every
  confirmation used the global `STOREFRONT_URL`/`SMTP_FROM`, so a ScrapeRight
  signup mailed from `hello@heardright.app` with a `viewright.cc` link. Both now
  resolve through `STOREFRONT_URL_BY_APP` / `EMAIL_FROM_BY_APP` keyed by
  `topic`, via the same `appValue()` helper `dispatch.ts` already used.
  Deliberately NOT derived from the `Host` header — building an emailed
  capability URL from attacker-controlled input is host-header injection.
- **Three migrations were permanently stranded.** `email_outbox`,
  `push_outbox` and `admin_device_token` did not exist in the production
  database even though code wrote to them; the signup was simply the first path
  to hit `email_outbox`, and it 500'd. drizzle-kit picks pending work from a
  timestamp cursor, so once RightSites' own `0041_runtime_artifact_promotion`
  (`when=1784045400000`) applied, every upstream-merged entry near
  `1782000000000` became unreachable forever. **This is a structural hazard of
  the fork:** merging upstream appends entries carrying the upstream author's
  timestamps, which are older than anything RightSites has applied recently.
  After any `git merge upstream/main` that brings migrations, re-stamp their
  `when` above the newest applied `created_at` before running `db:migrate`, and
  verify by checking the tables exist — `drizzle-kit` prints "migrations applied
  successfully" either way.
- **CSV formula injection** in the admin export (CWE-1236): `name` arrives on
  the public unauthenticated endpoint and lands in a file an admin opens in
  Excel. Cells leading with `=`, `+`, `-`, `@`, TAB or CR are apostrophe-prefixed.
- **Signup race.** SELECT-then-INSERT let two concurrent signups for one address
  both insert, and the loser violated the unique index — a 500 on a
  double-clicked button. Now `onConflictDoNothing`, matching repo convention.

### Operational notes

- **`JOBS_ENABLED=1` is required.** The scheduler is a single master switch for
  all background jobs including `emails` and `listmonk-sync`. It was `0` in
  RightSites production, so confirmations were enqueued and never sent —
  subscribers would have been captured and left `pending` forever, with double
  opt-in silently inert. Enabled 2026-07-20 (`.env.bak-jobs-20260720` holds the
  previous file). `autoDeliverApply` and `releaseApply` remain `false`.
- **Listmonk is optional and non-blocking.** With it unconfigured the sync job
  logs `skipped` and rows simply stay `listmonk_synced_at IS NULL`. Nothing is
  lost — that is the whole point of demoting it to a downstream target.
- Only `confirmed` rows ever sync to Listmonk. Pending addresses never reach a
  mailing list.

### Verified in production

Signup (200) → `subscriber` row with correct `kind`/`topic`/`source`/`meta` →
`email_outbox` entry → scheduler delivers (`sent`) → confirm token flips the row
to `confirmed` and is idempotent on a second call. Per-app routing confirmed:
ScrapeRight from `hello@scraperight.cc` linking `scraperight.cc`, HeardRight
from `hello@heardright.app` linking `heardright.app`.

### Still open

- The storefront's own `newsletter/confirm` and `newsletter/unsubscribe` pages
  still call Listmonk directly from SSR (defect D3 in "Why this exists"). The
  API path above does not use them.
- The five Cloudflare Workers are orphaned but still deployed.
- HeardRight's signup was added in RightSites (`heardright/src/routes/index.tsx`);
  it has no equivalent in SellRight, which ships no brand sites.
