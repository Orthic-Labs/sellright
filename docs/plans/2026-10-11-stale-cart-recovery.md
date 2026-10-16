# Converted-cart handling (no recovery) — design (v5.1)

Status: **v5.2** (v5.1 plus §4.3: entry decision, late resume and resume payment recovery as implemented after review rounds 1-2). Replaces v1-v4 ("stale-cart recovery") with the minimal design recommended in `.work/agents/2026-10-11/stale-cart.astra-minimal.txt`, which is the specification. v5.1 resolves the three open findings of `stale-cart.astra5.json`: **lock ownership** (§4.1a, finding 1), **a resume view that bypasses the form gates** (§4.3, finding 2) and **CartContext synchronisation after classified failures** (§4.4, finding 3). Its code is implemented in the working tree.
Base: `main` @ `af32fb1`. All `file:line` references were checked against that commit. Storefront paths are relative to `packages/storefront/src/`; API paths to `packages/api/src/`.

## 1. Decision

**Deleted carts are not recovered.** A token whose row is gone stays gone: the shopper is told to re-add. The work fixes **converted-cart handling** and the races that can erase a converted cart's token. That token is the browser's only path back to an unpaid order.

**Accepted limitation:** an unpaid converted cart occupies the browser's single cart slot until its order is paid or cancelled. The shopper can continue checkout, but cannot start another cart in that browser until then.

### Why v1-v4 were dropped

v1-v4 grew into three products: cart restoration (successor carts, a ledger), concurrent cart replacement (compare-and-set and fences on a shared cookie), and durable discovery of unpaid orders (HttpOnly payment anchors, `GET /checkout/pending`, `?resume=`). Four review rounds produced 21 findings (`stale-cart.astra1-4.json`). Most were caused by that scope: successor merge eligibility (R1-1, R2-4, R4-4), ledger cardinality (R1-4), anchor namespacing, starvation and pre-deployment orders (R4-2, R4-3, R4-5), and the lockless fallback (R3-1). None of those three products is needed to fix the original defect, F1: a converted cart's cookie can be erased.

Restoration helps only while the original row survives, and that already works. `GET /v1/shop/cart/{token}` returns any row, `abandoned` included (`routes/cart.ts:434-437`), and line mutations reactivate an abandoned cart under the same token (`routes/cart.ts:354-355`). After the purge, the lines are gone. Recovering them would need longer retention or new storage. Recreating an empty cart under a missing token would erase the difference between a purged, unknown and wrong-store token.

The simplest future improvement is a longer `config.cart.retentionDays` (`env.ts:100-116`, `jobs/cart-maintenance.ts:6-14`), if the owner changes the 2026-09-24 retention decision. That keeps the existing identity and needs no successors. **It is not part of this fix.**

## 2. Invariants

- **I1. Missing means missing.** A definitive `404 CART_NOT_FOUND` (`ApiError.code`, `storefront-client/src/errors.ts:28`; emitted at `routes/cart.ts:440,480,519,601`) retires the token **that request used**. The shopper is told to re-add. The failed operation never creates or seeds a replacement. A network failure, a timeout or a 404 with any other code does not authorise retirement.
- **I2. Converted and merged are terminal.** A converted cart keeps its token. A merged cart may retire its own token. No mutation retries against a converted cart.
- **I3. Identity is bound to the request.** A response for token T cannot change the cookie or mirror for a different token U. Adopting a snapshot never installs a different cart identity. Only cart creation installs one.
- **I4. One origin-wide lock.** Every cart operation in a cooperating storefront tab runs under one exclusive Web Lock (`sr-cart`). It is held from cookie selection through network completion and local commit. Checkout holds the same lock across its live read and its order POST. Web Locks are not re-entrant, so each public operation acquires the lock exactly once and internal helpers never reacquire it (§4.1a). This trades concurrency for a much smaller correctness argument.
- **I5. Retirement needs proof.** A cookie is cleared only when it still names T and one of these holds: T is definitively missing (I1); T is `merged`; or a read of T's original order shows it settled or cancelled. A confirmation page additionally requires the order code returned for T to equal the code it displays. A failure or an ambiguous result keeps the token. `Declined` alone is not enough: a failed payment attempt leaves the order `PendingPayment` (`api/src/money/fsm.ts:3-7`).
- **I6. Stock rule (LOCKED).** A new order keeps the live stock read, revision check and form validation before its POST. Resuming an existing order uses its stored checkout and payment authorization, whatever the current catalog availability is. Nothing is cached; no TTL, debounce or sessionStorage is added.

## 3. API

**No new endpoints, migrations, statuses or jobs.** `routes/cart.ts`, `jobs/cart-maintenance.ts` and the checkout conversion semantics are unchanged.

The storefront reuses `GET /v1/shop/cart/{token}/checkout` (`routes/checkout.ts:958-978`). It is store-scoped and read-only. It returns the converted cart's original order as `{ code, state, grandTotal, receiptToken, currency, … }` (`orderReplayResult`, `routes/checkout.ts:156-168`). It returns `404 ORDER_NOT_FOUND` when the cart is not converted or its order is gone, and never creates an order. Converted carts are never purged (`env.ts:111-112`), so the lookup keeps working for as long as the order exists.

## 4. Storefront change list

### 4.1 `services/CartService.ts`

1. **Lock.** Add a private `exclusive<T>(fn)` that wraps `navigator.locks.request('sr-cart', { mode: 'exclusive' }, fn)`; with no Web Locks it throws `CartError('unsupported', …)` before `fn` runs (§6). Lock ownership is defined in §4.1a. Each network call is bounded by the client's existing 8 s timeout (`storefront-client/src/client.ts:19-20,124-128`), so a hung request cannot hold the lock for long.
2. **`token()`** (`:91-93`) returns `readTokenCookie()` only. It must not prefer `this.cart.token`, which may name an older cart.
3. **Mirror adoption vs identity installation.** Split `adopt()` (`:133-147`) into two functions:
   - `install(server, requestToken)` writes the mirror only. It applies only if `server.token === requestToken === readTokenCookie()`; otherwise it is a no-op. It never writes the cookie. The existing `snapshotSeq` guard stays.
   - `createCart()` (from `ensureCart`, `:217-230`) is the **only** cookie writer (`writeTokenCookie`, `:106-110`).
   On lock entry, if the cookie no longer equals `this.cart.token` (another tab changed it), reset the mirror, coupon and enrichment before the operation proceeds.
4. **Creation and legacy migration.** `ensureCart` re-reads the cookie inside the lock. If it now exists (another tab created a cart while this one waited), use it. Otherwise consume the legacy key (`:170-214`), `POST /v1/shop/cart`, and write the cookie. Removing the legacy key before the POST stays as today (`:179-183`). If the response is lost, the legacy lines are lost rather than duplicated in an orphan, signed-in cart that the donor scan could later fold (`routes/cart.ts:556-562`). There is no automatic retry of the create.
5. **Retirement.** Replace `discard()` (`:151-158`) with private `retire(requestToken)`. It clears the cookie (`clearTokenCookie`, `:112-115`), mirror, coupon and enrichment only if `readTokenCookie() === requestToken`. Callers reach it through the classifier (I1, I2), `scope.retire` (merged checkout) or `retireSettled(expectedCode?)` (§4.4). There is no public unconditional `discard`.
6. **Error boundary.** One private classifier, used by every path:
   - `404 CART_NOT_FOUND` → `retire(T)`, then throw `CartError('not_found', …re-add…)`.
   - `409 merged` → `retire(T)`, then throw `CartError('merged')`.
   - `409 converted` → `install(conflict.cart, T)` (same token, so the mirror shows `status: 'converted'`), then throw `ConvertedCartError` (a `CartError` with code `'converted'`). The token is kept and the mutation is not retried.
   - Anything else (other 404 codes, network errors, timeouts, 5xx) → rethrow. The token and mirror are unchanged.
7. **Callers routed through the boundary** (each is a public entry or an in-lock internal per §4.1a):
   - `withRevisionRetry` (`:254-293`), with cold-start revision acquisition (`ensureRevision`, `:233-244`) moved inside it. Today a cold-start 404 escapes at `:258-259` and leaves a dead cookie in place. The second-attempt failure at `:282-285` now also uses the classifier, so a converted 409 on the retry is reported as converted, not as a generic conflict. The single stale/`revision_required` retry is kept.
   - `addLine` (`:298-316`). No automatic retry of the append after an uncertain network result.
   - `refresh` (`:343-363`; a missing cart now throws `not_found` after retiring, instead of returning an empty result), `readFresh` (`:369-387`), `applyCoupon` (`:391-405`), `removeCoupon` (`:408-426`), `captureEmail` (`:429-436`), `merge` (`:439-445`) and `checkoutSnapshot` (`:452-469`). `captureEmail` and `merge` have no storefront callers today (grep), but they are public and are routed through the boundary anyway.
8. **`adoptConflict`** (`:161-163`) becomes `adoptConflict(cart, requestToken)` → `install`. Inside the checkout it is reached as `scope.adoptConflict`; the public form takes its own lock.
9. **New `lookupConvertedCheckout(token)`** calls `GET /v1/shop/cart/{token}/checkout` and returns the result or a typed failure (`not_converted` for 404 `ORDER_NOT_FOUND`, `unavailable` for anything else). It writes nothing, so it does not need the lock (§5).

### 4.1a Lock ownership (finding 1)

**Rule: one lock owner per public operation.** Every cart-changing operation has exactly one *entry point* that acquires `sr-cart`. The work it does lives in private *unlocked internals* (`…InLock`, `ensureCart`, `ensureRevision`, `withRevisionRetry`, `install`, `retire`, `classify`) that never call `exclusive` and never call a public method. A public method either acquires the lock itself or delegates to exactly one other public method; it never does both.

Code that already runs inside the lock (the checkout) does not call public methods. `CartService.withLock(fn)` acquires the lock once and hands `fn` a **`CartLockScope`**, a capability object whose methods are the unlocked internals, valid only until `fn` settles (a call after release throws):

```
interface CartLockScope {
  readFresh(): Promise<ServerCart>;                        // unlocked live read, classified
  adoptConflict(cart: ServerCart, requestToken: string): void;   // install(cart, token)
  retire(requestToken: string): void;                      // token-bound retire
}
```

| Caller | Entry point it uses | Lock acquisitions |
|---|---|---|
| `CartContext` add/update/remove/coupon/refresh | public `addLine`, `updateLine`, `applyCoupon`, `removeCoupon`, `refresh` | 1 each |
| `removeLine(sku)` | delegates to public `updateLine(sku, 0)`; takes no lock of its own | 1 |
| `captureEmail`, `merge` | own entry → `withRevisionRetryInLock` | 1 |
| `checkoutSnapshot` | own entry (not used by checkout) | 1 |
| Standalone `readFresh()` | own entry → `readFreshInLock` | 1 |
| **Pre-submit stock hook** | `refreshStockBeforeSubmit(scope)` calls `scope.readFresh()` (no scope argument → falls back to public `readFresh()`, for independent callers and legacy tests) | 0 extra (inside `withLock`) |
| **`useCheckout.placeOrder`** | one `CartService.withLock(scope => …)` around `refreshStockBeforeSubmit(scope)` **and** `srPlaceOrder(form, snapshot, scope)` | 1 |
| **`placeOrder`** conflict handling (`adoptConflict`, merged `retire`) | `scope.adoptConflict(cart, snapshot.token)`, `scope.retire(snapshot.token)` | 0 extra |
| Public `adoptConflict(cart, token)` | own entry → `install`, for callers outside a lock (none in the storefront today) | 1 |
| `retireSettled(expectedCode?)` | own entry; calls `lookupConvertedCheckout` (lock-free) then `retire` | 1 |
| `lookupConvertedCheckout(token)` | none: it writes nothing | 0 |

Lock-free read-only paths (no Web Locks): `refresh` falls back to a read that only installs the mirror under the `install` fence and never retires; `lookupConvertedCheckout` never needs the lock (§6).

Helpers assert they run inside the lock (a `held` flag set by `exclusive`); a lock-free `refresh` does not call them. This is a misuse tripwire, not a re-entrancy check (a second caller waiting for the lock also sees the flag only after it owns it).

### 4.2 `providers/shop/checkout/checkout.ts` and `hooks/useCheckout.ts`

- `placeOrder(form, snapshot, scope)` (`checkout.ts:83-137`) takes the request token from the snapshot and a `CartLockScope`. Remove the unconditional discards at `:90` (merged) and `:125` (converted/merged 409). Merged (snapshot or 409) → `scope.retire(snapshot.token)`. A converted 409 → `scope.adoptConflict(conflict.cart, snapshot.token)` and a typed `ConvertedCartError`; the token is kept. Stale/revision_required → `scope.adoptConflict(conflict.cart, snapshot.token)`.
- If `snapshot.status === 'converted'`, `placeOrder` throws `ConvertedCartError` **without POSTing**. `hooks/pre-submit-stock.ts` keeps returning the converted snapshot after its live read; `placeOrder` decides what to do with it. `useCheckout.placeOrder` catches `ConvertedCartError`, sets `state.convertedCart`, and the page switches to resume (§4.3).
- `useCheckout.placeOrder` (`useCheckout.ts:63-114`) runs `refreshStockBeforeSubmit(scope)` **and** `srPlaceOrder(form, snapshot, scope)` inside one `CartService.withLock` (§4.1a). The new-order path keeps its live read and validation (I6).
- New `useCheckout.resumeConverted(token)`: call `lookupConvertedCheckout`, then decide with a new pure `decideResumeStage(state, grandTotal)` in `hooks/checkout-stage.ts`:
  - `PendingPayment`, total > 0 → `payable`. Reuse the existing payment initialisation (`useCheckout.ts:93-103`, extracted to a shared `initPayment`) with the lookup's `code` and `receiptToken`.
  - `PendingPayment`, total 0 → reuse the zero-due settle (`:81-91`).
  - Settled (`Paid`, `PartiallyRefunded`, `Refunded`) → `settled`. Navigate to the confirmation page, which retires the token (§4.4).
  - `Cancelled` → `cancelled`. Show the cancelled state and offer a new cart (§4.4).
  - Any other or unknown state → `error`, retryable; the token is kept.
  Order-state classification (`settled` / `cancelled` / `payable` / unknown) is one pure module, `services/order-state.ts`, shared by `decideResumeStage` and `retireSettled`. `Declined`, `AddingItems` and any unrecognised state are unknown (I5). Cancelled and unknown states never reach `decideCheckoutStage` (`checkout-stage.ts:21-27`). Today it would send any non-`Paid`, non-zero order to `card-required`.

### 4.3 `routes/checkout/index.tsx`, `components/checkout/CheckoutPageView.tsx`, new `components/checkout/CheckoutResumePanel.tsx` (finding 2)

`CheckoutPaymentPanel` is **not** reused for resume. It collapses and hides its payment controls unless `isCustomerValid && isShippingAddressValid` (`CheckoutPaymentPanel.tsx:130-131`) and asks for a shipping address (`:259-262`). Mounting it for a returning guest with an empty form would leave an unpaid order unpayable. Its behaviour is unchanged (only two small helpers, `availableMethods` and `METHOD_LABEL`, are now exported for the resume panel to share), so new-order validation is untouched (I6).

- **New `CheckoutResumePanel`.** A minimal payment view with no address form, no step indicator and no validation context. It shows the original order code and total, an optional line list, a method selector (only when more than one method is configured), and mounts the existing `StripePaymentElement`, `NMI` and `Sezzle` components directly, each driven by `srState` (`code`, `receiptToken`, `clientSecret`, `grandTotal`). It shares **payment initialisation only** with the new-order path: `useCheckout.initPayment` (PaymentIntent mint) and the same payment components. It also renders the `loading`, `error` (with Retry), `cancelled` (with Start a new cart) and `settled` (redirecting) states.
- **Entry decision.** Entry is `enterCheckout`: it starts the shop-config read, does the live cart read (`refreshCartLive`, an unconditional `CartService.refresh()` returning `'ok' | 'failed'`; the lines-gated `refreshCartStock` would skip a freshly loaded, still empty mirror), then applies the pure `decideCheckoutEntry({ status, readFailed, hasToken })`: `converted` → `resume`; a **failed** read with a token → `probe`; otherwise `normal`. A failed read proves nothing about the cart, so it never selects the normal checkout. `resume` and `probe` call `beginResume` **before** the empty-cart gate, the stock task, the form/shipping validation and the item check. `probe` does the read-only order lookup without repricing: an order found shows the resume view; no order or a failed lookup is a retryable "We couldn't load your cart." with the token kept. Checkout entry still performs exactly one live read (stock rule I6 unchanged). `normal` first runs `resetOrderState` (below), then `loadNormalCheckout` (customer, countries, address, destination country).
- **Late resume.** A conversion discovered after initialisation (a drawer action, a later refresh, another tab's order reaching the mirror) is caught by a `useVisibleTask$` that tracks `cart.status`, `pageLoading` and `isOrderProcessing` and calls `beginResume` when the pure `shouldResumeLate` holds: converted, no resume view yet, no order of this tab, page initialised, no PLACE ORDER running. `beginResume` is single-flight (`resumeBusy`), so entry, PLACE ORDER (`srState.convertedCart`) and the late task cannot start it twice. The resume view therefore replaces an incomplete form or an empty-cart view at any time.
- **Shop config (review round 2).** Every read of the config goes through `ensureShopConfig`, which resolves only after `applyShopConfig` has run; there is no fire-and-forget request. The default method (stripe > nmi > sezzle, `defaultPaymentMethod`) is applied **once** (`shouldApplyConfigDefault`): a later completion refreshes the config but never overwrites the shopper's selection or the client secret belonging to it. `beginResume` treats a failed read as a retryable error; PLACE ORDER awaits it before the POST and refuses (no order is created) when it cannot be read, instead of reading a null config as "configured".
- **Leaving a resume state.** One reset clears everything bound to the previous order: `useCheckout.resetOrder` (`EMPTY_ORDER_STATE`: phase, which releases the method lock, code, receiptToken, clientSecret, method, totals, `resume`, `convertedCart`, `stockConflict`, `resumeLines`, errors) plus the confirm triggers, the total-change consent and the payment-init failure state (`resetOrderState` in the route). It runs on the `normal` entry decision (so a retry after the cookie was replaced by another tab shows a clean checkout for the new cart, never the old order's payment controls) and after "Start a new cart". `resumeConverted` also starts from `EMPTY_ORDER_STATE`, so a cancelled, unknown or failed outcome of a second lookup cannot keep the first order's `paying` phase.
- **Resume payment recovery.** `CheckoutPaymentPanel` is not used, and neither is the form-error handler: `onPaymentError$` branches on `srState.resume !== 'none'` to `recoverResumePaymentError`, which reads the order and classifies it with `classifyOrderState` (`classifyResumePaymentError`): paid-family → confirmation; `PendingPayment` → controls stay and `srState.paymentError` shows a message (a decline); `Cancelled` → `cancelled` view (offers Start a new cart); unknown state or unreadable order → `error` view with retry and no controls (a blind retry could double-pay).
- **Payment-component initialisation failures (review round 2).** A decline and a failed load are different. `StripePaymentElement` and `NMI` report a failed load through the optional `onInitError$` (falling back to `onError$`), confirm/charge failures through `onError$`. `onPaymentInitError$` sets `paymentInit.failed`; both panels then render `PaymentInitRetry` instead of the dead component, and its button remounts the component (`paymentInit.key`) with the same order and client secret: no new order, no network call, and it works with a single configured method. Sezzle has no load step; its button stays usable after a failure.
- `CheckoutPageView` renders `CheckoutResumePanel` **instead of** the empty-cart view and the form layout whenever `srState.resume !== 'none'`. For the line summary, `resumeConverted` calls `getOrder(code, receiptToken)` best-effort; a failure there only omits the summary.
- A failed lookup shows a retryable error and keeps the token. It **never falls through to order creation** (no path from resume reaches `placeOrderNative`). Retry re-runs the whole entry sequence; picking another payment method re-runs `beginResume` for that method.

### 4.4 `contexts/CartContext.tsx` and `routes/checkout/confirmation/[code]/index.tsx`

- Replace `clearCart` (`CartContext.tsx:173-184`) with `retireSettledCart(cartState, expectedCode?)` → `CartService.retireSettled(expectedCode?)`. Under the lock it re-reads the cookie T, calls `lookupConvertedCheckout(T)`, and retires T only if the order is settled or `Cancelled` and, when `expectedCode` is given, `code === expectedCode`. `404 ORDER_NOT_FOUND` (T is a newer, non-converted cart), a code mismatch, a network failure or `PendingPayment` all leave the cookie alone.
- The confirmation page (`index.tsx:61-66`) calls `retireSettledCart(localCart, code)` in place of `clearCart(localCart)`. Revisiting an old confirmation page while a newer cart exists therefore does nothing (closes R2-3).
- **Context follows the service (finding 3).** `CartContext` always shows the service mirror, never a returned or stale copy:
  - `applyResult` (`CartContext.tsx:86-92`) sets `cartState.cart = CartService.getCart()`, not `res.cart`.
  - The provider subscribes to `CartService.onChange` (`bindCartMirror` in `contexts/cart-mirror.ts`, a plain function owning the single subscription) so every mirror change, including the `install` of a converted snapshot and the `retire` after a missing cart, reaches the context even when the operation then throws.
  - Every catch path also runs `reportError`, which re-syncs `cartState.cart` from the mirror and re-announces `cart-updated` (the same `commitMirror` used on success). The two mechanisms are deliberately redundant: the catch-path sync does not depend on a listener being registered yet (for example before `qinit`).
  - The `cart-updated` events (`:131,149,166,182`) carry the quantity of that mirror.
  - The initial refresh failure at `:56-60` reports the `CartError` message rather than a generic one.

### 4.5 `components/cart/Cart.tsx` and `components/cart-contents/CartContents.tsx`

- When `cartState.cart.status === 'converted'`, `Cart.tsx` renders **Continue checkout** → `/checkout`, even with empty or unavailable lines. This bypasses `cartCheckoutReady` (`Cart.tsx:189`) and the button guards (`:346-359`). The converted panel replaces the empty-cart view and the normal footer, so it is reachable with no lines. When the drawer opens on a converted cart, it calls `lookupConvertedCheckout` (client only). **Start a new cart** is offered only when that lookup shows the order settled or cancelled. Clicking it runs `retireSettledCart` (which repeats the verification). Unpaid orders get no escape.
- `CartContents.tsx` disables the quantity select (`:216-217`) and the remove button (`:236`) when the cart is converted.
- The banner decision is a pure function, `cartBannerFor(status, lookup)`, in `components/cart/cart-banners.ts`, so it can be unit-tested. The storefront has no component-render tests.

## 5. Every writer and its fence

Found by grep for `writeTokenCookie|clearTokenCookie|adopt(|discard()|adoptConflict|clearCart|cartState.cart =|couponCode =|enrichment` at `af32fb1`.

| # | Writer today | Writes | After v5.1 | Fence |
|---|---|---|---|---|
| 1 | `adopt` → `writeTokenCookie` (`CartService.ts:139`) | cookie | removed; `install` writes the mirror only | — |
| 2 | `ensureCart` create (`:224-229`) | cookie + mirror | `createCart`, the sole cookie writer | lock; cookie re-read inside lock; written only if still absent |
| 3 | `discard` → `clearTokenCookie` (`:151-158`) | cookie + mirror + coupon + enrichment | `retire(T)` | lock; `cookie === T`; I1/I2/I5 proof |
| 4 | `ensureRevision` (`:242`) | mirror | `install(data, T)` | lock; token equality; `snapshotSeq` |
| 5 | `withRevisionRetry` (`:263,276,280`) | mirror | `install` | lock; token equality |
| 6 | `withRevisionRetry` discards (`:269,283,288`) | cookie | classifier → `retire(T)` / keep | lock; `CART_NOT_FOUND`/merged only |
| 7 | `addLine` (`:307`; discard `:311`) | mirror; cookie | `install`; classifier | lock; token equality |
| 8 | `refresh` (`:354`; discard `:358`) | mirror; cookie | `install`; classifier | lock; without Web Locks: mirror-only, never retires (§6) |
| 9 | `readFresh` (`:378`; discard `:382`) | mirror; cookie | `install`; classifier | the checkout's lock via `scope.readFresh()`; standalone callers take their own |
| 10 | `applyCoupon` (`:399`, coupon `:401`) | mirror + coupon | `install`; coupon set only on `install` success | lock; token equality |
| 11 | `removeCoupon` (coupon `:409`, `:417`; discard `:421`) | coupon, mirror; cookie | `install`; classifier | lock |
| 12 | `checkoutSnapshot` (`:463`; discard `:466`) | mirror; cookie | `install`; classifier | lock |
| 13 | `adoptConflict` (`:161-163` ← `checkout.ts:119`) | cookie + mirror | `scope.adoptConflict(cart, snapshot.token)` → `install` | the checkout's lock (scope); token equality |
| 14 | `placeOrder` discards (`checkout.ts:90,125`) | cookie | merged → `scope.retire(snapshot.token)`; converted → keep | the checkout's lock (scope) |
| 15 | `clearCart` → `discard` (`CartContext.tsx:177` ← `confirmation/[code]/index.tsx:65`) | cookie | `retireSettledCart(expectedCode)` → `retireSettled` | lock; order read; code match |
| 16 | `setEnrichment` (`:222,299,320`), enrichment prune (`:142-144`) | enrichment | unchanged; reset on lock entry if the cookie changed | lock |
| 17 | legacy key removal (`:180`) | localStorage | unchanged, inside `createCart` | lock |
| 18 | `CartContext` store (`:54,87,100,178,189`) | context mirror | always `CartService.getCart()`, on success, on failure (`reportError`) and from the `onChange` subscription | reads the fenced mirror |

No writer is exempt.

## 6. Web Locks requirement

- **Required** for every cart-changing flow: create, append, set, coupon, email capture, merge, checkout POST, and retirement.
- **Absent** (`!('locks' in navigator)`): these flows **fail closed**. They throw `CartError('unsupported', 'Please update your browser to use the cart.')` before any network call. There is no synchronous fallback (closes R3-1).
- Read-only paths stay available without the lock: `refresh`, which then updates the mirror only (under the `install` fence) and never retires the cookie (a missing cart throws `not_found` but the token stays), and `lookupConvertedCheckout` with payment initialisation for an existing order. A shopper on such a browser can therefore still pay an unpaid order through the resume view (§4.3), which needs no lock.
- A new order needs the lock (its live read and POST are one locked unit), so without Web Locks it fails closed with the same message.
- Scope of the guarantee: cooperating tabs running the current storefront. It does not cover old scripts still open in a tab, the browser deleting or expiring cookies, or several stores sharing this origin's `sr_cart` name (`x-store-slug`; out of scope).

## 7. Test plan

Storefront unit tests, `services/CartService.test.ts`. Add a shared harness: a real-mutex `navigator.locks` mock, a cookie jar shared between two `CartService` module instances (jsdom's single `document.cookie`, with a second instance from `vi.resetModules()` + dynamic import), and deferred `sellright()` responses. The existing overlap tests are rewritten for serialised operations; a lock-free `refresh` keeps its own sequence-guard test. Each test asserts the cookie value, the mirror state and request counts.

1. Concurrent first add in two tabs → exactly one `POST /cart`; both lines on one token.
2. Concurrent creation with a legacy key → one seeded cart; the key is consumed once.
3. Delayed `refresh`/mutation response for T after another tab installed U (the cookie changed while the request was in flight) → U's cookie and mirror unchanged.
4. Delayed checkout 409 `stale` for T after U is current → no adoption (closes R2-2).
5. Delayed `CART_NOT_FOUND` for T after U → U kept (closes R1-2).
6. 404 with another code, and a network timeout → cookie and mirror kept.
7. Converted 409 on the first attempt, and on the retry → token kept, mirror `converted`, no further request.
8. Cold-start `ensureRevision` `CART_NOT_FOUND` → T retired; one GET, no PATCH.
9. Old confirmation (code A) while the cookie names a newer cart → lookup 404 or code mismatch → kept (closes R2-3).
10. `retireSettled` with a failed lookup, `PendingPayment` or an unknown state → kept; with `Paid` or `Cancelled` and a matching code → retired.
11. No `navigator.locks` → mutations throw `unsupported` with zero requests; `refresh` never clears the cookie.
12. Merged 409 → only its own token retired.
13. Lock ownership (finding 1): the checkout's `withLock` block runs `refreshStockBeforeSubmit(scope)` and `placeOrder` without deadlocking and issues one live read; an independent `refresh` started meanwhile queues behind it; `removeLine` takes the lock once.
14. Context sync (finding 3): after a converted 409 and after a `CART_NOT_FOUND`, the `onChange` subscription and `reportError` leave the context cart equal to the service mirror (`contexts/cart-mirror.test.ts`; the sync lives in the Qwik-free `contexts/cart-mirror.ts` so it is unit-testable).

Pure modules: `services/order-state.test.ts` and `hooks/checkout-stage.test.ts` cover `decideResumeStage` (every state, `Cancelled` and unknown never `payable`). `components/cart/cart-banners.test.ts` covers Continue checkout and when Start a new cart is offered.

E2E, a new `e2e/cart-two-tab.spec.ts` (Playwright, two pages in one context; needs the live e2e stack, so it is specified here and delivered separately from the unit tests):

- Tab A converts a cart while tab B adds → B gets `converted`; the cookie still names A's cart.
- Converted payment resume with empty lines, a deleted variant, an out-of-stock line, and no shipping or form inputs → the resume panel (not `CheckoutPaymentPanel`) is shown, the same order code is paid, and **no `POST /v1/shop/checkout`** is observed.
- A cancelled order → no payment UI; Start a new cart works.

API, `api/src/routes/cart-hardening.db.test.ts`: the lookup returns 404 for another store's token; repeated lookups leave order and cart counts unchanged.

Gates: the focused tests above, then `pnpm typecheck`, `pnpm build` and `pnpm verify`. There is no dependency change, so `deps:*` is not needed.

## 8. Out of scope

Cart restoration; successor carts; tombstones or ledgers; payment anchors and HttpOnly cookies; resume tokens or `?resume=`; `GET /checkout/pending`; several concurrent unpaid carts per browser; retention changes; merge redesign; new endpoints, statuses, jobs, events or migrations; namespacing the cart cookie per store.

## 9. Rollout and rollback

- **Rollout:** a storefront-only change, released as one PR to `main`. The API is untouched and the lookup endpoint already exists on every deployed API at or after `af32fb1`. No migration, no flag, no data change.
- **Verify in production:** with a test order, convert a cart, close the tab, reopen `/checkout` → the original order is offered; pay or cancel → the cart slot is freed.
- **Rollback:** revert the storefront commit. Nothing persists that needs cleanup: no server rows or cookies are added, and the cookie name and format are unchanged. The previous storefront resumes converted carts through its POST replay (`routes/checkout.ts:391-405`), as it does today.
