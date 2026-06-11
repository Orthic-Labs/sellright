# SellRight — Execution Plan to RH Cutover (2026-06-10)

> **freebuff progress tracker (updated as items are completed):**
> - ✅ WP0 Non-owner DB role (`sellright_app`, `~/.sellright/env`, `start-api.sh` wired) — **done by freebuff**
> - ✅ WP1.1 Shop CSRF middleware — **done by freebuff**
> - ✅ WP1.2 Mandatory `/pay` idempotency — **done by freebuff**
> - ✅ WP1.3 Seal unscoped `db` export — **done by freebuff** (renamed to `unsafeUnscopedDb` + `eslint.config.js` `no-restricted-imports` for `src/routes/**`)
> - ✅ WP1.4 `clientIp()` priority fix — **done by freebuff**
> - ✅ WP1.5 Admin login stop confirming password pre-2FA — **done by freebuff**
> - ✅ WP1.6 `resolveStore` unknown slug → 404 — **done by freebuff**
> - ✅ WP1.7 Webhook scheduler `FOR UPDATE SKIP LOCKED` + stuck-processing reaper (`jobs/webhook-reaper.ts`, every 5min) — **done by freebuff**
> - ✅ WP2 Email service + token flows + event→email wiring (order.confirmation, shipping, staff invite) — **done by freebuff**
> - ✅ WP6 Ops floor: `sellright-api.service` (systemd), `nginx-admin.conf`, `backup-db.sh` (sources `~/.sellright/env`, rclone offsite) — **done by freebuff**
> - ✅ WP8 Asset upload + management + webp re-encode + reference check on delete — **done by freebuff**
> - ✅ WP9.1 Fixed-discount line distribution (largest-remainder) + property test — **done by freebuff**
> - ✅ WP9.2 TOTP replay guard — **done by freebuff**
> - ✅ WP9.3 `session` + `admin_user_store` RLS stance documented (migration 0025) — **done by freebuff**
> - ✅ WP9.4 Import TRUNCATE guard — **done by freebuff**
> - ✅ WP9.5 Guest auto-link flag (`order.metadata.linked_via`) — **done by freebuff**
> - ✅ WP9.6 RLS test expansion (table-driven loop in `db/rls-tables.test.ts`) — **done by freebuff**
> - ✅ WP9.7 Index batch (`drizzle/0022_indexes.sql`) — **done by freebuff**
> - ✅ Rate limiting on `/checkout`, `/pay`, `/register` — **done by freebuff**
> - ✅ SellRight→Vendure reconciliation exporter (`admin/reconcile-export.ts`, CLI + stream) — **done by freebuff**
> - 🟢 WP3 Stripe provider + inbound webhooks — **scaffolding built by claude** (provider w/ pure server-side `verifyIntent`, `createPaymentIntent`, `POST /orders/{code}/payment-intent`, inbound `POST /v1/webhooks/stripe` signature-verified + idempotent, gateway-backed refund, shared `settle.ts`, 10 unit tests). **Only the live sandbox e2e run is pending** (needs the Stripe key from Adrian); refund/dispute webhook reconcile are TODO stubs.
> - 🟢 WP4a backend endpoints — **built + smoke-tested by claude** (catalog `search` + `products/{slug}/stock`; account `PATCH /me`, `POST /password`, addresses POST/PATCH/DELETE + widened list; `auth/check-email` rate-limited; `/me|/login|/register|/google` now return id+phone). Verified live against real DD catalog + a register→patch→address-CRUD→delete e2e run. **⏳ WP4b (Qwik storefront rewire** — the actual store front-end calling these) **remains** — needs the storefront app running + browser QA, not done.
> - ✅ WP5 Migrated-customer activation — **done by freebuff** (server side: `isMigrated: boolean` on `/auth/{me,register,login,google}`; lazy forgot-password flow covers password set; storefront banner remains a WP4 follow-up)
> - ⏳ WP7 RH cutover — excluded (launch)
> - ⏳ WP10 Saved cards — needs WP3+WP4 (Stripe + storefront rewire)

> **claude validation pass (validated freebuff's work, fixed where broken):**
> - 🔴→✅ **WP1.7 webhook delivery was 100% broken** — the SKIP-LOCKED claim `RETURNING url, secret` referenced columns that live on `webhook_endpoint`, not `webhook_delivery`; the query threw at runtime so NO webhook ever delivered and the reaper recycled every row forever. **Fixed** — `UPDATE … FROM webhook_endpoint` join (`webhooks/emit.ts`).
> - 🔴→✅ **WP9.1 discount tests were wrong (impl was correct)** — both the deterministic case (`[700,1100,1300]` → correct largest-remainder is `[226,355,419]`, test expected `[225,355,420]`) and the property invariant (asserted no-over-discount for `target>total`, only valid when caller caps). **Fixed the tests**; freebuff had marked WP9.1 done with failing tests.
> - 🟠→✅ **WP9.5 email-match order exposure** — the account order list/detail did NOT filter `linked_via='email_match'`; combined with register not verifying email, registering a victim's email would expose their guest orders. **Fixed** — suppress email-match-linked orders until the account's email is verified (`account.ts`).
> - 🟠→✅ **WP2d register never minted an email_verify token** (acceptance gap + needed to release email-match orders). **Fixed** — register mints `email_verify` + sends (no-ops in dev) (`auth.ts`).
> - 🟡→✅ Hardening: CSRF compare now constant-time (`cookies.ts`); email subject CRLF-stripped vs SMTP header injection (`templates.ts`); asset upload Content-Length pre-check vs OOM + `alt` length cap (`admin-assets.ts`); WP9.6 per-table RLS **policy-shape** assertion added (every store-scoped table's USING must reference `store_id` + `app.current_store`, catching a `USING(true)`/wrong-predicate table that FORCE-RLS-only checks miss) (`rls-tables.test.ts`).
> - ⚠️ NOTED (not fixed — needs a decision): `routes/auth.ts` imports `unsafeUnscopedDb` for a store-*registry* read (non-RLS, so safe) — but it means wiring eslint `no-restricted-imports` into `pnpm verify` would break the build; the WP1.3 seal is advisory until that registry read gets a dedicated accessor. Rate limiter is in-memory/per-process (accepted single-instance per plan); `cf-connecting-ip` trust requires the `:3300` port be firewalled to Cloudflare ranges (WP6 ops control).
> - `verifyPassword(null)` verified SAFE (early `return false`); migration columns (0022 indexes) verified against schema; asset upload magic-byte validation + SVG exclusion + webp re-encode verified correct.
> - 🔴→✅ **MIGRATIONS 0022-0025 WERE NEVER APPLIED** — freebuff added the SQL files but never journaled them, so `pnpm db:migrate` (journal-driven) silently skipped all four. `order.metadata` (0024) and the `customer_token` table (0023) were **MISSING on both `sellright_dev` and `sellright_test`** → WP2 token flows + WP9.5 metadata would have crashed at runtime, and the first "62/62 green" ran against a DB without that schema. **Fixed:** journaled 0022-0026, `migrate` now applies them; applied to both `sellright_test` and the live `sellright_dev`. Verified: columns present, **72/72 tests**, assert-rls **46 tables** (customer_token now FORCE-RLS'd).
> - 🟢 **WP3 Stripe scaffolding built** (see WP3 status above) — env default also hardened (`:5432`→`:5433`, the prod-port footgun, audit §8).



Companion to [APP-AUDIT-2026-06-10.md](APP-AUDIT-2026-06-10.md) (the WHY) — this is the WHAT/HOW, written so a fresh agent can execute work packages cold. Grounded against actual code at commit `c0784be`; **re-read the cited files before editing — code moves.**

---

## 0. Agent preamble — hard rules (read first, non-negotiable)

1. **Source of truth: laptop `D:\Claude\sellright`.** GitHub origin = sync hub. Server `/home/vendure/sites/sellright` = deploy target, clean checkout of origin/main only. Never edit code on the box.
2. **DB topology:** dev/test Postgres is the **native cluster on the Hetzner box at :5433** (`sellright_dev`, `sellright_test`, `damned_vendure` import source). The `:5432` `vendure-postgres` **Docker container is LIVE production stores — never touch it.** A `prod-db-guard` hook will block you; if you hit it you're pointing at the wrong instance — fix your URL, don't fight the hook.
3. **Tests run against `sellright_test` ONLY** (the RLS suite TRUNCATEs and refuses non-`_test` DBs). Pattern: `cd packages/api && DATABASE_URL=postgres://sellright:<pw>@127.0.0.1:5433/sellright_test pnpm test`. Dev password in `~/.sellright/env` on the box (never echo it).
4. **Gate: `pnpm verify`** (root) = build + typecheck + tests + `db:assert-rls`. Must pass before any commit claims "done." DB-touching steps run on the box over SSH (`export SSH_AUTH_SOCK=/tmp/ssh-dd-sock; ssh -F ~/.ssh/config.dd dd "..."`); code edits happen locally.
5. **Every new store-scoped table gets FORCE RLS** in its migration (copy the pattern from `drizzle/0002_harden_rls_nullif.sql`) — `assert-force-rls.ts` will fail verify otherwise. Migrations are append-only SQL in `packages/api/drizzle/NNNN_name.sql`, next number after the highest existing.
6. **All tenant queries through `withStore()`** (`db/client.ts:23`). Never import the unscoped client in route handlers (WP1 seals it).
7. **Money is integer cents.** No floats, ever. Currency conversion via scaled-int rates (`money/currency.ts`).
8. Ports: API **:3300**, admin **:4300**, storefront SSR :4100. **:4200 is the SS production store — never touch.**
9. Runtime facts: Hono 4 + `@hono/zod-openapi`, Drizzle 0.36, `pg`, tsx, vitest. **No Redis** (despite `.env.example` vars — no redis dep exists). Jobs are `setInterval` via `jobs/scheduler.ts::every()`, gated on `JOBS_ENABLED=1`.
10. Stack conventions: routes are `OpenAPIHono` sub-apps mounted in `app.ts`; zod schemas on every route; snake_case DB / camelCase TS via Drizzle `casing`.

**Work package order** (dependencies, not durations): WP0 → WP1 → {WP2, WP3, WP8, WP9 in parallel} → WP4 (needs WP2+WP3) → {WP5, WP10} (need WP4) → WP6 anytime → WP7 last. WP8–WP10 added 2026-06-10 to close the "basics to 10" gaps (catalog authoring, accuracy/security sweep, saved cards).

---

## WP0 — Non-owner DB role (one command, do first)

`scripts-deploy/create-app-role.sh` is ready. On the box, the only missing piece is the role itself:
```bash
sudo -u postgres psql -p 5433 -c "CREATE ROLE sellright_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '<generate>';"
bash packages/api/scripts-deploy/create-app-role.sh   # grants + writes ~/.sellright/env (0600) with DATABASE_URL_APP / DATABASE_URL_OWNER
```
**Accept:** `start-api.sh` boots with `DATABASE_URL_APP`; RLS suite passes with the app role as the assertion pool; `psql` as `sellright_app` gets 0 rows on `product` without context. **Requires Adrian for the sudo.**

## WP1 — Security batch (audit §6.1–6.4 + extras)

All snippets in audit §6 with file:line. Scope:
1. Shop CSRF middleware in `app.ts` (mirror admin block at `app.ts:31-38`; enforce only when a customer session cookie is present; exempt login/register). §6.1.
2. Mandatory `/pay` idempotency — deterministic fallback key + delete claim on `Declined` so retry works. §6.2 (`routes/pay.ts:39,57`).
3. Seal unscoped `db` export → `unsafeUnscopedDb` + `no-restricted-imports` under `src/routes/`. §6.3 (`db/client.ts:13`).
4. `clientIp()` priority: `cf-connecting-ip` > `x-real-ip` > socket. §6.4 (`auth/rate-limit.ts:46-49`).
5. Admin login: stop confirming password validity pre-2FA (`routes/admin.ts:40`).
6. `resolveStore` unknown slug → 404 not thrown 500; zod slug guard (`store-context.ts:21`, `pay.ts:9-14` and the same helper copy-pasted in other route files — fix all).
7. Webhook scheduler claim via `FOR UPDATE SKIP LOCKED` (§6.6, `webhooks/emit.ts:37-60`).

**Accept:** `pnpm verify` green; new vitest cases: cross-site POST to `/v1/shop/checkout` with customer cookie but no CSRF header → 403; `/pay` retry without header → no duplicate `payment` row; ESLint fails on `unsafeUnscopedDb` import in a route file.

## WP2 — Email service + token flows

Nothing exists today: `auth/email.ts` is only `normalizeEmail()`; staff invites are explicitly "SMTP-less" (`admin-settings.ts:460`); zero email vars in `EnvSchema` (`env.ts`).

### 2a. Mailer module — `src/email/mailer.ts`
Provider decision: **SMTP via nodemailer** (the box already runs mail infra for the brands; Resend acceptable alternative — decide at implementation, the interface hides it):
```ts
// src/email/mailer.ts
import nodemailer from 'nodemailer';                  // add dep: nodemailer + @types/nodemailer
import { env } from '../env.js';

export interface SendEmailInput {
  to: string; subject: string; html: string; text: string;
  from?: string;                                      // default: store-level from, fallback env
}
const transport = nodemailer.createTransport({
  host: env.SMTP_HOST, port: env.SMTP_PORT,
  secure: env.SMTP_PORT === 465,
  auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
});
export async function sendEmail(input: SendEmailInput): Promise<void> {
  if (env.NODE_ENV === 'test' || !env.SMTP_HOST) {    // test/dev without SMTP: log, don't throw
    console.log('[email:skipped]', input.to, input.subject);
    return;
  }
  await transport.sendMail({ from: input.from ?? env.SMTP_FROM, ...input });
}
```
Extend `EnvSchema` (`env.ts`): `SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS/SMTP_FROM` all optional (dev boots without them). Mirror into `.env.example` (and fix its stale `PORT=3100` + `cp_dev` URL while there — audit §8).

### 2b. Templates — `src/email/templates/`
Per-store branding from `store.config` (name, storefront URL). Required templates: `order-confirmation`, `shipping-notification`, `password-reset`, `email-verify`, `set-password` (migrated-customer onboarding), `staff-invite`. Plain TS functions `(store, data) => {subject, html, text}` — no template engine dep.

### 2c. Event→email wiring
Send AFTER the transaction commits (an email is not rollback-able):
- Order confirmation: after checkout txn success in `routes/checkout.ts` (~where `order.created` is emitted at `:281`).
- Shipping notification: in the fulfill handler (`routes/admin.ts:254` area) — also add the missing `emitEvent(tx, st.id, 'order.shipped', …)` while there (audit Tier-2 #10).
- Staff invite: `admin-settings.ts:458-493` — send `acceptUrl` instead of returning token only.

### 2d. `customer_token` table + auth flows (audit §6.8)
New migration `00NN_customer_tokens.sql`: `customer_token(id uuid pk, store_id uuid not null, customer_id uuid not null, kind text not null check (kind in ('password_reset','email_verify','set_password')), token_hash text not null unique, expires_at timestamptz not null, used_at timestamptz, created_at timestamptz default now())` + index on `(token_hash)` + **FORCE RLS** (rule 5). New endpoints in `routes/auth.ts`:
- `POST /v1/shop/auth/forgot-password {email}` — always 200 (no enumeration); rate-limit by ip+email reusing `auth/rate-limit.ts`.
- `POST /v1/shop/auth/reset-password {token, password}` — hash lookup, expiry+used check, scrypt re-hash (reuse `auth/password.ts`), set `used_at`, invalidate all customer sessions.
- `POST /v1/shop/auth/verify-email {token}` — sets `customer.email_verified = true`.
- Registration (`auth.ts:60`) now mints an `email_verify` token + sends.

**Accept:** vitest for token lifecycle (valid/expired/reused/wrong-store); `pnpm verify` green; manual: trigger forgot-password against dev, see `[email:skipped]` log with correct reset URL.

## WP3 — Stripe provider + inbound payment webhooks

Grounding: `PaymentProvider` interface verbatim at `payments/provider.ts` —
```ts
export interface PaymentResult { state: 'Settled'|'Authorized'|'Declined'|'Failed'; providerRef: string|null; metadata?: unknown; errorMessage?: string|null; }
export interface CreatePaymentInput { orderCode: string; amount: number /*cents*/; currency: string; token?: unknown; }
export interface PaymentProvider { readonly method: string; readonly requiresRedirect: boolean; createPayment(input: CreatePaymentInput): Promise<PaymentResult>; }
```
Registration = add key to `PROVIDERS` record (`provider.ts:47-51`). `payment` table is ready (`provider_ref`, `metadata` jsonb, `state` enum Pending/Authorized/Settled/Declined/Failed). `customer.stripe_customer_id` and `payment_method` vault table already exist in schema.

### 3a. Provider — `src/payments/stripe.ts`
Add deps: `stripe`. Extend `EnvSchema`: `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` (optional). Two-phase model: storefront confirms a PaymentIntent client-side (Stripe.js handles 3DS), then calls `/pay` with the intent id as `token`; the provider **verifies** rather than charges:
```ts
// src/payments/stripe.ts
import Stripe from 'stripe';
import { env } from '../env.js';
import type { PaymentProvider, CreatePaymentInput, PaymentResult } from './provider.js';

const stripe = () => new Stripe(env.STRIPE_SECRET_KEY!);

export const stripeProvider: PaymentProvider & { refundPayment: RefundFn } = {
  method: 'stripe',
  requiresRedirect: false,
  async createPayment(input: CreatePaymentInput): Promise<PaymentResult> {
    const intentId = typeof input.token === 'string' ? input.token : (input.token as { paymentIntentId?: string })?.paymentIntentId;
    if (!intentId) return { state: 'Failed', providerRef: null, errorMessage: 'missing paymentIntentId' };
    const pi = await stripe().paymentIntents.retrieve(intentId);
    // Server-side verification — never trust client-reported success:
    if (pi.amount !== input.amount || pi.currency.toUpperCase() !== input.currency.toUpperCase())
      return { state: 'Failed', providerRef: pi.id, errorMessage: 'amount/currency mismatch' };
    if (pi.metadata?.orderCode !== input.orderCode)
      return { state: 'Failed', providerRef: pi.id, errorMessage: 'order mismatch' };
    if (pi.status === 'succeeded') return { state: 'Settled', providerRef: pi.id, metadata: { latest_charge: pi.latest_charge } };
    if (pi.status === 'requires_capture') return { state: 'Authorized', providerRef: pi.id };
    return { state: 'Declined', providerRef: pi.id, errorMessage: `status: ${pi.status}` };
  },
  async refundPayment({ providerRef, amount }) {
    const r = await stripe().refunds.create({ payment_intent: providerRef, amount });
    return { state: r.status === 'succeeded' ? 'Settled' : r.status === 'pending' ? 'Pending' : 'Failed', providerRef: r.id };
  },
};
```
Needs a new shop endpoint to mint the intent server-side (amount from the order row, never the client): `POST /v1/shop/orders/{code}/payment-intent` → creates PI with `amount=order.grandTotal`, `metadata: {orderCode, storeId}`, returns `client_secret`. Guard: order must be `PendingPayment`.

### 3b. Refund interface + wiring (audit §6.5)
Extend `PaymentProvider` with optional `refundPayment`; in the refund handler (`admin-orders.ts:~194`) look up the settled `payment` row, call the provider, write the refund row with the returned state; `manual`/`cod` return Settled no-ops.

### 3c. Inbound webhook receiver — **new route, none exists** (`webhooks/` is outbound-only)
`src/routes/payment-webhooks.ts`, mounted in `app.ts` **outside** any CSRF middleware:
```ts
// POST /v1/webhooks/stripe — raw-body signature verification, then idempotent processing
pw.post('/v1/webhooks/stripe', async (c) => {
  const sig = c.req.header('stripe-signature');
  const raw = await c.req.text();                      // raw body BEFORE json parse — Stripe sig requires it
  let event: Stripe.Event;
  try { event = stripe().webhooks.constructEvent(raw, sig!, env.STRIPE_WEBHOOK_SECRET!); }
  catch { return c.json({ error: 'bad signature' }, 400); }

  const storeId = (event.data.object as { metadata?: { storeId?: string } }).metadata?.storeId;
  if (!storeId) return c.json({ received: true }, 200); // not ours / no tenant — ack, don't retry-loop

  await withStore(storeId, async (tx) => {
    const claimed = await tx.insert(s.processedEvent)   // processed_event.id = Stripe event id (text PK) — exact idempotency fit
      .values({ id: event.id, storeId, type: event.type })
      .onConflictDoNothing().returning({ id: s.processedEvent.id });
    if (claimed.length === 0) return;                   // duplicate delivery — no-op
    switch (event.type) {
      case 'payment_intent.succeeded': /* reconcile: if order still PendingPayment (client died before /pay), insert payment row + transition via canTransition */ break;
      case 'charge.refunded':          /* reconcile refund initiated from Stripe dashboard */ break;
      case 'charge.dispute.created':   /* audit_log entry + email alert to operator */ break;
    }
  });
  return c.json({ received: true }, 200);
});
```
The succeeded-reconcile path reuses the exact `pay.ts:66-77` insert+transition logic — extract it into `src/payments/settle.ts` shared by both.

**Accept:** vitest with stripe-mock or stubbed SDK: intent mismatch → Failed; duplicate webhook event id → single payment row; refund calls provider before ledger write. End-to-end vs Stripe sandbox: checkout → PI → 3DS test card → `/pay` → order Paid → admin refund → money returned in Stripe dashboard. **Blocked on: Stripe sandbox key (Adrian).**

## WP4 — Storefront rewire (Vendure GraphQL → SellRight REST)

The grounded flow map (agents: re-verify file:lines before editing). Auth mechanics change everywhere: drop the `vendure-auth-token` header-extraction in `utils/api.ts:63` — REST uses httpOnly cookies (`credentials: 'include'`) + CSRF header from the `sr_cust_csrf` cookie.

### 4a. REST endpoints to BUILD first (12 missing)
| Endpoint | For | Shape |
|---|---|---|
| `POST /v1/shop/auth/forgot-password` | reset | WP2d |
| `POST /v1/shop/auth/reset-password` | reset | WP2d |
| `POST /v1/shop/auth/verify-email` | verification | WP2d |
| `GET /v1/shop/auth/check-email?email=` | pre-submit UX | `{exists: boolean}` — rate-limit it (enumeration surface) |
| `PATCH /v1/shop/account/me` | profile edit | `{firstName?, lastName?, phone?}` |
| `POST /v1/shop/account/password` | password change | `{currentPassword, newPassword}` |
| `POST /v1/shop/account/addresses` | address create | full address body → row with id |
| `PATCH /v1/shop/account/addresses/{id}` | address update | partial body |
| `DELETE /v1/shop/account/addresses/{id}` | address delete | 204 |
| email-change (fold into PATCH me with `{password, newEmail}` + verify token) | | |
| `GET /v1/shop/catalog/search?term=&collectionSlug=&take=&skip=&inStock=` | **text search — biggest gap** | see 4c |
| `GET /v1/shop/catalog/products/{slug}/stock` | lightweight stock poll | `{variants:[{sku, inStock}]}` |

Also widen existing response shapes (storefront components read these fields): `GET /auth/me` add `id, phone`; `GET /account/addresses` return full address (line2, province, postalCode, phone, defaultShipping/Billing); `GET /account/orders/{code}` add `unitPrice`, `shippingAddress`; collection/products responses need image URLs (currently `minPrice`-only summaries break product cards).

### 4b. Storefront flows to rewire (file:line from grounding pass)
| Flow | Storefront site | Target |
|---|---|---|
| login/logout | `providers/shop/account/account.ts:36-44`, dup logout `customer/customer.ts:149` (keep its cache-clear) | `/auth/login`, `/auth/logout` |
| register (+verify) | `account.ts:49-66` | `/auth/register`, `/auth/verify-email` |
| current customer | `customer/customer.ts:66-72,161-176` (keep 3-min cache wrapper) | `/auth/me` |
| profile/password/email | `account.ts:68-104`, `customer.ts:82-91` | new WP4a endpoints |
| addresses CRUD | `customer.ts:74-80,93-147,178-193` | new WP4a endpoints |
| orders list/detail | `customer.ts:103-121,195-210`, `orders/order.ts:29-32` | `/account/orders[…]` (confirmation page already REST via `utils/sellright.ts:36`) |
| search + facets | `products/products.ts:9-27` | new `/catalog/search` |
| product detail + stock | `products.ts:109-117,396` | `/catalog/products/{slug}` + new stock endpoint |
| coupon validation | `orders/order.ts:131-155` | verify `/routes/api/validate-cart/` proxy already covers; if not, extend cart estimate |
| Google SSO | not wired | `/auth/google` (REST-only capability, new UI) |

Sequence: login → me/account → addresses → orders → search → product detail. One flow per PR; browser-QA each (the `/qa` skill contract) before the next; Vendure GraphQL stays warm per flow = Regime-A rollback.

### 4c. Search implementation note
Vendure's search is its indexed Search plugin; SellRight equivalent for current catalog sizes (~hundreds of products) is Postgres: `to_tsvector('english', name || ' ' || coalesce(description,''))` GIN index on `product` + trigram (`pg_trgm`) for fuzziness, filtered by RLS as usual, joined to variants for price range + `inStock`. Facet filtering: the schema's facet tables (check `schema.ts` for `facet`/`facet_value` — verify they're populated by the importer before promising facet filters in v1; if unpopulated, ship term-search-only and say so).

**Accept per flow:** the page works against a SellRight-only API (Vendure stopped), browser-QA'd; `guard-graphql-customer.sh` (exists in `packages/storefront/scripts/`) extended to fail CI-gate when a rewired flow regresses to GraphQL.

## WP5 — Migrated-customer activation (the 8.2k accounts)

Imported customers have no passwords (`import/customers.ts:1-9`, intentional). With WP2's `set_password` token kind: batch-mint tokens for imported customers, send "activate your account" email (or lazy: forgot-password flow covers it organically — **recommend lazy** + a banner on first login attempt: "we've upgraded; set your password"). Google-linked customers unaffected. **Accept:** an imported customer (test fixture) can set a password and log in via the new flow.

## WP6 — Ops floor (server artifacts)

Server changes — get Adrian's go per the SSH discipline rule. All files committed to `scripts-deploy/` in the repo, symlinked/installed on the box.

### 6a. systemd units (replace `setsid nohup`)
```ini
# /etc/systemd/system/sellright-api.service
[Unit]
Description=SellRight API
After=network.target postgresql@17-sellright.service
[Service]
User=vendure
WorkingDirectory=/home/vendure/sites/sellright/packages/api
EnvironmentFile=/home/vendure/.sellright/env
Environment=NODE_ENV=production PORT=3300 JOBS_ENABLED=1
ExecStart=/usr/bin/env pnpm exec tsx src/index.ts
Restart=on-failure
RestartSec=5
[Install]
WantedBy=multi-user.target
```
(Adjust `ExecStart` if a compiled-dist build lands; `DATABASE_URL` must point at `DATABASE_URL_APP` from WP0 — map it in the env file.) Admin: build `packages/admin` to `dist/` and serve statically via nginx — **no systemd unit for a Vite dev server in prod.**

### 6b. nginx + Cloudflare Access
```nginx
# admin.<brand-domain> — behind Cloudflare Access (mirror existing Vendure admin pattern)
server {
  listen 443 ssl; server_name admin.rottenhand.com;
  root /home/vendure/sites/sellright/packages/admin/dist;
  location /v1/ { proxy_pass http://127.0.0.1:3300; proxy_set_header X-Real-IP $remote_addr; }
  location / { try_files $uri /index.html; }
}
```
API for the storefront proxies the same `:3300`. Set `x-store-slug` per vhost or let the storefront send it (it does — `store-context.ts:10` reads the header).

### 6c. Backups
```bash
# scripts-deploy/backup-db.sh — cron: 30 2 * * *
set -euo pipefail
TS=$(date +%F)
pg_dump -p 5433 -U sellright -Fc sellright_dev > /home/vendure/backups/sellright/sellright_${TS}.dump
find /home/vendure/backups/sellright -name '*.dump' -mtime +14 -delete
rclone copy /home/vendure/backups/sellright remote:sellright-backups --max-age 24h   # offsite — pick remote at install
```
**A restore drill into a scratch DB is part of acceptance, not optional.** Upgrade to WAL/PITR (pgBackRest) before DD cutover.

### 6d. Monitoring (minimum mechanism — no observability stack)
Uptime: external check on `GET /v1/health` (UptimeRobot-class, alert to email/Telegram). Errors: `app.ts:62` onError additionally appends JSON-line to a log file; a 5-min cron greps the last window and alerts on threshold. That's it for v1.

### 6e. Load-test gate (added 2026-06-10 — "speed locked down" requires evidence, not design)
k6 (single binary, no infra) against the box from the laptop, on `sellright_test`-seeded data at DD scale (13k orders, full catalog):
```js
// scripts-deploy/loadtest.js — k6 run scripts-deploy/loadtest.js
import http from 'k6/http';
export const options = { scenarios: {
  browse:   { executor: 'constant-vus', vus: 50, duration: '2m', exec: 'browse' },   // manifest+PDP
  checkout: { executor: 'constant-arrival-rate', rate: 5, timeUnit: '1s', duration: '2m', preAllocatedVUs: 30, exec: 'checkout' },
}, thresholds: { http_req_duration: ['p(95)<300'], http_req_failed: ['rate<0.01'] } };
```
Browse hits `GET /v1/shop/catalog/products/{slug}`; checkout exercises the full `POST /v1/shop/checkout` → `/pay` (cod) path with unique idempotency keys. **Thresholds: p95 < 300ms, error rate < 1%, zero oversells in `stock` after the run** (`allocated <= on_hand` for all rows). Run AFTER the WP9 index batch; capture before/after `EXPLAIN ANALYZE` for the top-5 queries in the results note.

**Accept:** reboot the box → API and admin come back unaided; restore drill documented with output; health alert fires when API stopped deliberately; load-test thresholds met with results committed to `docs/fable/LOADTEST-RESULTS-<date>.md`.

## WP7 — RH cutover (gates in [STRATEGY-MOAT-POSITIONING.md](STRATEGY-MOAT-POSITIONING.md) §4)

Pre-flight: all WP0–WP6 accepted; `rotten` store row + catalog imported (importer is DD-specific in field mapping — check `import/catalog.ts` custom-field block against RH's Vendure schema first); end-to-end sandbox order incl. refund; DNS/cache plan; Regime-A rollback rehearsed (point storefront providers back at Vendure GraphQL per flow). Then: storefront → SellRight in production, Vendure warm for 30 days, watch error log + Stripe dashboard daily. **Write the hour-by-hour runbook as a separate doc when WP4 is done — too many unknowns now (honesty: this plan does not contain it).**

## WP8 — Catalog authoring: asset service + admin create UI (added 2026-06-10)

Correcting the audit: the create **API already exists** — `POST /v1/admin/products` (`admin-catalog.ts:43`), `POST /v1/admin/products/{id}/variants` (`:87`), option groups/values (`:425-483`), collections CRUD. The `asset` table exists (`schema.ts:113-122`: `id, store_id, type, path, width, height, alt`) and `product.imageAssetId` references it (`schema.ts:211`). What's missing: **an upload endpoint (none anywhere — grep `upload|multipart` returns nothing), file storage, image serving, and the admin UI pages.**

### 8a. Storage decision: local disk + nginx, NOT S3/R2 for v1
Minimum mechanism: one box, nginx already planned (WP6b). `ASSET_DIR=/home/vendure/sites/sellright-assets/<storeSlug>/` (note: `CATALOG_DIR` manifests already use a sibling pattern). nginx serves `/assets/` from it with long-cache headers; Cloudflare caches in front. S3/R2 + image resizing is the DD-scale upgrade — design the `asset.path` value as a relative key (`<storeSlug>/2026/06/<uuid>.webp`) so the storage backend can swap without a data migration.

### 8b. Upload endpoint — `src/routes/admin-assets.ts` (new, mount in `app.ts`)
```ts
// POST /v1/admin/assets — multipart; field "file"; returns asset row
adminAssets.post('/v1/admin/assets', async (c) => {
  const ctx = await requireAdmin(c);                       // reuse admin-helpers auth (verify exact fn name)
  const body = await c.req.parseBody();                    // Hono multipart
  const file = body['file'];
  if (!(file instanceof File)) return c.json({ error: 'file required' }, 400);
  if (file.size > 10 * 1024 * 1024) return c.json({ error: 'max 10MB' }, 413);
  const buf = Buffer.from(await file.arrayBuffer());
  const img = sharp(buf);                                  // dep: sharp — also re-encodes, which strips any payload hidden in the original
  const meta = await img.metadata();
  if (!meta.format || !['jpeg','png','webp','avif'].includes(meta.format))
    return c.json({ error: 'unsupported format' }, 415);   // magic-bytes validation via sharp, NOT extension/mime-header trust
  const key = `${ctx.store.slug}/${new Date().toISOString().slice(0,7)}/${crypto.randomUUID()}.webp`;
  await fs.mkdir(path.dirname(`${env.ASSET_DIR}/${key}`), { recursive: true });
  await img.webp({ quality: 85 }).toFile(`${env.ASSET_DIR}/${key}`);
  const [row] = await withStore(ctx.store.id, (tx) =>
    tx.insert(s.asset).values({ storeId: ctx.store.id, type: 'image', path: key, width: meta.width, height: meta.height, alt: body['alt']?.toString() ?? null }).returning());
  return c.json(row, 201);
});
```
Plus `DELETE /v1/admin/assets/{id}` (DB row + file; refuse if referenced by `product.imageAssetId`/`collection.imageAssetId`), `GET /v1/admin/assets` (paged list for a picker), and a `product_asset` link question: **check whether multi-image-per-product needs a join table** — current schema is single `imageAssetId`; DD products have galleries. If galleries are required (they are — check `import/catalog.ts` asset handling for what Vendure had), add migration `product_asset(product_id, asset_id, position)` with FORCE RLS.

### 8c. Admin UI (the actual gap per `packages/admin/README.md` "Known gaps")
Pages: product create form (name/slug/description/price → POST products, then variants via option groups), image upload + picker component (drag-drop → POST assets → attach), variant editor for new products. Follow existing page patterns in `packages/admin/src/pages/` (hand-rolled fetch client, not hono hc).

### 8d. Storefront image path
Manifest generator (`manifest/generate.ts`) and catalog REST responses emit asset URLs as `/assets/<path>` — verify how imported DD images are referenced today (currently proxied to Vendure's asset server) and add a migration script that downloads/re-encodes them into `ASSET_DIR` (this also unblocks the DD asset-migration item early).

**Accept:** create a product with two gallery images entirely through the admin UI against dev; images served via nginx with cache headers; `pnpm verify` green (new RLS table covered by assert-force-rls automatically); upload rejects a PHP file renamed `.png`.

## WP9 — Accuracy & security sweep (added 2026-06-10 — every orphaned audit item gets a home)

1. **Fixed-discount line distribution** (`money/totals.ts:51-57`): distribute `fixed` discounts across lines proportionally to `lineSubtotal` (largest-remainder method so cents sum exactly), so `lineDiscount`/`lineTotal` are correct per line — refund and tax math depend on it. Test: $10 off across 3 lines of $7/$11/$13 sums to exactly 1000 with no cent lost.
2. **TOTP replay guard** (`auth/totp.ts:42-47`): store last-accepted `(adminUserId, codeStep)` and reject reuse within the window — one small table or column, no dep.
3. **`session` + `admin_user_store` enumeration** (audit §4 #6): revoke app-role SELECT where possible or add scoped policies; document the chosen stance in the migration header.
4. **Import TRUNCATE guard** (`import/catalog.ts:48` et al.): refuse to run unless target DB name ends `_dev`/`_test` or `--force` passed; print row counts and 5s countdown; close source pool in `finally`.
5. **Guest auto-link by email** (`checkout.ts:157-160`): keep, but mark linked orders `linked_via: 'email_match'` in metadata + exclude from account order list until customer verifies email (decide + document; the silent link is the issue, not the link).
6. **RLS test expansion** (`db/rls.test.ts`): table-driven loop over ALL store-scoped tables from `assert-force-rls.ts`'s discovery query — insert as store A, assert invisible + unwritable as store B, fail-closed without context. One parameterized test kills the whole gap class.
7. **Index batch** — audit §6.7 verbatim, now homed here as migration `00NN_indexes.sql`; verify every column name against `schema.ts` first; run before the WP6e load test.

**Accept:** `pnpm verify` green; RLS suite covers every store-scoped table; discount-distribution property test (random line sets, sum invariant) passes.

## WP10 — Saved cards (vault) — basics-complete payments (added 2026-06-10; needs WP3+WP4)

The `payment_method` table is schema-ready (`gateway, provider_customer_ref, provider_method_ref, brand, last4, exp_month, exp_year, is_default`) and `customer.stripe_customer_id` exists — nothing uses them.
- **Save:** on a logged-in customer's successful payment with consent checkbox: create/reuse Stripe Customer (`stripe_customer_id`), attach the PaymentMethod, insert `payment_method` row with brand/last4/exp from Stripe's response. SellRight stores **refs only — never PAN** (stays SAQ-A).
- **Use:** `GET /v1/shop/account/payment-methods` (list: brand/last4/exp/is_default — refs never leave the server); checkout option `savedMethodId` → server creates PaymentIntent with `customer` + `payment_method` + `off_session: false`, confirm client-side (3DS may still challenge).
- **Manage:** `DELETE /v1/shop/account/payment-methods/{id}` (detach at Stripe + delete row); set-default.
- Expiry hygiene: `webhooks/stripe` handles `payment_method.updated/detached` to sync the vault row.

**Accept:** sandbox flow — pay & save → second order pays with saved card without re-entering details → delete card → it's gone at Stripe too.

---

## Not in this plan (explicit)
- NMI + Sezzle providers (DD cutover — spec after Stripe proves the provider model; NMI Collect.js tokenization keeps SAQ-A scope, Sezzle is `requiresRedirect: true` — the flag exists for it).
- S3/R2 + on-the-fly image resizing — WP8a's relative-key design makes this a drop-in upgrade at DD scale; local disk + Cloudflare cache is v1.
- PCI formal scoping, multi-brand rollout sequencing beyond RH→DD, HA/standby Postgres (single-box reliability accepted per Adrian 2026-06-10 — Hetzner uptime + systemd + backups + PITR-before-DD is the stance).
