# Plan — World-class server-authoritative cart (2026-06-20)

**Goal:** Make the server `cart` the single source of truth with an optimistic client mirror, so SellRight gets cross-device carts, abandoned-cart analytics, and always-correct pricing — without losing instant add-to-cart UX.

**Architecture:** The backend already has a token-identified, server-priced `cart`/`cart_line` API (`packages/api/src/routes/cart.ts`), separate from orders. Phase A hardens it for production (TTL + cleanup + time-based abandonment + lifecycle events + checkout-reads-from-cart). Phase B replaces the storefront's `LocalCartService`-as-source-of-truth with a server-cart client behind the existing `CartContext` interface (strangler), keeping a thin optimistic mirror for paint, gated by `VITE_SERVER_CART` for rollback.

**Tech stack:** Hono + drizzle/Postgres (api), Qwik (storefront), existing in-process job scheduler, existing webhook `emitEvent`.

## Visual

```mermaid
flowchart LR
  subgraph Client["Storefront (Qwik)"]
    UI["Cart UI"] -->|optimistic update| Mirror["thin local mirror<br/>(paint only)"]
    Mirror -->|sync mutation| SC["ServerCartService<br/>(token in cookie)"]
  end
  SC -->|POST/PATCH /v1/shop/cart| API["cart API<br/>(server-priced, RLS)"]
  API --> DB[("cart / cart_line<br/>+ expires_at")]
  API -->|reconcile response| Mirror
  Checkout["/v1/shop/checkout"] -->|reads items FROM cart by token| DB
  Checkout -->|on success| Conv["cart.status=converted<br/>convertedOrderId"]
  subgraph Jobs["in-process scheduler (JOBS_ENABLED)"]
    J1["cart-abandonment<br/>inactive+lines → abandoned + emit cart.abandoned"]
    J2["cart-cleanup<br/>expires_at < now → delete"]
  end
  J1 --> DB
  J2 --> DB
  classDef done fill:#e3f5ec,stroke:#15803d; classDef new fill:#e8f0fe,stroke:#2563eb;
  class API,DB done; class SC,Mirror,J1,J2,Conv new;
```

Legend: green = exists today, blue = added by this plan.

## File map

**Phase A — backend (api), ships independently:**
| File | Responsibility |
|---|---|
| `packages/api/drizzle/0032_cart_ttl.sql` (new, `--custom`) | `ALTER TABLE cart ADD COLUMN expires_at timestamptz`; index `cart(expires_at)` |
| `packages/api/src/db/schema.ts` (edit) | add `expiresAt` to `cart` table |
| `packages/api/src/env.ts` (edit) | `CART_TTL_DAYS` (default 30), `CART_ABANDON_HOURS` (default 4) |
| `packages/api/src/cart/ttl.ts` (new) | pure helpers: `cartExpiry(now, days)`, `isAbandonable(updatedAt, lineCount, now, hours)` |
| `packages/api/src/cart/ttl.test.ts` (new) | unit tests for the pure helpers |
| `packages/api/src/routes/cart.ts` (edit) | set/extend `expiresAt` on create + every mutation |
| `packages/api/src/routes/checkout.ts` (edit) | when `cartToken` present, derive items from the server cart (ignore client `items`); emit `cart.converted` |
| `packages/api/src/jobs/cart-maintenance.ts` (new) | `abandonStaleCarts()` + `cleanupExpiredCarts()` (per-store, `withStore`) |
| `packages/api/src/jobs/scheduler.ts` (edit) | register the two cart jobs on the tick |

**Phase B — storefront (Qwik), larger; may land in the storefront/RA repo:**
| File | Responsibility |
|---|---|
| `packages/storefront/src/services/ServerCartService.ts` (new) | wraps the cart API; owns the cart token (cookie); optimistic apply + reconcile |
| `packages/storefront/src/contexts/CartContext.tsx` (edit) | back the existing context interface with `ServerCartService` when `VITE_SERVER_CART=1`, else `LocalCartService` (strangler + rollback) |
| `packages/storefront/src/hooks/useCheckout.ts` (edit) | pass the cart token to `/checkout` (items come from the server cart) |
| component touch-ups (`Cart.tsx`, `CartContents.tsx`, `header.tsx`, product page) | consume the same context interface — no logic change |

## Phase A — tasks (TDD, complete code)

### Task A1 — pure TTL/abandonment helpers (test first)
Create `packages/api/src/cart/ttl.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { cartExpiry, isAbandonable } from './ttl.js';

describe('cartExpiry', () => {
  it('adds TTL days to now', () => {
    const now = new Date('2026-06-20T00:00:00.000Z');
    expect(cartExpiry(now, 30).toISOString()).toBe('2026-07-20T00:00:00.000Z');
  });
});

describe('isAbandonable', () => {
  const now = new Date('2026-06-20T12:00:00.000Z');
  it('true when it has lines and is older than the window', () => {
    expect(isAbandonable(new Date('2026-06-20T07:00:00.000Z'), 2, now, 4)).toBe(true); // 5h > 4h
  });
  it('false when empty', () => {
    expect(isAbandonable(new Date('2026-06-20T00:00:00.000Z'), 0, now, 4)).toBe(false);
  });
  it('false when still within the window', () => {
    expect(isAbandonable(new Date('2026-06-20T10:00:00.000Z'), 3, now, 4)).toBe(false); // 2h < 4h
  });
});
```
Run: `pnpm --filter @sellright/api exec vitest run src/cart/ttl.test.ts` → **fails** (module missing).

Create `packages/api/src/cart/ttl.ts`:
```ts
/** Pure cart lifecycle math. Kept env-free so it's unit-testable. */
export function cartExpiry(now: Date, ttlDays: number): Date {
  return new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000);
}

/** A cart is abandonable when it holds items and has been inactive past the
 *  window. Empty carts are never "abandoned" — they're just idle sessions. */
export function isAbandonable(updatedAt: Date, lineCount: number, now: Date, windowHours: number): boolean {
  if (lineCount <= 0) return false;
  return now.getTime() - updatedAt.getTime() >= windowHours * 60 * 60 * 1000;
}
```
Run again → **passes** (5 assertions).

### Task A2 — env knobs
Edit `packages/api/src/env.ts`, after the `STOREFRONT_URL` line, add:
```ts
  // Cart lifecycle: hard TTL (cleanup deletes past this) + inactivity window
  // after which a cart with items is marked abandoned (analytics/recovery).
  CART_TTL_DAYS: z.coerce.number().int().positive().default(30),
  CART_ABANDON_HOURS: z.coerce.number().int().positive().default(4),
```
Run: `pnpm --filter @sellright/api typecheck` → no errors.

### Task A3 — schema + migration for `expires_at`
Edit `packages/api/src/db/schema.ts` — in the `cart` table, after `updatedAt: ts(),` add:
```ts
  expiresAt: timestamp({ withTimezone: true }),
```
Create the migration via the repo's `--custom` workflow (plain `generate` mis-fires — snapshot drift; see commit f23b7cc):
`DATABASE_URL=… npx drizzle-kit generate --custom --name=cart_ttl`
Then write `packages/api/drizzle/0032_cart_ttl.sql`:
```sql
-- Custom SQL migration file, put your code below! --
ALTER TABLE cart ADD COLUMN IF NOT EXISTS expires_at timestamptz;
CREATE INDEX IF NOT EXISTS cart_expires_idx ON cart (expires_at);
-- abandonment scan: store-scoped, by activity
CREATE INDEX IF NOT EXISTS cart_store_status_updated_idx ON cart (store_id, status, updated_at);
```
Run: `pnpm --filter @sellright/api typecheck` → no errors. (Apply on box: `pnpm --filter @sellright/api db:migrate`.)

### Task A4 — set/extend `expiresAt` on create + mutations
In `packages/api/src/routes/cart.ts`:
- import: `import { env } from '../env.js';` and `import { cartExpiry } from '../cart/ttl.js';`
- In the create handler (`POST /v1/shop/cart`), set expiry on insert:
```ts
        .values({ storeId: st.id, token, customerId: customer?.id ?? null, email: body.email ? normalizeEmail(body.email) : null, expiresAt: cartExpiry(new Date(), env.CART_TTL_DAYS) })
```
- In `applyLines`, change the touch-updatedAt write to also extend expiry:
```ts
  const now = new Date();
  await tx.update(s.cart).set({ updatedAt: now, expiresAt: cartExpiry(now, env.CART_TTL_DAYS), status: 'active' }).where(eq(s.cart.id, cartId));
```
(Re-activates a cart that a job had marked `abandoned` if the shopper returns.)
Run: `pnpm --filter @sellright/api typecheck && pnpm --filter @sellright/api build` → clean.

### Task A5 — cart maintenance jobs
Create `packages/api/src/jobs/cart-maintenance.ts`:
```ts
/** Cart lifecycle jobs: mark inactive non-empty carts abandoned (emit an event
 *  for analytics/recovery), and hard-delete carts past their TTL. Per-store,
 *  store-scoped via withStore. Mirrors the other jobs' shape. */
import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { emitEvent } from '../webhooks/emit.js';

async function activeStoreIds(): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>('select id from store');
  return rows.map((r) => r.id);
}

/** Mark active carts with items + no activity for `windowHours` as abandoned. */
export async function abandonStaleCarts(windowHours: number): Promise<{ abandoned: number }> {
  let abandoned = 0;
  const cutoff = new Date(Date.now() - windowHours * 60 * 60 * 1000);
  for (const storeId of await activeStoreIds()) {
    abandoned += await withStore(storeId, async (tx) => {
      const stale = await tx
        .select({ id: s.cart.id, token: s.cart.token, email: s.cart.email })
        .from(s.cart)
        .where(and(eq(s.cart.status, 'active'), isNull(s.cart.convertedOrderId), lt(s.cart.updatedAt, cutoff),
          sql`exists (select 1 from cart_line cl where cl.cart_id = ${s.cart.id})`));
      for (const c of stale) {
        await tx.update(s.cart).set({ status: 'abandoned', updatedAt: new Date() }).where(eq(s.cart.id, c.id));
        await emitEvent(tx, storeId, 'cart.abandoned', { token: c.token, email: c.email });
      }
      return stale.length;
    });
  }
  return { abandoned };
}

/** Purge ONLY idle/empty expired carts (active, no lines) past TTL. Abandoned
 *  carts are KEPT — they are the analytics/recovery record, so cleanup never
 *  destroys abandonment data (council P1). Batched delete, no per-row loop. */
export async function cleanupExpiredCarts(): Promise<{ deleted: number }> {
  let deleted = 0;
  const now = new Date();
  for (const storeId of await activeStoreIds()) {
    deleted += await withStore(storeId, async (tx) => {
      const stale = await tx.select({ id: s.cart.id }).from(s.cart).where(
        and(lt(s.cart.expiresAt, now), eq(s.cart.status, 'active'), isNull(s.cart.convertedOrderId),
          sql`not exists (select 1 from cart_line cl where cl.cart_id = ${s.cart.id})`));
      if (!stale.length) return 0;
      const ids = stale.map((c) => c.id);
      await tx.delete(s.cartLine).where(inArray(s.cartLine.cartId, ids)); // defensive; none expected
      await tx.delete(s.cart).where(inArray(s.cart.id, ids));
      return ids.length;
    });
  }
  return { deleted };
}
```
> Retention of `abandoned` carts is intentional (the analytics record). A separate, longer-horizon archival/anonymization policy can prune them later — out of scope here. `inArray` is already imported in the jobs' drizzle imports.

Edit `packages/api/src/jobs/scheduler.ts` — import the two functions, call them in the tick (guarded by `JOBS_ENABLED`), and **log the counts** (operator observability, council P2):
```ts
  const ab = await abandonStaleCarts(env.CART_ABANDON_HOURS);
  const cl = await cleanupExpiredCarts();
  if (ab.abandoned || cl.deleted) console.log(`[jobs:cart] abandoned=${ab.abandoned} purged=${cl.deleted}`);
```
Run: `pnpm --filter @sellright/api typecheck && pnpm --filter @sellright/api build` → clean. (Jobs are no-ops in tests via the existing `NODE_ENV==='test'` guard.)

### Task A6 — checkout reads items from the server cart (fail-closed)
In `packages/api/src/routes/checkout.ts`, when `body.cartToken` is present, the **server cart is authoritative** — derive items from it and do NOT fall back to client `items[]` (council P1: a fallback re-opens trust-the-client-item-list). After resolving the store, before pricing:
```ts
    let items = body.items;
    if (body.cartToken) {
      const cartItems = await withStore(st.id, async (tx) => {
        const [row] = await tx.select({ id: s.cart.id, status: s.cart.status }).from(s.cart).where(eq(s.cart.token, body.cartToken!)).limit(1);
        if (!row || row.status === 'converted') return null;
        const lines = await tx.select({ sku: s.cartLine.sku, quantity: s.cartLine.quantity }).from(s.cartLine).where(eq(s.cartLine.cartId, row.id));
        return lines.map((l) => ({ sku: l.sku, quantity: l.quantity }));
      });
      if (!cartItems || cartItems.length === 0) return c.json({ error: 'cart is empty, invalid, or already checked out' }, 409);
      items = cartItems; // fail-closed: never fall back to client items when a token is given
    }
```
Then replace the three subsequent `body.items` references in the handler with `items`: the `skus` set (`[...new Set(body.items.map…)]`), `validateReservableItems(body.items, …)`, and `reserveStockOrThrow(tx, st.id, body.items, …)` (and the `priced = body.items.map(…)`). Add the 409 to the OpenAPI responses. Emit on conversion (next to the existing `cart.status='converted'` update at line ~297):
```ts
        await emitEvent(tx, st.id, 'cart.converted', { token: body.cartToken, orderId, code });
```
> Backward compat: with **no** `cartToken` (legacy local-cart path, pre-flag), behaviour is unchanged — client `items[]` are still server-priced. The fail-closed rule applies only once a token is sent (Phase B).

Run: `pnpm --filter @sellright/api typecheck && pnpm --filter @sellright/api test` → green (88+ tests).

## Phase B — storefront (architecture + enumerated tasks)

**Strategy (strangler + flag):** introduce `ServerCartService` implementing the same surface the UI already uses via `CartContext` (`getCart`, `addItem`, `removeItem`, `updateQty`, `clear`). `CartContext` chooses the backing impl by `import.meta.env.VITE_SERVER_CART`. Components keep consuming the context unchanged → rollout/rollback is a flag flip.

> **SCOPE (post-jury):** Phase A is the **implement-now** deliverable of this plan (complete TDD, backend, ships independently behind no flag). **Phase B is a design spec, NOT implementable from this doc** — `/jury` (NEEDS-REVISION, 3/3) ruled it needs its own complete `/architecture-design` pass before any storefront code: the optimistic-rollback state machine, concurrent-tab race handling, and reconciliation failure modes must be specified with tests. The items below are the *input* to that sub-plan, likely in the storefront/RA repo per the SellRight↔RightApps split rule. Do not build Phase B from these bullets.

- **B0 — local→server migration on cutover (council P1):** on first load under `VITE_SERVER_CART=1`, if a legacy `vendure_local_cart` exists in `localStorage` and there is no `sr_cart` token yet, create a server cart seeded with those lines (`POST /v1/shop/cart {items}`), store the returned token in the `sr_cart` cookie. **Do NOT delete the legacy `localStorage` key** until a server fetch confirms the cart synced — and even then keep it as a dormant copy so a flag-OFF rollback restores the local cart with zero data loss (jury: B0 was one-way).
- **B1 — `ServerCartService.ts`:** owns the cart token (`sr_cart` cookie, created lazily on first add via `POST /v1/shop/cart`). Each mutation: (1) apply optimistically to the in-memory mirror + paint; (2) `PATCH /cart/{token}/lines`; (3) on success, **replace** the mirror with the server-priced response (server wins — covers price/stock/coupon truth); (4) on failure, **roll back** the optimistic change to the last server snapshot and surface a toast ("couldn't update cart"). Line semantics: the API line-update is **absolute** (set quantity), so the optimistic add must send the *resulting* quantity, not a delta (the additive path is only `merge`). Cross-tab sync via `BroadcastChannel('sr_cart')` → refetch on remote change.
- **B2 — `CartContext.tsx`:** behind `VITE_SERVER_CART`, delegate to `ServerCartService`; otherwise keep `LocalCartService`. Same exported hook shape so `Cart.tsx`/`CartContents.tsx`/`header.tsx`/product page don't change.
- **B3 — `useCheckout.ts`:** send `cartToken` (from the cookie) to `/v1/shop/checkout`; items come from the server cart (A6). On a 409 (empty/converted cart) refetch + show the cart.
- **B4 — merge on login:** after auth, call `POST /cart/{token}/merge` (endpoint exists) then refresh context.
- **B5 — guest→account email capture:** on checkout email entry, `PATCH /cart/{token}` (endpoint exists) so abandonment has contact info.

**Pure logic to unit-test (no DOM):** `mergeOptimistic(serverCart, pendingMutation)` and `rollbackTo(lastServerSnapshot)` — covering server-wins reconcile + failure rollback. Manual/`/qa` verification: optimistic add feels instant; a forced stock failure rolls the line back with a toast; reload restores from server; a second device shows the same cart; an idle cart with items becomes an abandoned-cart row after `CART_ABANDON_HOURS`; flipping the flag preserves an existing local cart (B0).

## Self-review notes
- Spec coverage: TTL ✓, cleanup ✓, abandonment+event ✓, checkout-from-cart ✓, storefront swap ✓, merge/email reuse existing endpoints ✓.
- Type consistency: `cartExpiry`/`isAbandonable` names consistent across A1/A4/A5; `expiresAt`↔`expires_at` (drizzle snake_case casing).
- No placeholders in Phase A. Phase B component touch-ups are enumerated (mechanical, repo-specific to the Qwik storefront).
- Sequencing: Phase A ships first (additive, decision-free); Phase B is the UX swap (flagged).

## Review gates

- **/council (advisory):** REFINE → 4 P1s fixed (cleanup preserves abandoned carts + batches/logs; checkout fail-closed; B0 migration; Phase B reconciliation/rollback specced).
- **/jury jury-plan (3 jurors):** **NEEDS-REVISION (3/3, avg 6.0)** — Phase A sound; Phase B not a buildable TDD plan. **Resolution:** Phase A is the implement-now scope; **Phase B is gated to its own `/architecture-design` pass** before any storefront code. Remaining jury blockers addressed in-doc:
  - *Event-burst:* `emitEvent` writes to the transactional **webhook outbox** (`webhook_delivery`), drained by the existing sender/reaper with backoff — so a burst is bounded rows, not a synchronous storm. Additionally **cap the abandonment job to N carts/run** (e.g. 500) so a backlog spreads across ticks.
  - *Observability/SLIs:* scheduler logs `abandoned`/`purged` counts (A5); add to track on rollout — checkout **409 rate** (fail-closed empty-cart), Phase B **optimistic-rollback rate**, abandonment-job duration. Alert on a 409 spike (signals a Phase B cart-sync bug).
  - *B0 one-way:* fixed — keep the dormant `localStorage` copy so a flag-OFF rollback is lossless.
  - *Schema scale:* `expires_at` + `(store_id,status,updated_at)` indexes added (A3); the abandonment/cleanup scans are index-served and store-scoped.

### Critical Files for Implementation
- packages/api/src/cart/ttl.ts
- packages/api/src/jobs/cart-maintenance.ts
- packages/api/src/routes/cart.ts
- packages/api/src/routes/checkout.ts
- packages/storefront/src/services/ServerCartService.ts
