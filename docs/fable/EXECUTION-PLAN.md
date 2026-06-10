# SellRight — Execution Plan to RH Cutover (2026-06-10)

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

**Work package order** (dependencies, not durations): WP0 → WP1 → {WP2, WP3 in parallel} → WP4 (needs WP2+WP3) → WP5 (needs WP4) → WP6 anytime → WP7 last.

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

**Accept:** reboot the box → API and admin come back unaided; restore drill documented with output; health alert fires when API stopped deliberately.

## WP7 — RH cutover (gates in [STRATEGY-MOAT-POSITIONING.md](STRATEGY-MOAT-POSITIONING.md) §4)

Pre-flight: all WP0–WP6 accepted; `rotten` store row + catalog imported (importer is DD-specific in field mapping — check `import/catalog.ts` custom-field block against RH's Vendure schema first); end-to-end sandbox order incl. refund; DNS/cache plan; Regime-A rollback rehearsed (point storefront providers back at Vendure GraphQL per flow). Then: storefront → SellRight in production, Vendure warm for 30 days, watch error log + Stripe dashboard daily. **Write the hour-by-hour runbook as a separate doc when WP4 is done — too many unknowns now (honesty: this plan does not contain it).**

---

## Not in this plan (explicit)
- NMI + Sezzle providers (DD cutover — spec after Stripe proves the provider model; NMI Collect.js tokenization keeps SAQ-A scope, Sezzle is `requiresRedirect: true` — the flag exists for it).
- Asset/object storage (S3/R2) — blocks DD (image-heavy), not RH cutover if RH images stay on the existing asset host short-term. Decide before DD.
- Index batch (audit §6.7) — fold into any WP's migration; verify column names first.
- Load testing, PCI formal scoping, multi-brand rollout sequencing beyond RH→DD.
