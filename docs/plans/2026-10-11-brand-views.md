# Brand views: implementation plan v3.1 (PR1 + PR2)
Spec: `.work/agents/2026-10-11/brand-views.astra-design.txt` (followed, not redesigned). Blockers: `rotten-brand-layer.report.md` B1-B4. Reviews closed: `brand-views-plan.astra1.json` (15) and `.astra2.json` (9); map in §7. v3.1 applies `.astra3.json` items for PR1 (call-site projections, busy admission, PR1-only export tests, loyalty minimum) and records the PR2 items in §3.7. Base read at `c877ff2` (`feat/brand-views-1`); Rotten legacy at `rt-fix/store` (`rt` below). Paths are under `packages/storefront/` unless they start with `api/`. Nothing was built, tested or changed to write this.

**Trust model.** Brand code is written by the store owner and reviewed. The boundary prevents *accidental* coupling and keeps stock, cart, checkout, address and auth logic in the base. It is not a sandbox against hostile JavaScript (design §4: "Types and lint are architectural enforcement, not a sandbox"). Every rule closes a path a reviewed brand file could take by mistake: writable props, live signals or stores, context lookup, QRL introspection, HTML or script insertion. Deliberate circumvention (casts, `globalThis` tricks, string-built property names) is out of scope. Server validation stays mandatory.

## 0. Current code this plan stands on
| Fact | Where |
|---|---|
| L1 owns routes, utils, contexts, services; the only L3 route file is `ProductPageView.tsx` (L1.exclude + L3.include) | `layers.json:15-62` (`:42`, `:60`) |
| `src/components/**` is L2 except `payment`, `checkout`, `cart`; `src/theme/**` unclassified | `layers.json:45-53`; `components/ui/LazyImage.tsx:2` imports `~/theme/theme.config` |
| L2 components that receive live cart/checkout/address state as props: `CartTotals` (`localCart: CartContextState`, `promoExpandedSignal`, `serverShippingCents` signals), `AddressForm` (`appState.shippingAddress`, `formApi: Signal`), `BillingAddressForm` (`appState.billingAddress`), `AddressCard` (an `appState.addressBook` element), `LoyaltyRedeem` (`Signal<number>`), `OrderDetails` (`orderData.value`) | `CartTotals.tsx:9-22` ← `CheckoutOrderSummary.tsx:104-108`; `AddressForm.tsx:18-26` ← `CheckoutAddressesView.tsx:186-188`, `account/address-book/[id]/index.tsx:34,126`; `BillingAddressForm.tsx:11-17` ← `CheckoutAddressesView.tsx:227-228`; `AddressCard.tsx:9-12` ← `account/address-book/index.tsx:59`; `LoyaltyRedeem.tsx:12`; `OrderTracking.tsx:14,230` |
| Slot registry: nine slots; `checkout.loyalty-redemption` takes `redeemPoints: Signal<number>`; the control fetches `srAccountLoyalty` and computes `previewRedemption` itself | `components/slots/registry.ts:8-59`, `:18-22`; `LoyaltyRedeem.tsx:14-32`; `utils/sellright.ts:706-715` |
| Checkout redemption signal: created `routes/checkout/index.tsx:60`, passed `:695` → `CheckoutPageView.tsx:97` → `CheckoutOrderSummary.tsx:113-116`, written `LoyaltyRedeem.tsx:26`, submitted `checkout/index.tsx:507` | as cited |
| PDP route: `useStyles$(PDP_STYLES)`, `useProductLoader()`, `<ProductContent loaderResult>`; without it "Product Not Found" | `routes/products/[...slug]/index.tsx:12-16`; `ProductContent.tsx:36-44` |
| PDP live stock: one `getProductStock` on `qidle`, fail-closed merge, partial selection kept | `ProductContent.tsx:146-171`; `sellright/types/catalog.ts:267-280` |
| `addToCart` catches failures into `lastError` and resolves `void`; `CartService.addLine` returns `{ cart, dropped: string[] }` | `contexts/CartContext.tsx:145-157`, `:89-95`; `services/CartService.ts:448-464`; `sellright/types/cart.ts:100-105` |
| Catalog reads pin a generation per call (one file per call) | `services/catalog-snapshot.ts:1-22`; callers `browse-catalog.ts:16`, `platform/product.ts:57` |
| Sanitiser `ALLOWED_ATTR` has no `id`; options replace keys wholesale (`...options`) | `utils/sanitize.ts:24-35` |
| Blog: list loader `getBlogPosts(20, 0)`; API caps `take` at 100; summaries carry `readingTime` (default 1), `publishDate`, `createdAt: null` | `platform/blog.ts:7-9`; `api/src/routes/shop-extra.ts:97`; `providers/shop/blog/blog.ts:3-14,24-35` |
| Rotten blog list: `getBlogPosts(100, 0)`, unpaginated, `readingTime`, date `publishDate \|\| createdAt` | `rt routes/blog/index.tsx:9-11,64-66` |
| Blog post: h2 ids + TOC `addHeadingIdsAndToc`, sanitised after, `readingTime`, null post → 404 | `routes/blog/[slug]/index.tsx:41-54,89-105,169-209` |
| Catch-all: `onGet` 404, `head` = "404 - Page Not Found" + `noindex`; `[key]` is an endpoint (IndexNow) | `routes/[...catchall]/index.tsx:5-11,41-45`; `routes/[key]/index.ts:10-19`; robots strings `utils/seo.ts:85-103` |
| Base analytics: consent-gated bus `track()`/`onAnalyticsEvent`, no call sites yet | `sellright/analytics.ts:18-91` |
| Rotten browser `purchase`: checkout after a same-page Stripe resolve, confirmation on a settled order (deduped by `purchase-tracked-<code>`); no beacon for `purchase` | `rt routes/checkout/index.tsx:432-437`; `rt checkout/confirmation/[code]/index.tsx:109-120`; `rt utils/conversion-tracking.ts:64-98` |
| Base settle points: checkout navigates to confirmation at `:216`, `:543`, `:597`, `:669`; confirmation detects `isOrderSettled` at `:61` | `routes/checkout/index.tsx`; `routes/checkout/confirmation/[code]/index.tsx` |
| Head, CSP, import/shape checkers, Rotten head data, cart seed, analytics endpoint | unchanged from v2: `head.tsx:130-189`; `csp.ts:40-58`; `entry.express.tsx:142-151`; `check-imports.mjs:291-374`; `check-code-shape.mjs:93-156`; `rt checkout/facebook/index.tsx:5-85`; `rt api/analytics/performance/index.ts:39-264` |

## 1. Shared decisions (both PRs)
- **One mechanism.** Views are slots. A brand drops `src/brand-slots/<name>.tsx` typed `component$<SlotProps<'<name>'>>`. Prop types live in `src/platform/views.ts`.
- **Mount rule.** `const V = getSlot('x')` at module level (build constant). The fallback branch is today's component, unchanged. The controller hook runs only inside an L1 `Brand<X>Mount`.
- **Envelope.** Slot props are flat: `DeepReadonly<XViewData> & XViewActions`. Data is JSON-shaped. Actions are `on*$` QRLs whose arguments are primitives and whose return is `Promise<ActionResult>` (or a named result type). No `Signal`, store, loader value, function or class instance appears in data.
- **Projection.** `src/platform/controllers/project.ts` builds every projection field by field from primitives (`projectIdentity`, `projectProduct`, `projectOrder`, `projectFacets`, `projectFeatured`, …). It never spreads or returns a store, loader value or nested source object. Dev and test (`import.meta.env.DEV || MODE === 'test'`) deep-freeze; production rebuilds each projection in `useComputed$`, so a write only touches a discarded copy. Types use `DeepReadonly<T>`.
- **Platform callbacks (direct, awaited, serialised).** Each action prop is `$((...args) => serial(ctl, () => ctl.method(...args)))` built in the controller (`src/platform/controllers/callbacks.ts`).
  - `ctl` is the controller's private store; `method` is a plain L1 function that validates its arguments against `ctl` and applies the change.
  - `serial(key, fn)` keeps one promise chain per controller in a module-level, browser-only `WeakMap<object, Promise<unknown>>`: `const run = (chains.get(key) ?? Promise.resolve()).then(fn); chains.set(key, run.then(noop, noop)); return run;`. Calls apply strictly in call order, including calls made back-to-back before any await and calls made while an earlier async method is still running. A rejected or thrown method never blocks later calls.
  - Methods never throw: every outcome is a typed result. `ActionResult = { ok: true } | { ok: false; reason: 'invalid' | 'busy' | 'disposed' | 'error' }`. The promise resolves **after** the controller state change is applied (and, for add, after the server answer). Methods never call actions, so the chain cannot deadlock.
  - Long work is split. Selection and retry methods apply the selection, start the live read and resolve. The read's response is applied by its generation guard (§3.4), not inside the chain. Only `onAddToCart$` and form submits await their network call inside the chain, because their result reports it.
  - **Admission guard (v3.1).** `busy` is decided synchronously when the action is called, before it is queued, never inside the chain. Each controller keeps `ctl.admitted: Set<string>` of guard keys (`'submit'`, `'add'`, `'redeem'`). A guarded action whose key is already admitted (running or queued) resolves `{ ok: false, reason: 'busy' }` without queueing and without a request. The key is added at call time and removed when that call's promise settles (success, failure or dispose). Distinct actions still apply in call order through `serial`.
  - On unmount `ctl.disposed = true`; queued methods resolve `{ ok: false, reason: 'disposed' }` without effects.
  - Capture: a QRL captures `ctl` and the L1 objects its method needs (e.g. the cart context store). These are reachable only through QRL introspection, which r9 rejects; deliberate circumvention is excluded by the trust model.
- **Controllers** live in `src/platform/controllers/*`. They are L1, not public, and the only code that reads `APP_STATE`, cart, loaders or providers, or calls stock, cart or form functions.
- **Brand data** is JSON: `src/brand/head.json`, `src/brand/routes.json` (L3). `brandDataPlugin` (`src/platform/brand-data/vite-plugin.ts`, beside `brandSlotsPlugin` at `vite.config.ts:99`) validates them against JSON schemas (`additionalProperties: false`) and exposes `virtual:sellright-brand-data` to client and server builds, imported only by `src/platform/brand-data/index.ts`. A missing file means today's defaults.
- **Rich content.** `RichContent` (`src/platform/widgets/RichContent.tsx`, exported from `~/platform/views`) is the only HTML renderer: `component$<{ content: SanitizedHtml; class?: string }>`. `SanitizedHtml` is a branded type `{ readonly kind: 'sanitized-html'; readonly html: string }` created only by L1 `toSanitizedHtml(raw, policy)` in `src/platform/sanitized.ts`. Policies: `'product'` = `sanitizeProductDescription` (`sanitize.ts:52`; base `enhanceDescription` is base markup and is not applied to view props); `'blog'` = §2.5. It renders `<div class dangerouslySetInnerHTML={content.html} />`. Brand code never inserts HTML (r7).

## 2. PR1: boundary enforcement, shell/head/content seams, stateful components to L1, fallbacks
### 2.1 `layers.json` diff (PR1)
```diff
   "L1": { "include": [ "src/platform/**",
+      "src/components/slots/**", "src/components/ui/LazyImage.tsx", "src/theme/**",
+      "src/components/cart-totals/**", "src/components/cart-contents/**", "src/components/address-form/**",
+      "src/components/billing-address-form/**", "src/components/customer-info-form/**", "src/components/account/AddressCard.tsx",
+      "src/components/account/AccountNav.tsx", "src/components/account/OrderReturns.tsx", "src/components/loyalty/**",
+      "src/components/order-tracking/**", "src/components/header/**", "src/components/menu/**", "src/components/footer/**",
+      "src/components/head/**", "src/components/auth/**", "src/components/verification/**", "src/components/reviews/**",
       "src/routes/**", …],
-    "exclude": ["src/routes/products/**/ProductPageView.tsx"]
+    "exclude": []
   },
   "L2": { "include": ["src/components/**"],
     "exclude": ["src/components/payment/**", "src/components/checkout/**", "src/components/cart/**",
+                …every path added to L1 above] },
   "L3": { "include": ["src/brand/**", "src/brand-slots/**", "public/brand/**"
-        , "src/routes/products/**/ProductPageView.tsx"
   ] },
   "platformApi": { "alias": "~/platform/", "dir": "src/platform/",
+    "public": { "~/platform/views": "*", "~/platform/head": ["BrandHeadSpec", "StaticSchema"] },
+    "reexports": { "Link": "@qwik.dev/router", "OptimizedImage": "~/components/ui/LazyImage" } },
   "imports": {
+    "framework": {
+      "@qwik.dev/core": ["component$", "$", "useSignal", "useStore", "useComputed$", "useTask$", "useVisibleTask$",
+        "useStyles$", "useStylesScoped$", "useId", "useOn", "useOnDocument", "useOnWindow", "Slot", "Fragment", "sync$",
+        "type:QRL", "type:Signal", "type:Component", "type:JSXOutput", "type:PropsOf", "type:CSSProperties"],
+      "@qwik.dev/router": ["Link", "useLocation", "useNavigate", "type:DocumentHead"] },
+    "typeOnlyAllow": ["~/components/slots/registry"],
   "codeShape": {
+    "injectionProps": ["dangerouslySetInnerHTML", "innerHTML", "outerHTML", "srcdoc"],
+    "injectionCalls": ["insertAdjacentHTML", "createContextualFragment", "write", "writeln", "eval", "Function", "importScripts", "parseFromString"],
+    "createElementAllow": ["div", "span", "p", "a", "img", "picture", "source", "ul", "ol", "li", "button", "input", "label", "canvas"],
+    "qrlIntrospection": ["getCaptured", "getSymbol", "getHash", "resolve", "$captureRef$", "$capture$", "$chunk$", "$symbol$"],
+    "workerCalls": ["register", "Worker", "SharedWorker"],
+    "forbiddenJsxTags": ["script", "iframe", "object", "embed", "base", "frame", "meta", "link"],
+    "brandStockFlags": ["^(stock|availability|inventory).*(Loaded|Checked|Fresh|Cached)$", "^(skip|cache).*Stock"]
```
Files are reclassified, not moved, so no import path changes. Brands style every L1 component through tokens and CSS only (`global.css` variables, overlay stylesheets); they cannot replace its markup.

**Stateful-component audit** (every L2 file's props and hooks searched for `Signal`, stores, `useContext`, `APP_STATE`, `useCart`, `~/contexts`, `~/providers`, `~/services`):
| Component | Live state it receives or reads | Verdict |
|---|---|---|
| `cart-totals/CartTotals` | props `localCart`, `promoExpandedSignal`, `serverShippingCents`; `applyCoupon`/`removeCoupon` | L1 |
| `address-form/**` (`AddressForm`, `AddressTextInput`, `AddressCountrySelect`) | prop `shippingAddress` (checkout `appState.shippingAddress`, account `useStore` form), `formApi` signal; `APP_STATE` | L1 |
| `billing-address-form/**` | prop `billingAddress` (`appState.billingAddress`); `APP_STATE` | L1 |
| `account/AddressCard` | prop `address` (an `appState.addressBook` store element) | L1 |
| `loyalty/**` | `LoyaltyRedeem` checkout signal; `loyalty-program.ts` provider import; earn/balance fetches | L1 (slot default, §2.3) |
| `order-tracking/**` | `OrderDetails` gets `orderData.value` (order with addresses); `trackOrderServer` | L1 |
| `cart-contents/**`, `customer-info-form/**` | `APP_STATE`, `useCart`, line mutations; checkout customer writes (`CartContents.tsx:4-42`, `CustomerInfoForm.tsx:2,41`) | L1 |
| `header/**`, `menu/**`, `footer/**`, `head/**` | `APP_STATE`, `useCart`, `useCartToggle`, identity loader (`header.tsx:2-25`, `Menu.tsx:2,7`, `footer.tsx:3`, `head.tsx:7-8`) | L1; branded via `shell.*` and `head.json` |
| `auth/**`, `verification/**`, `account/AccountNav`, `account/OrderReturns`, `reviews/**` | `APP_STATE`, account providers/services (`LoginModal.tsx:2-28`, `VerificationModal.tsx:7-12`, `SheerIdModal.tsx:4,17`, `AccountNav.tsx:11-12`, `OrderReturns.tsx:2`, `ProductReviews.tsx:2-5`) | L1 |
| `products/Price` | `variantSig?: Signal<unknown>`; no caller passes it | stays L2; prop deleted in PR1 |
| `Filters`, `home/HomeTeeSection` | store/loader objects at the call site (`shop/index.tsx:172`, `search/index.tsx:126`, `routes/index.tsx:211`) | stay L2; call sites pass `projectFacets(...)`, `projectFeatured(...)` |
| Remaining L2: `alert`, `breadcrumbs`, `buttons`, `coming-soon`, `error-boundary`, `error-message`, `facet-filter-controls`, `filters-button`, `home/{HomeHero,HomeSocialSections}`, `icons`, `loading-spinner`, `maintenance`, `modal`, `OrderProcessingModal`, `product/ImageModal`, `products/ProductCard`, `search-bar`, `stock-level-label`, `success`, `ui/*` except `LazyImage`, `account/{Tab,TabsContainer}` | primitives, QRLs or read-only identity only | L2 |

r14 (§2.6) keeps this true after PR1. Notes:
- Removing the `ProductPageView` exception makes the legacy seam L1 and non-ejectable. The compose fixture `tools/compose/fixtures/base-fixture/.../ProductPageView.tsx` is updated. An overlay shipping it fails compose with the existing L1-overlay error; its replacement is `route.product` (PR2).
- Any overlay that today ejects a file now in L1 fails compose the same way (§6.3).
- Existing `brand-slots` files type-import `~/components/slots/registry` (`src/brand-slots/*.tsx:3-5`); `typeOnlyAllow` keeps that legal.

### 2.2 Files (PR1)
| File | Purpose |
|---|---|
| `src/platform/views.ts` | Prop and result types (§2.3), `DeepReadonly`, `SanitizedHtml`; exports `Link`, `OptimizedImage`, `TurnstileMount`, `RichContent`, `formatMoney` (pure) |
| `src/platform/widgets/{RichContent,TurnstileMount}.tsx`, `src/platform/sanitized.ts` | §1 Rich content; Turnstile `<div>` only (controller loads the script) |
| `src/platform/head.tsx` | `BrandHeadSpec`, `resolveHead(documentHead, pathname)` (§2.4), `contentHead(pathname)`, `<BrandHeadTags nonce/>`, `canonicalHref()`, `analyticsCsp()` |
| `src/platform/brand-data/{index.ts,validate.ts,vite-plugin.ts,head.schema.json,routes.schema.json}` | Load, validate, expose brand JSON; build fails on any problem |
| `src/platform/controllers/{project.ts,callbacks.ts,shell.tsx,content.tsx,loyalty.ts}` | Projections; `serial`/`ActionResult`; shell mounts; content/home/blog/contact mounts and form controllers; `useLoyaltyOffer` |
| `src/platform/blog-content.ts` | `addHeadingIdsAndToc` (moved from `blog/[slug]/index.tsx:41-54`), `tocFromSanitized`, `rankRelatedPosts` (§2.5) |
| `src/platform/content-routes.ts` | `matchDeclaredPath`, reserved prefixes, conflict checks |
| `src/components/slots/registry.ts` | New slots `shell.header`, `shell.footer`, `route.home`, `route.content`, `route.blog`, `route.blog-post`, `route.contact`; changed slots (§2.3) |
| `LoyaltyRedeem.tsx`, `CheckoutOrderSummary.tsx:18,113-116`, `CheckoutPageView.tsx:35,97`, `routes/checkout/index.tsx:695` | `useLoyaltyOffer` in the checkout route fetches `srAccountLoyalty` and computes the offer; the slot (and the base `LoyaltyRedeem`, now L1) get the projection and `onRedeemToggle$`; only the route writes its signal |
| `routes/account/orders/index.tsx:68` | Pass `projectOrder(order)` |
| `routes/shop/index.tsx:172`, `routes/search/index.tsx:126`, `routes/index.tsx:211`; `components/products/Price.tsx:7,25,58` | Projected props to L2; `variantSig` removed |
| `routes/index.tsx:221-227` (ProductCard), `components/cart-contents/CartContents.tsx:153,219` (`qtyOptions()`) | v3.1. `ProductCard` receives its existing primitive image and price props, built field by field, not the loader's `productAsset`/`priceWithTax` objects. The quantity options array becomes `projectQuantityOptions(max)` in `project.ts` (an approved `project*` call). r14 also rejects an `any`-typed object or array input to an L2 element, so `item: any` cannot evade it |
| `src/routes/layout.tsx:302,309` | `V ? <BrandHeaderMount/> : <Header />`, footer likewise |
| `src/components/head/head.tsx` | Calls `resolveHead` (`:17`); favicon `:155`, canonical `:158-161`, SW `:130-143`, fonts `:148-150` per spec; `<BrandHeadTags nonce/>`. No `head.json`/`routes.json` → today's bytes |
| `src/utils/csp.ts`, `src/entry.express.tsx:142-149` | §2.4 analytics CSP |
| `src/routes/{index,about,privacy,terms,returns,press,contact,blog,blog/[slug]}` | `export default V ? BrandXMount : BaseXPage`; loaders unchanged except the blog page size (§2.5) |
| `src/routes/[key]/index.ts` → `index.tsx`, `src/routes/[...catchall]/index.tsx` | Declared content paths: no 404 status, `route.content`, `head = contentHead` (§2.4); else today's behaviour |
| `src/components/cart-contents/CartContents.tsx:253-258` | Pass `countryCode`, `discountedSubtotalCents` |
| both copies of `check-imports.mjs`, `check-code-shape.mjs`; `tools/compose/lib/layers.mjs`; `tools/compose/compose.mjs`; `scripts/check-l2-boundary.mjs` (new, in `pnpm verify`) | §2.6 |
| `tools/compose/env-check.mjs` | `env-setting-unwired` for a non-default value of a setting no code reads (`settings.ts:1-5,39`) |

### 2.3 Prop types (PR1, `src/platform/views.ts`; every interface is used as `DeepReadonly<…>`)
```ts
export type Cents = number;
export type ActionResult = { ok: true } | { ok: false; reason: 'invalid' | 'busy' | 'disposed' | 'error' };
export type Action<A extends unknown[] = [], R = ActionResult> = QRL<(...args: A) => Promise<R>>;
export interface PublicIdentity { storeName: string; legalName: string; tagline: string; supportEmail: string; logoText: string;
  logoImageUrl: string | null; siteOrigin: string; social: { instagram?: string; facebook?: string; twitter?: string; tiktok?: string; youtube?: string; pinterest?: string } }
export interface ShellViewProps {   // sources: identity loader; useLocation(); appState.showCart/customer; cart lines (header.tsx:15-30)
  identity: PublicIdentity; pathname: string; isHome: boolean; isCheckout: boolean; isConfirmation: boolean; isNavigating: boolean;
  cartQuantity: number; cartOpen: boolean; account: { signedIn: boolean; displayName: string | null };   // rt header.tsx:44-218
  onCartToggle$: Action; onLogin$: Action; onLogout$: Action; onAccount$: Action }   // toggle = useCartToggle (live refresh on open)
export interface ShellFooterProps { identity: PublicIdentity; paymentLabels: string[]; year: number }   // labels: platform/payments/labels.ts
export interface ContentViewProps { identity: PublicIdentity; pageKey: string; pathname: string }
export interface FormState { status: 'idle'|'submitting'|'success'|'error'; message: string | null; turnstileRequired: boolean; turnstileReady: boolean }
export type FormResult = { ok: true } | { ok: false; reason: 'invalid' | 'busy' | 'turnstile' | 'server' | 'disposed' };
export interface HomeViewProps { identity: PublicIdentity; newsletter: FormState;
  featured: ListingCard[];                                   // projectFeatured(useFeaturedProducts) (platform/home.ts:77-85)
  onSubscribe$: Action<[email: string, honeypot: string], FormResult> }   // rt routes/index.tsx:66-115
export interface BlogCard { slug: string; title: string; excerpt: string | null; image: string | null;
  publishedAt: string | null;                                // publishDate ?? createdAt (rt blog/index.tsx:64); null → view omits the date
  readingTime: number;                                       // minutes (adapter default 1, blog.ts:28; rt :66)
  href: string; tags: string[] }
export interface BlogListViewProps { identity: PublicIdentity; posts: BlogCard[]; total: number; pageSize: number; hasMore: boolean }
export type BlogPostViewProps = { identity: PublicIdentity } & (
  | { state: 'found';
      post: { slug: string; title: string; excerpt: string | null; publishedAt: string | null; authorName: string | null; image: string | null; tags: string[];
              readingTime: number; toc: { id: string; text: string }[]; body: SanitizedHtml };   // toc checked against the final body (§2.5)
      related: BlogCard[] }
  | { state: 'missing' });                                   // 404 kept (blog/[slug]/index.tsx:89-93)
export interface ContactViewProps { identity: PublicIdentity; form: FormState;
  onSubmit$: Action<[name: string, email: string, subject: string, message: string, honeypot: string], FormResult> }
export interface ListingCard { slug: string; name: string; href: string; image: string | null; priceCents: Cents; currencyCode: string }
```
Changed existing slots:
```ts
'cart.free-shipping-progress': { currencyCode: string; subtotalCents: number; lineCount: number; isCheckoutView: boolean;
  countryCode: string | null;          // APP_STATE.shippingAddress.countryCode; RH US/PR rule (rt FreeShippingProgress.tsx:11-31)
  discountedSubtotalCents: number };   // max(0, subtotal - discountTotal), formula of Cart.tsx:122
'checkout.loyalty-redemption': {       // rendered only when the shopper is signed in and the program is enabled (base fetch, LoyaltyRedeem.tsx:15-22)
  balance: number;                                         // srAccountLoyalty().available
  minRedeemPoints: number;                                 // v3.1: program.minRedeemPoints, keeps the base "minimum points" message (LoyaltyRedeem.tsx:50-52)
  offer: { points: number; discountCents: number } | null; // previewRedemption(available, available, discountableCents, program); null = nothing redeemable
  applied: { points: number; discountCents: number } | null;   // previewRedemption(redeemPoints, available, …) of the route's own signal
  discountableCents: number; currencyCode: string;
  onRedeemToggle$: Action<[on: boolean]> };                // controller sets its signal to offer.points or 0; recomputes offer when discountableCents changes
'account.order-card': { order: DeepReadonly<AccountOrderSummary>; href: string };   // projectOrder
```
`onRedeemToggle$(true)` with `offer === null` → `{ ok: false, reason: 'invalid' }`. A changed `discountableCents` recomputes `offer`; an applied redemption above the new offer is reset to the new offer's points, or 0. The server re-validates under its lock. Other slots carry primitives (`registry.ts:23-58`); `pdp.waitlist.onJoin$` becomes `Action<[email: string]>` when supplied. Rotten's US/PR rule and $100 threshold go to `src/brand/shipping-policy.ts` (pure).

### 2.4 Head (`BrandHeadSpec`, `src/brand/head.json`)
```ts
export interface BrandHeadSpec {
  titleTemplate?: '%s | {store}' | '%s'; defaultDescription?: string;
  canonical?: { lowercase: boolean; trailingSlash: 'keep' | 'always' };    // rt head.tsx:24-26
  favicon?: { svg?: string; ico?: string };                                // '/…' only, no '//'
  fontPreloads?: { href: string; type: 'font/woff2'; paths?: string[] }[]; // rt head.tsx:19,36-42
  imagePreloads?: { paths: string[]; type: 'image/avif' | 'image/webp' | 'image/jpeg'; fetchpriority?: 'high' | 'auto';
    srcset: { href: string; width: number }[];                             // 1-6, href '/brand/…', width 1-4096
    sizes: string }[];                                                     // [-a-z0-9 ().,%]{1,120}; rt routes/index.tsx:592-600
  googleFontsPreconnect?: boolean; verification?: { facebookDomain?: string };
  analytics?: { provider: 'gtm'; containerId: string; consent: 'required' | 'implied' } | null;   // ^GTM-[A-Z0-9]{4,12}$; no ad pixels
  serviceWorker?: 'register-ios-privacy' | 'unregister-ios-privacy' | 'none'; appleTitle?: 'storeName';
  pageSchemas?: Record<string, StaticSchema[]>;
}
```
**Precedence.** `resolveHead` (called at `head.tsx:17`) resolves each field from the first source that sets it. Sources: (1) the brand's per-path declaration in `routes.json` (`content[].head` for a declared path, `pages[path].head` for a built-in path); (2) the route's `head` export; (3) `head.json` defaults; (4) base defaults. One tag per kind is rendered.
| Field | Resolution | Renders at |
|---|---|---|
| title | (1) → (2) → `DEFAULT_METADATA_TITLE`; then `titleTemplate` replaces the `createSEOHead` suffix (`seo.ts:79-81`). The winner also replaces `og:title` and `twitter:title` | `<title>` `:143`, meta loop |
| description | (1) → (2) → `defaultDescription`; the winner also replaces `og:description` and `twitter:description` | meta loop |
| noindex | (1) `noindex` boolean, if declared, replaces the `robots` meta with the `seo.ts:103` strings; else (2) | meta loop |
| canonical / og:url | (2) canonical link (`:158`) → `canonicalHref(policy, pathname)`; `og:url` = the canonical | `:158-161` |
| favicon | spec replaces the base `<link rel=icon>`; never both | `:155` |
| font/image preloads | route preloads first, then spec entries whose `paths` include the pathname; deduped by `href` / `imagesrcset` | `:176-189`, then `BrandHeadTags` |
| schemas | route schemas (live commerce JSON-LD stays L1, `platform/product.ts:88-92`), then `pageSchemas[path]`; same `@id` or a second `BreadcrumbList` dropped | `:170-174` |

**Declared content paths.** `[...catchall]` and `[key]` export `head = ({ url }) => matchDeclaredPath(url.pathname) ? contentHead(url.pathname) : NOT_FOUND_HEAD`. `NOT_FOUND_HEAD` is today's object (`:41-45`), byte-identical. `contentHead` builds `createSEOHead({ title, description, canonical, ogUrl, noindex: decl.noindex ?? false })` from the declaration, so the 404 title and `noindex` never reach a declared page. `onGet` sets 404 only for undeclared paths. A path with no declaration renders exactly as today: `[key]` gains a component only to serve declared single-segment paths, and for undeclared paths its `onGet` keeps today's status and body (`[key]/index.ts:10-19`), proven by the §2.7 `/no-such-page/` and `/<key>.txt` comparisons. If that equality cannot be met, the schema rejects single-segment content paths and PR1 stops for a decision.

**Static schemas.** Root `@type` allowlist: `BreadcrumbList, AboutPage, ContactPage, FAQPage, WebPage, Blog, BlogPosting, Article, Person, Organization`. Nested allowlist: `ListItem, Question, Answer, Organization, Person, ImageObject, WebPage, PostalAddress, ContactPoint`, plus `@id`-only objects. Forbidden at any depth: `@type` `Product, ProductGroup, Offer, AggregateOffer, AggregateRating, Review`; keys `offers, price*, availability, aggregateRating, review, sku, gtin*, mpn`. Strings ≤ 2,000 chars, depth ≤ 6, ≤ 20 schemas per path; L1 serialises with `<` escaped. Positive fixtures: `rt about/index.tsx:95-121`, `rt shop/[slug]/index.tsx:23-29`, `rt routes/index.tsx:585-589`, `platform/blog.ts:28`.

**Analytics and CSP.** `analyticsCsp(spec.analytics)` returns, for `gtm` (Google's GTM CSP guide, checked 2026-10-12): script-src `https://*.googletagmanager.com`; connect-src `https://*.google-analytics.com https://*.analytics.google.com https://*.googletagmanager.com` (img-src already allows `https:`). `buildCsp` gains `analytics?: { script: string[]; connect: string[] }`, merged like `google` (`csp.ts:46,50`); `entry.express.tsx:142-149` passes it from `~/platform/brand-data`. No `unsafe-eval`: no Custom JavaScript variables, no production Preview mode. The browser loads GTM through an L1 nonce'd template in `BrandHeadTags`; GA4 tags live in the container. Events flow through the base bus `~/sellright/analytics` (`track`, consent-gated); `controllers/conversion.ts` (PR2) subscribes with `onAnalyticsEvent`, pushes dataLayer and sends the beacon (§3.5). `consent: 'implied'` calls `setAnalyticsConsent(true)` at mount, which is Rotten's current behaviour; `'required'` waits for a consent banner (none exists yet, §6.5).

### 2.5 Content routes, blog, forms
**`routes.json` (PR1 part)**: `{ "version": 1, "content": [{ "path", "pageKey", "head": { "title", "description", "noindex" } }], "pages": { "<built-in path>": { "head": {…} } }, "blog": { "pageSize": 1-100 } }`. Rules: content path `^/[a-z0-9]+(?:-[a-z0-9]+)*(?:/[a-z0-9]+(?:-[a-z0-9]+)*)*/$`; first segment not reserved (every top-level `src/routes` dir walked at build, plus `api, admin, assets, build, fonts, favicon, media, brand, .well-known`, `_*`); no duplicate path or pageKey; exact match only; no handlers; `content` non-empty without `route.content` fails the build. `pages` keys must be static built-in page paths (`/`, `/about/`, `/privacy/`, `/terms/`, `/returns/`, `/press/`, `/contact/`, `/blog/`, `/shop/`); others fail the build.

**Blog list.** `useBlogPosts` reads `getBlogPosts(brand.blog?.pageSize ?? 20, 0)`; no declaration means today's call (`platform/blog.ts:8`). The API cap is 100 (`shop-extra.ts:97`), so Rotten declares `pageSize: 100` and keeps its unpaginated list. `BrandBlogMount` projects `BlogCard`s with `readingTime` and the date fallback, plus `total`, `pageSize` and `hasMore = total > posts.length`. When `hasMore` is true the mount logs a server warning, because posts past the page have no crawlable link (`rt blog/index.tsx:7-8`).

**Blog post.** `BrandBlogPostMount` projects `found` or `missing`. Body pipeline: `fixBodyHtml` (`:93`) → `addHeadingIdsAndToc` (unchanged, h2) → `toSanitizedHtml(html, 'blog')` → `tocFromSanitized(html)`. The `blog` policy is the default config (`sanitize.ts:24-35`) with `ALLOWED_ATTR` = today's list plus `id`, and an `uponSanitizeAttribute` hook, added and removed inside the call, that keeps `id` only on `H2`/`H3` with a value matching `^[a-z0-9]+(?:-[a-z0-9]+){0,15}$`, at most 80 chars. Every other `id` is dropped. DOMPurify's `SANITIZE_DOM` stays on, so a clobbering id (e.g. `location`) is dropped too. `tocFromSanitized` keeps only the TOC entries whose id survives in the **sanitised** output, in document order, so every entry links to a rendered id. h3 is on the allow-list so authored h3 anchors survive; they are not added to the TOC. The base page uses the same `blog` policy. Today its h2 ids are stripped and its TOC links are dead, so this is a deliberate fix, listed in §2.7. Related selection with `route.blog-post`: `rankRelatedPosts` = Rotten's `pickRelatedPosts` (shared tags, then recency, then slug) over the latest 40 posts, fetched per request; Rotten's 10-minute pool cache is dropped (one extra read per post view). Without the view, related posts are today's.

**Forms.** `useNewsletterForm()` moves `routes/index.tsx:62-90`; `useContactForm()` moves `routes/contact/index.tsx:18-24,33-80`. Controllers own the Turnstile script, token and reset. Submits go through `serial`: a submit while a `'submit'` admission is held (queued or running) resolves `{ ok: false, reason: 'busy' }` before queueing; the promise resolves after the server answer and `FormState` update. Validation runs first; the server re-validates (`newsletter-signup/index.ts:24-30`).

### 2.6 Import/shape rules (both copies of each checker, byte-identical; compose runs both on overlay + eject files)
| # | Rule | Change vs today |
|---|---|---|
| r1 | `import-graph`: walk the transitive local graph from every overlay/eject file. Traversal stops at a `platformApi.public` module or a `reexports` target (reviewed L1). Any other base file reached must pass every rule, else `import-l1-transitive` names the chain | today direct only (`check-imports.mjs:344-374`) |
| r2 | `import-framework-symbol`: bare specifiers must be `imports.framework` keys; named imports in its list (`type:` only as `import type`); namespace, default and `export *` rejected. So `useContext`, `createContextId`, `useContextProvider`, `useServerData`, `noSerialize` fail | today any bare package (`:296`) |
| r3 | `import-node`: `node:*` and built-ins rejected | today allowed (`:291`) |
| r4 | `import-platform-private`: target must be a `platformApi.public` key, names in its list | today any platform file (`:305`) |
| r5 | `public-export-surface` (base test over `views.ts`, `head.tsx`): every export is a type, a local `src/platform/**` definition, or a listed `reexports` name. Positive tests (PR1 exports only: `Link`, `OptimizedImage`, `RichContent`, `TurnstileMount`, `formatMoney`; `ProductReviewsWidget` and `LoyaltyEarnWidget` are PR2, §3.1) | new |
| r6 | `import-type-only-l1`: type-only L1 imports only from `typeOnlyAllow` | today any (`:304`) |
| r7 | `inject-html` / `inject-tag` / `inject-call` | new |
| r8 | `inject-element`: `createElement(NS)` only with a literal in `createElementAllow`; aliases, destructuring, `.bind`, computed non-literal keys rejected; `setAttribute` with a non-literal, `on*` or `srcdoc` name; `.src`/`.href` on a non-allowed element; `javascript:` literals; string timers | new |
| r9 | `qrl-introspection`: member access to any `qrlIntrospection` name | new |
| r10 | `worker-register` | new |
| r11 | `overlay-executable-asset`: overlay `public/**` `.js/.mjs/.cjs/.wasm/.html/.htm`, `.svg` with `<script` or `on*=` | new |
| r12 | `brand-stock-flag` | new |
| r13 | `definition-call`, `global-network`, `orchestration-call`, `import-forbidden`, dynamic `import()` | unchanged (`check-code-shape.mjs:125-153`) |
| r14 | `l2-boundary` (`scripts/check-l2-boundary.mjs`, packaged copy `tools/compose/checkers/check-l2-boundary.mjs` with a cold-compose parity test, TypeScript checker, blocks in `pnpm verify` and compose). (a) For every JSX element in an L1 file whose tag resolves to an L2 declaration, each attribute must be a primitive, an `Action`/QRL, or an object/array built by an object/array literal of primitives or a `project*()` call. It is rejected if its type contains `Signal`, `ReadonlySignal` or a type from `~/contexts/**`/`AppState`, or, when it is object- or array-typed, if its expression is rooted at a binding from `useContext`, `useCart`, `useStore`, `useSignal`, `useComputed$`, a loader `.value` or `props`. (b) No L2 base file imports `~/contexts/**`, `APP_STATE`, `~/providers/**`, `~/services/**` or `~/platform/controllers/**`, or declares a prop typed `Signal`/store. (c) The same checks apply to eject files | new |

### 2.7 Fallback proof (PR1)
With no view files, `head.json` or `routes.json`, each mount takes today's branch. SSR HTML is compared before and after, normalising only QRL symbol hashes, `q:manifest-hash` and nonces. Pages: `/`, `/about/`, `/privacy/`, `/terms/`, `/returns/`, `/press/`, `/contact/`, `/blog/`, one post, a missing post, `/no-such-page/`, `/a/b/`, `/<indexnow-key>.txt`, the cart drawer, checkout with loyalty (signed in), `/account/orders/`, `/account/address-book/`, `/track-order/`. Expected, listed differences only: blog post h2 elements now carry the `id` the TOC already links to. CSP is unchanged without `analytics`. Reclassification to L1 changes no bytes.

### 2.8 Tests (PR1) → design PR1 list
| Design item | Tests |
|---|---|
| compose/import negatives | `scripts/check-imports.test.mjs` + fixtures, one negative per r1-r14: `useContext(createContextId('cart-context'))`, `('app_state')`, `import * as Q` (r2); `props.onAddToCart$.getCaptured()` (r9); `createElement('script')`, alias, destructure, `setAttribute('onload')`, `'javascript:'` (r8); `node:fs`; `~/platform/controllers/shell`; L2 re-export chain to `~/contexts/CartContext`; `dangerouslySetInnerHTML`; `<script>`; `serviceWorker.register`; `public/brand/x.js`; `stockLoaded`; an overlay `ProductPageView.tsx`, `CartTotals.tsx`, `AddressForm.tsx`, `BillingAddressForm.tsx`, `header.tsx` (each an L1 path). r14 fixtures: L1 passing `appState.shippingAddress`, `props.localCart`, a `useSignal` and a loader `.value` to an L2 component; an L2 file importing `~/contexts/CartContext`. Positives: every PR1 r5 export, type-only registry import, `createElement('div')`, `<RichContent>`, `projectFacets(...)` to `Filters`. `compose.test.mjs`: each negative blocks dry-run and apply. Rotten's three `brand-slots` still pass |
| route collisions/404s | `content-routes.test.ts` (reserved, existing dir, duplicates, case, dot, slash, bad `pages` key); e2e `brand-views.spec.ts`: declared 200 with its title and no `noindex`; `/declared/extra/` 404 with the 404 title; undeclared 404; `/<key>.txt` served |
| head sanitization | `head.test.ts`: precedence rows (per-path title beats a route title, e.g. `/blog/`; og/twitter follow; declared `noindex: true` and `false` both win; one `<title>`, canonical, favicon; deduped preloads); allowlists with the Rotten fixtures; nested `Offer` rejected; `</script>` escaped; bad GTM id; `//evil` URLs; `csp.test.ts` |
| slot fallback/resume | `mount-points.test.ts`; `e2e/slots.spec.ts` (views resume; cart toggle opens with one live refresh; login/logout); §2.7 |
| boundary isolation | `project.test.ts` (dev/test writes throw; production copy discarded); `callbacks.test.ts`: `onA(1); onB()` without awaiting applies in order; a call during a pending async method runs after it; a throwing method resolves `error` and the next call still runs; results resolve after state is applied; disposed resolves `disposed`; loyalty: toggle with `offer` null → `invalid`, toggle on sets the checkout signal to `offer.points`, `discountableCents` drop resets it, `placeOrder` body (`checkout.test.ts:79-87`) unchanged |
| forms | invalid email never posts; honeypot; Turnstile required/reset; double submit → `busy` and one request |
| blog | missing → `state: 'missing'` + 404; h2/h3 ids survive the `blog` policy, `id` on `p`/`div`/`a` and `id="location"` dropped; every `toc[].id` exists in the final body; list: `readingTime`, date fallback, `pageSize` 100 → `getBlogPosts(100, 0)`, absent → `(20, 0)`, `hasMore`; `rankRelatedPosts` order |
| country/discount | `discountedSubtotalCents` formula; `countryCode` null then set; RH helper US/PR hidden, intl <$100 shown, ≥$100 hidden |

## 3. PR2: shop/product controllers, URL choice, operational adapters
### 3.1 Layers (PR2)
No layer change. The default product markup (`ProductPageView`, `ProductImageModal`, `ProductMobileBar`, `ProductTrustBar`, `product-styles.ts`, `product-options.ts`) stays in `src/routes/products/[...slug]/` as L1; only `route.product` replaces it. `ProductReviewsWidget` and `LoyaltyEarnWidget` (`src/platform/widgets/`) wrap the L1 `ProductReviews` and `LoyaltyPdpEarn` and take `{ slug }` / `{ productId, priceCents }`. `GuaranteeModal` is Rotten's own pure file under `src/brand/`.

### 3.2 Files (PR2)
| File | Purpose |
|---|---|
| `src/services/catalog-snapshot.ts` | Adds `readCatalogGeneration<T>(files: string[])`: pins `current` once, validates the marker once (same checks as `:9-21`), reads every file from that generation, returns `{ generation, files: Record<string, T \| null> }` (`null` = file missing). `readCatalogSnapshot` becomes a one-file call of it |
| `src/platform/configurator-detail.ts` | `useConfiguratorDetail` routeLoader (§3.4 Detail), re-exported by `routes/shop/index.tsx` and `routes/shop/[slug]/index.tsx` and `routes/products/[...slug]/index.tsx` |
| `src/platform/controllers/{product,shop}.tsx` | `useProductController`, `useShopController`, projections, `BrandProductMount`, `BrandShopMount` |
| `src/platform/controllers/configurator.ts` | Selection, availability and purchase state machine (§3.4); generations, abort, validation |
| `src/platform/controllers/stock-trigger.ts` | `useLiveStockOnView` (§3.4) |
| `src/platform/cart-result.ts` | `addWithResult(cart, sku, quantity, enrichment): Promise<AddResult>` (§3.4 Add) |
| `src/platform/product-path.ts` | `productPath(slug)`, `productUrl(slug)` from `routes.productPath`; the only URL builder |
| `src/routes/products/[...slug]/index.tsx` | `BaseProductPage` = today's component (`:12-16`) byte for byte; `export default V ? BrandProductMount : BaseProductPage`; serves only when `productPath` is `/products/:slug/`, else `onGet` 404 |
| `src/routes/shop/[slug]/index.tsx`, `src/routes/shop/index.tsx` | Same loaders and choice under `/shop/:slug/`; `V ? BrandShopMount : BaseShopPage` |
| `src/routes/checkout/[alias]/index.tsx`, `src/routes/checkout/cart-link/index.tsx` | Cart seed (§3.5) |
| `src/routes/api/analytics/events/index.ts`, `src/routes/api/analytics/[alias]/index.ts` | Event sink (§3.5) |
| `src/platform/controllers/conversion.ts` | Bus subscriber: dataLayer push + beacon (§3.5) |
| `routes/checkout/index.tsx:216,543,597,669`, `routes/checkout/confirmation/[code]/index.tsx:61`, `routes/checkout/index.tsx` entry task | `track()` call sites for `purchase` and `begin_checkout` (§3.5) |
| `api/src/cache/purge-hook.ts:32`, `api/src/email/dispatch.ts:316` | Use `productPath(config, slug)` (`api/src/seo/config.ts:46`) |

**`routes.json` (PR2 part)**:
```json
{ "productPath": "/shop/:slug/",
  "shop": { "detailProducts": [ { "key": "short", "slug": "short-sleeve-shirt" }, { "key": "long", "slug": "long-sleeve-shirt" } ],
            "productQuery": { "params": ["style", "sleeve"], "values": { "short": "short", "long": "long" } } },
  "operational": { "cartSeedPath": "/checkout/facebook/", "analyticsPath": "/api/analytics/performance/" } }
```
- `productPath`: `/products/:slug/` | `/shop/:slug/`, default `/products/:slug/`.
- `detailProducts`: 1-4 entries, `key` `^[a-z0-9-]{1,32}$`, `slug` `^[a-z0-9][a-z0-9-_]*$`, unique. Compose warns if a slug is absent from the pinned `shop-catalog.json`.
- `productQuery`: ≤3 params `^[a-z]{1,20}$`; values map to `key`; the first param present wins (rt `shop/index.tsx:22-23`); unknown → `initialProductKey = null`.
- `operational.cartSeedPath`: `^/checkout/[a-z0-9-]{1,32}/$`, segment not `confirmation`, `payment`, `cart-link` or an existing `routes/checkout/*` dir. `analyticsPath`: `^/api/analytics/[a-z0-9-]{1,32}/$`, not `events`. `[alias]` serves only the exact configured path; absent config → 404.

### 3.3 Prop types (PR2)
```ts
export interface ViewImage { url: string; alt: string | null }
export type Availability = 'unchecked' | 'loading' | 'in-stock' | 'out-of-stock' | 'error';
export interface ViewOptionValue { code: string; name: string; swatch: string | null; availability: Availability }
export interface ViewOptionGroup { code: string; name: string; values: ViewOptionValue[]; selected: string | null }
export interface ViewVariant { sku: string; name: string; optionCodes: Record<string, string>; priceCents: Cents; salePriceCents: Cents | null;
  preOrderPriceCents: Cents | null; isPreOrder: boolean; shipDate: string | null; images: ViewImage[];
  availability: Availability }                                   // 'in-stock' only from a live response of the current generation
export interface ViewProduct { key: string; slug: string; name: string; href: string; description: SanitizedHtml;
  images: ViewImage[]; optionGroups: ViewOptionGroup[]; variants: ViewVariant[]; priceRange: { minCents: Cents; maxCents: Cents };
  currencyCode: string; availability: Availability; rating: { average: number; count: number } | null; productId: string | null }
export interface ViewSelection { productKey: string | null; options: Record<string, string | null>; variantSku: string | null; quantity: number; preOrderConsent: boolean }
export type AddResult =
  | { status: 'added'; sku: string; quantity: number }
  | { status: 'partial'; sku: string; requested: number; added: number; dropped: string[] }   // fewer units, or other lines dropped
  | { status: 'rejected'; reason: 'not-eligible' | 'out-of-stock' | 'stock-error' | 'dropped' | 'cart-error' | 'busy' | 'disposed'; message: string | null };
export interface PurchaseState {
  stock: 'unchecked' | 'loading' | 'ready' | 'error'; eligible: boolean;
  reason: 'select-product' | 'select-options' | 'stock-loading' | 'out-of-stock' | 'stock-error' | 'consent-required' | 'adding' | null;
  adding: boolean; last: AddResult | null; inCartQuantity: number; maxQuantity: number }
interface ConfiguratorActions {
  onProductSelect$: Action<[productKey: string]>; onOptionSelect$: Action<[groupCode: string, valueCode: string | null]>;
  onQuantityChange$: Action<[quantity: number]>; onConsentChange$: Action<[accepted: boolean]>;
  onAddToCart$: Action<[], AddResult>; onRetryStock$: Action }
export interface ShopViewProps extends ConfiguratorActions { identity: PublicIdentity;
  listing: (ListingCard & { availability: Availability })[]; inStockOnly: boolean; onInStockChange$: Action<[inStock: boolean]>;
  detail: ViewProduct[]; detailStatus: 'ok' | 'partial' | 'unavailable'; selection: ViewSelection; purchase: PurchaseState;
  initialProductKey: string | null; loading: boolean; error: string | null }
export interface ProductViewProps extends ConfiguratorActions { identity: PublicIdentity; product: ViewProduct; siblings: ViewProduct[];
  selection: ViewSelection; purchase: PurchaseState; breadcrumbs: { name: string; href: string }[]; deepLink: Record<string, string>;
  loading: boolean; error: string | null }
```

### 3.4 Controllers: detail, live stock, triggers, purchase
**Detail (metadata only, no stock).** `useConfiguratorDetail` returns `null` with no I/O when the route's view is absent (build constant), so fallbacks are unchanged. Otherwise it calls `readCatalogGeneration(['shop-catalog.json', ...detailProducts.map(p => 'products/<slug>.json')])`, so the listing and every detail file come from one pinned generation. Each detail file goes through `normalizeManifestProductDetail` + `manifestProductMeta` (`platform/product.ts:57-58`). A missing file, or a generation that fails validation, falls back per product to `getProductDetail(slug)` + `liveProductMeta` (`platform/product.ts:63-75`), and that fallback is metadata only too. A product that fails both is omitted. `detailStatus` is `ok` when all resolve, `partial` when some do, `unavailable` when none do; the view then gets the listing only. On `/shop/`, `detail` = all resolved products. On the PDP, `product` = the route's product (from `useProductLoader`), and `siblings` = the other resolved `detailProducts` when the route slug is one of them, else `[]`. Every variant starts `unchecked` (stockLevel `'0'`, fail closed).

**Reads.** `configurator.ts` calls `fetchProductStock` (`providers/shop/products/products.ts:25`) and `mergeProductStock` (fail-closed). No cache, TTL, debounce, sessionStorage, stale fallback or "loaded" flag.
- Load: exactly one read per page view for the product in focus (PDP product; on `/shop/`, `initialProductKey` else the first detail product).
- Selection: each accepted `onProductSelect$`/`onOptionSelect$` starts one read for the selected product.
- Add: one fresh read for the chosen SKU, then the server add.
- Cart open, checkout entry and pre-submit refreshes: unchanged (`platform/cart.ts:9-26`; `CartContext.tsx:112-143`).
- Shop listing: unchanged (manifest on load; `onInStockChange` is the only live read, `shop/index.tsx:141-155`).

**Triggers and identity** (`stock-trigger.ts`). `viewGen` increments in a client `useTask$` tracking the loader value. Path A (direct load): `useOnDocument('qidle')`, as today (`ProductContent.tsx:171`). Path B (SPA navigation): a browser `useTask$`. Both call `requestLoad(viewGen)`, a no-op if `lastLoadGen === viewGen`. Each read has `reqGen = ++gen[productKey]` and an `AbortController`; a new read for that product, a `viewGen` change or unmount aborts it. A response applies only if `reqGen` and `viewGen` are current; otherwise it is discarded and can never set `in-stock` or `eligible`.

**Add.** `onAddToCart$` → `serial(ctl, add)`. `add` returns `rejected/not-eligible` unless `purchase.eligible`. It sets `adding`, runs the add-time read (OOS → `rejected/out-of-stock`; failure → `rejected/stock-error`), then calls `addWithResult`. `addWithResult` mirrors `addToCart`'s state handling (`CartContext.tsx:145-157`: `loadCartIfNeeded`, `isLoading`, `applyResult`, `reportError`), but calls `CartService.addLine` itself and classifies the server response against the SKU's line quantity before the call:
- `added`: the SKU's quantity grew by `quantity` and `dropped` is empty.
- `partial`: it grew by less than `quantity`, or other SKUs are in `dropped`.
- `rejected/dropped`: the SKU is in `dropped`, or its quantity did not grow.
- `rejected/cart-error`: `addLine` threw (`CartError` family, `CartService.ts:47-62`); `message` = `cartState.lastError`.
`addToCart` itself is unchanged for its other callers. On `added`/`partial` the controller sets `appState.showCart = true` and `loadCountryOnDemand` (as `ProductContent.tsx:270-295`), and tracks `add_to_cart` with the units actually added. On `rejected` the drawer stays closed and no event fires. `purchase.last` holds the result; `adding` clears on every path.

**Purchase transitions** (selected product, current generation):
| State | Entered when | `eligible` / `reason` | CTA |
|---|---|---|---|
| unchecked | SSR shell, before the load read | false / `stock-loading` | disabled "Checking stock" |
| loading | read started (load, selection, retry) | false / `stock-loading` | disabled |
| ready, selection incomplete | response applied | false / `select-product` or `select-options` | disabled |
| ready, variant OOS or absent from response | response applied | false / `out-of-stock` | disabled |
| ready, pre-order without consent | response applied | false / `consent-required` | disabled |
| ready, in stock, consent ok | response applied | **true** / null | enabled → `onAddToCart$` |
| error | 4xx/5xx/timeout | false / `stock-error` | disabled; `onRetryStock$` starts a read |
| adding | `add` accepted | false / `adding` | disabled; resolves to `added`/`partial` (back to ready, re-evaluated) or `rejected` (OOS → OOS row; stock error → error row; dropped/cart-error → ready with `last` set) |
Partial selections are kept on refresh; a complete selection resets only if it no longer resolves (`ProductContent.tsx:154-163`). `findVariant`/`getOptionGroups` move to `src/platform/controllers/product-model.ts`. O1 for the configurator is settled (live on load and selection, 2026-10-12 instruction); `shop.stockOnLoad` governs only the listing.

### 3.5 Operational adapters and analytics
**Cart seed** (`/checkout/cart-link/` and `cartSeedPath`; port of `rt checkout/facebook/index.tsx`), an L1 page with a client task: `products` = comma-separated `sku[:qty]`, SKU `^[A-Za-z0-9._-]{1,64}$`, ≤10 distinct (extra dropped), qty integer 1-10 (missing 1, >10 clamped), malformed → `/checkout/?error=invalid_cart_link`. Replace semantics: `CartService.discard()`, then `addLine` per SKU in order (`rt :50-60`), each classified like `addWithResult`. `country`/`countryCode` ISO-2 via `getOrResolveCountryCode`. Dropped, rejected or partial SKUs → `skipped=<skus>`; zero lines → `?error=no_valid_products`; exception → `?error=cart_link_failed`. Other params are preserved; missing `products` → `/checkout/?<params>`. Stock is validated by the server add and checkout entry. `Cache-Control: private, no-store`.

**Analytics call sites** (all L1; each calls `track()` from `~/sellright/analytics`, so nothing fires without consent):
| Event | Call site | Data |
|---|---|---|
| `view_item` | product/shop controller, once per `viewGen` after detail projection | sku of the focused product's first variant, name, price, currency |
| `add_to_cart` | `add` on `added`/`partial` | units actually added |
| `begin_checkout` | checkout route entry task, once per checkout view | cart value, item count |
| `purchase` | checkout settle points `routes/checkout/index.tsx:216,543,597,669` (before `navigate`), and confirmation `isOrderSettled` branch `confirmation/[code]/index.tsx:61` | `orderCode` (= `transaction_id`, `eventId = purchase_<code>`), currency, value, items ≤20 (`PurchaseEvent` gains optional `items`) |
`purchase` is deduplicated by transaction: both sites check and set `sessionStorage['purchase-tracked-<code>']` (Rotten's key, `rt confirmation:109-111`) inside try/catch, and GA4 also dedupes by `transaction_id`. This storage holds analytics state only, never stock. `conversion.ts` pushes `purchase` to the dataLayer only. It never beacons `purchase`, because the API's conversion plugin owns server purchase (`rt conversion-tracking.ts:8-9,87`).

**Event sink** (`/api/analytics/events/` and `analyticsPath`): POST JSON `{ type: 'ecommerce', event: { name: 'view_item'|'add_to_cart'|'begin_checkout', eventId, clientId?, gtagSent: boolean, currency, value, items ≤ 20, pageLocation } }`. Body > 16,384 chars → 413; > 60/min per IP → 429; invalid → 400; accepted → 202 (`rt performance/index.ts:39-44,67-71`). `purchase` → 400. Non-ecommerce bodies (web-vitals) → 204, dropped. GA4 Measurement Protocol forwarding only when `gtagSent === false` and `GA4_MEASUREMENT_ID` + `GA4_API_SECRET` exist (names only), 3 s timeout. No Meta CAPI. `no-store`.

### 3.6 Tests (PR2) → design PR2 list
| Design item | Tests |
|---|---|
| synthetic Rotten configurator | fixture brand `src/components/slots/__fixtures__/brand-views/` (2 products × size × colour); `e2e/brand-views-shop.spec.ts`: load → `ready` → select → in-stock → add → `added` → drawer |
| detail loader | `configurator-detail.test.ts`: one generation for listing + both details (generation swapped mid-read still yields the pinned one); a missing file → live fallback; both fail → omitted, `detailStatus`; no view → no I/O; `siblings` on a member and a non-member slug; all variants `unchecked` |
| direct/SPA navigation | direct load and `Link` navigation each issue exactly one load read; back/forward one read; leaving aborts the in-flight read |
| deep links | `?size=&color=` preselects valid codes only; a click before the load response wins; `?style=long`/`?sleeve=long` → `initialProductKey` |
| variant galleries | colour selection shows that variant's images, else product images |
| live request counts | 1 per page view + 1 per accepted selection + 1 per add; forged selection 0; listing 0 on load, 1 per toggle; none on focus/visibility |
| failures/missing variants | 500/timeout/404 → `error`, retry one read; SKU absent → `out-of-stock` |
| ordering and races | `onQuantityChange$(2); onAddToCart$()` without awaiting adds 2; a selection during an add applies after the add result; out-of-order stock responses discarded; selection during a read aborts it |
| add results | `cart-result.test.ts` with stubbed `addLine`: full → `added`; clamped quantity → `partial`; other SKU dropped → `partial` with `dropped`; own SKU dropped → `rejected/dropped`; throw → `rejected/cart-error` and `lastError` kept; drawer opens and `add_to_cart` fires only on `added`/`partial` |
| forged callbacks | unknown key/group/value, quantity 0/11/NaN, consent on non-pre-order, add when not eligible → `invalid`/`not-eligible`, no state change, no request |
| cart/checkout refreshes | drawer open → `refreshCartStock`; checkout entry and `placeOrder` revalidate (`e2e/stock-parity.spec.ts` under `/shop/<slug>/`) |
| analytics | consent off → no event; `purchase` fires once across checkout settle + confirmation for one code; never beaconed; sink: 413/429/400/202/204, `purchase` → 400, MP only when `gtagSent=false`, never Meta |
| fallback | SSR equality for `/shop/`, `/shop/?q=x`, a PDP, an OOS PDP, unknown slug; `BaseProductPage` keeps styles and `loaderResult` |
| live JSON-LD, no-store | API JSON-LD with storefront canonical; product/shop HTML, cart seed and sink keep private/no-store |
| URL choice | `productPath` unit test; grep: no `` `/products/${ `` outside `product-path.ts`; each setting 404s the other route; generators switched: `platform/product.ts:126,137`, `ProductCard.tsx:147`, `CartContents.tsx:177`, `HomeTeeSection.tsx:37`, `routes/index.tsx:190`, `[...catchall]/index.tsx:73`, `cache-admin/warm/index.ts:33`, `indexnow-webhook.server.ts:48`, `seo-schemas.ts:73` |
| operational | cart seed: replace, caps, ISO-2, `skipped` for dropped/partial, errors, params; alias collisions rejected, absent alias 404 |
| props immutability | a fixture view mutating `product.variants[0]` throws in dev; controller state unchanged |

Each PR runs focused tests, `pnpm typecheck`, `pnpm build`, `pnpm test:scripts`, `pnpm test:tools`, `pnpm verify`. Rotten's composed harness (A7) and Adrian's visual comparison remain required before cutover.

### 3.7 Review-3 items carried to PR2 (v3.1)
Recorded from `brand-views-plan.astra3.json`; PR1 does not implement them.
1. **Add outcome authority.** `addWithResult` must not infer accepted units from a pre-add snapshot of the local mirror (cart replacement or another tab can change the SKU). Define an operation-level result, or take the baseline and append inside one protected `CartService` operation; test stale mirror, cart replacement, another tab.
2. **Missing-product contract.** `ProductViewProps` needs a `found | missing` projection or an L1 missing-product branch before the view mounts; keep the 404 and start no controller or stock read for a missing product.
3. **PDP generation.** For branded PDPs the route product and `siblings` come from one request-scoped `readCatalogGeneration`, including products outside `detailProducts`; define how the head loader consumes it without touching the unbranded branch.
4. **Per-product head.** Rotten's product title/description (`rt routes/shop/[slug]/index.tsx:163-172`) need validated exact product-path head overrides or title/description fields on `detailProducts`; schemas and availability stay platform-owned.

## 4. Must not be allowed
- Brand code reading or writing `APP_STATE`, cart stores, auth tokens, account clients, loaders, providers, `~/sellright/*`, `~/platform/controllers/*`, `~/theme/*`, or any context.
- Writable signals, stores, loader objects or controller QRLs in any slot, view or L2 prop; any ejectable component that receives live cart, checkout, address or account state; calling QRL internals.
- Ejecting cart totals, cart contents, address, billing, customer-info, loyalty, order-tracking, header, menu, footer, head, auth, verification or review components (L1; tokens/CSS only).
- Brand stock reads, triggers, cache policy, availability interpretation, purchase validation; JSON-LD with price, availability, offers, ratings or product types.
- Any stock cache, TTL, debounce, sessionStorage, stale fallback or brand "loaded/checked" flag. Missing stock never means in stock; a superseded or failed response never enables purchase; a rejected add never reports success.
- HTML or script insertion by brand code; HTML only through `RichContent` with L1-sanitised content.
- Brand-declared handlers, loaders, actions, `server$`, redirects; routes beyond exact `routes.json` content paths and the two operational aliases.
- Framework symbols outside `imports.framework`, Node built-ins, other bare packages, dynamic imports, private platform subpaths, re-export laundering. Client-trusted prices. Removing `private`/`no-store`. Ad pixels. A `purchase` beacon.

## 5. Out of scope
- Wiring `pdp.stockRefreshTrigger`, `shop.stockOnLoad` (listing), `pdp.bfcacheRefresh` (O1/O3; `settings.ts:1-5`); PR1 makes a non-default value fail.
- ProductGroup/variant JSON-LD, the Merchant feed; Rotten's production `seo.productUrlPattern` (Adrian's go).
- The Rotten overlay itself, A25 rerun, A7 harness, A26/A27 cutover, base `global.css` Google Fonts import, `returns`/`press` on Rotten, Rotten's web-vitals endpoint, a consent banner.
- Hardening against deliberately hostile brand code (trust model).

## 6. Open points for the orchestrator
1. `env-setting-unwired` is PR1's migration gate, not a request to change a brand: Rotten's `shop.stockOnLoad=live` and Damned's approved `pdp.stockRefreshTrigger=qinit` stay in their `brand.json`, and those brands stay on their current base pin until the stock wiring lands (O1/O3). Neither setting is deleted or weakened.
2. Confirm that Meta CAPI forwarding in `rt api/analytics/performance` is dropped (no-ad-pixels).
3. Before PR1 merges, check every brand overlay for shipped files that PR1 makes L1 (`ProductPageView.tsx` and every §2.1 audit path). Any found must move to tokens/CSS or a slot, or PR1 waits.
4. Rotten's production `seo.productUrlPattern` = `/shop/{slug}/` needs Adrian's go; until then the product head rewrites a mismatched JSON-LD `url`/`offers.url` to the storefront canonical, price and availability untouched.
5. Analytics consent: Rotten fires GA4 without a consent gate today. `head.json analytics.consent: 'implied'` keeps that; the owner must confirm it is lawful for Rotten's markets, or a banner is needed first.

## 7. Review closure maps
**Round 1** (`astra1.json`): 1 legacy ProductPageView → §2.1; 2 checkout slot signal → §2.3 loyalty, `account.order-card`; 3 framework APIs/QRL capture → §2.1 `imports.framework`, r2, r9, §1 Capture; 4 configurator purchase → §3.3-3.4; 5 HTML renderer → §1 Rich content; 6 public exports → §2.1, r1, r5; 7 PDP fallback → §3.2 `BaseProductPage`; 8 script injection → r8; 9 immutability/envelope → §1; 10 PR2 config → §3.2, §3.5; 11 schema allowlists → §2.4; 12 image preloads → §2.4; 13 blog projection → §2.3, §2.5; 14 SPA trigger → §3.4; 15 GA4 CSP → §2.4.

**Round 2** (`astra2.json`):
| # | Finding | Closed in |
|---|---|---|
| 1 | L2 ejects receive live checkout state | §0 row 3; §2.1 diff + stateful-component audit (every L1 row, `Price.variantSig` removed, `Filters`/`HomeTeeSection` projected); r14; §2.8 negatives; §4 |
| 2 | Single-value inbox loses actions | §1 Platform callbacks (`serial` chain, typed results after apply); §2.3 `Action`/`ActionResult`/`FormResult`; §2.8 and §3.6 ordering tests |
| 3 | Configurator detail acquisition | §3.2 `readCatalogGeneration`, `configurator-detail.ts`; §3.4 Detail; §3.3 `detailStatus`; §3.6 detail loader |
| 4 | Head precedence | §2.4 Precedence table (brand per-path first; og/twitter; noindex) and Declared content paths; §2.5 `pages` keys; §2.8 |
| 5 | Blog list drops Rotten content | §2.3 `BlogCard.readingTime`, `publishedAt` fallback, `BlogListViewProps`; §2.5 Blog list (`pageSize` ≤ 100) |
| 6 | Sanitiser strips TOC ids | §2.5 Blog post (`blog` policy allow-list, `tocFromSanitized`); §2.7 expected diff; §2.8 blog |
| 7 | Add helper cannot report outcome | §3.2 `cart-result.ts`; §3.3 `AddResult`; §3.4 Add + transitions; §3.6 add results |
| 8 | Browser purchase event omitted | §3.5 Analytics call sites (checkout settle + confirmation, dedup, no beacon); §3.2 rows |
| 9 | Loyalty slot cannot form a redemption | §2.3 `checkout.loyalty-redemption` (`balance`, `offer`, `applied`, `onRedeemToggle$`); §2.2 `useLoyaltyOffer`; §2.8 |

**Self-audit for the same classes** (fixed here, not raised by the review): `HomeViewProps.rating` had no data source and Rotten's home loads none, so it was removed, and `featured` is now sourced. `ProductViewProps.reviews.enabled` had no source and was removed (brands render `ProductReviewsWidget` by slug). Base analytics is consent-gated with no consent source, which would silently drop Rotten's events, so `analytics.consent` was added with §6.5. The cart seed reused the swallowing `addLine` path, so it now classifies each add like `addWithResult`. The product description's base `enhanceDescription` is now explicitly excluded from view props. Account address and order-tracking components carry the same kind of live state as checkout and moved with them.
