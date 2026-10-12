# Brand views: presentation gateway (issue 206)
Spec: `.work/agents/2026-10-11/brand-views-gateway.astra-ruling.txt` (option (c) plus the result constraint, steps 1-5, its test list). Reviews whose shapes must be covered: `brand-views-pr1.astra1.json` … `astra6.json`. Base: `feat/brand-views-gateway` on PR1 (`d798c70`). Paths are under `packages/storefront/`.

**Invariant.** Every L1 → presentation (L2 or brand slot) entry goes through a gateway handle. A handle hands the raw component (a) data newly built from a fixed schema (fresh plain objects and arrays, recursively; accessors, functions, methods, signals, class instances, symbols, bigints, unknown keys rejected, never dropped; deep-frozen in dev/test) and (b) actions that are platform action handles, re-wrapped so their arguments and every result (async too) go through fixed schemas. Raw implementations are importable only by the gateway and by presentation code. So, whatever the caller's syntax (alias, conditional, helper, map callback, wrapper, getter, bound method) or timing (render, event, later task, delayed promise), presentation code receives no usable live reference. Deliberate circumvention stays outside the trust model; wrong projection fields or business actions remain ordinary reviewed platform bugs.

## 1. Gateway API (`src/platform/gateway/`, L1, not public)
| File | Content |
|---|---|
| `schema.ts` | Combinators `str`, `num`, `bool`, `nul`, `lit(...)`, `opt(s)` (object field may be absent/undefined), `arr(s)`, `obj({…})`, `anyOf(...)`, `html` (SanitizedHtml). `detach(schema, value, path)` returns a new value or throws `GatewayError(path, reason)`. Objects: prototype `Object.prototype`/`null` only, every own key must be declared, an accessor descriptor is rejected before the value is read (normal reads keep Qwik tracking). Arrays: real arrays, accessor elements rejected. `Infer<S>` gives the readonly TS type. `freezeEnabled()`/`freezeDeep` from `controllers/project.ts` |
| `actions.ts` | `ACTIONS`: fixed list `name → { args, result }` (§3). `platformAction(name, qrl)` → frozen `{ kind: 'sr-action', name, run }` (the only constructor; a literal elsewhere fails `gateway-action-literal`). `invokeAction(name, run, args)`: validates args (primitives only; `'event'` = DOM-delivered args are dropped), awaits `run`, returns `detach(spec.result, value)` (frozen in dev/test); a bad result rejects with `GatewayError` |
| `gate.tsx` | `gate(name, Raw, def)` and `slotGate(slot, def, Fallback?)` return **inline** function components (no extra component boundary: same JSX tree and visible SSR markup as today). `def = { data: Schema (object or anyOf of objects), actions: { prop: ActionName[] }, text?: true }`. `enter(def, props)`: unknown prop → reject; data keys → one `detach` of the data part; action keys → `checkHandle` (exact shape, kind, allowed name, `run` is a QRL) then `bindAction` = `$((...a) => invokeAction(name, run, a))` (a serialisable QRL capturing only a string and a QRL). `slotGate` resolves `getSlot(slot)` at render time (the PR1 lazy-chunk lesson, `CheckoutOrderSummary.tsx:25`), renders `Fallback` (L1) or nothing. `hasView(slot)` = build-time presence boolean |
| `index.tsx` | The handles (one line each), presence booleans, `homepageStyles`. The only file importing raw L2 modules and `~/components/slots` |

Aliasing a handle (`const V = ProductCardView`, `c ? A : B`, helpers) keeps the boundary: the checks run inside the handle.

## 2. Auxiliary channels (ruling step 4)
- **Children/render props.** A Qwik component can read `props.children` (probe: `component$` sees it even though `Object.keys` hides it), so L1 JSX is never passed into presentation. Buttons take `icon` + `text` data and the gateway builds the children from them (`<XIcon/>` handle + text node, same markup). `Modal` is the one L2 frame wrapping interactive L1 markup (`routes/account/index.tsx:157-191`, inputs with handlers and signals): it moves to L1 (`layers.json`), styled by CSS, and uses gateway buttons. Function-valued data (render props) is rejected by `detach`.
- **Refs.** `ref` is not a declared prop → rejected.
- **Callback arguments.** The platform never calls presentation code: no function crosses as data, and actions run only platform code. Presentation → platform arguments are primitives by schema.
- **Public widgets** (`~/platform/views`: `Link`, `OptimizedImage`, `RichContent`, `TurnstileMount`, `VerificationButton`, `formatMoney`): take primitives/`SanitizedHtml`, call no presentation callback and render no presentation-supplied children with live data. Reviewed; unchanged.
- **Qwik serialisation/resumption.** Handles hold a QRL; `bindAction` QRLs capture a string + QRL. No in-memory registry is needed for validity after resume.

## 3. Schemas and action lists
Data schemas mirror today's prop types (`views.ts`, `registry.ts`, the L2 prop interfaces); `gateway/types.test.ts` asserts `Infer<data>` and the TS prop types are mutually assignable.
| Handle → raw | Data | Actions (name: args → result) |
|---|---|---|
| 18 icons (`XCircleIcon`, `CheckIcon`, `TrashIcon`, `XMarkIcon`, `PlusIcon`, `PencilIcon`, `PencilSquareIcon`, `ShieldCheckIcon`, `ShoppingBagIcon`, `MapPinIcon`, `LockClosedIcon`, `HomeIcon`, `GiftIcon`, `HeartIcon`, `LogoutIcon`, `CloseIcon`, `EyeIcon`, `EyeSlashIcon`) | `forcedClass?` | – |
| `Button`, `HighlightedButton` | `extraClass?`, `disabled?` (highlighted), `icon?` lit, `text` | `onClick$`: `ui.press` (event → void) |
| `Alert`, `Success` / `ErrorMessage` | `message` / `heading`, `message` | – |
| `OrderProcessingModal` | `visible`, `storeName` | `onClose$?`: `ui.press` |
| `ComingSoon`, `MaintenanceScreen` | `storeName` | – |
| `QuantityDropdown` | `id`, `value`, `options: (num\|str)[]`, `disabled?`, `theme?` | `onChange$`: `cart.quantity-select` (num\|str, str → void) |
| `ProductCard` | `slug`, `name?`, `image?`, `price?`, `salePrice?`, `preOrderPrice?`, `isPreOrder?`, `inStock?`, `priority?`, `skeleton?` (manifest value passed through unchanged; no stock read) | – |
| `Price` | `price?`, `salePrice?`, `preOrderPrice?`, `isPreOrder?`, `forcedClass?`, `originalPriceClass?`, `currencyCode?` | – |
| `HomeHero` / `HomeTrustBar` / `HomeServiceSection` / `HomeTeeSection` | `storeName`, `tagline`, `policies{shipping,returns}` / `policies{shipping,returns,payment}` / – / `product?`, `variant?` (shapes of `projectFeature*`) | – |
| `Filters` (shop) | `facetsWithValues`, `facetValueIds`, `searchTerm?` | `onFilterChange$`: `filters.value` (str → void); `onSearchChange$?`: `filters.search` (str → void) |
| `SearchFilters`, `FiltersButton` | `showMenu`, `facetsWithValues` / – | `onToggleMenu$`: `ui.press`; `onFilterChange$`, `onOpenCloseFilter$`: `filters.value` |
| `homepageStyles` (value) | `str` | – |
| slot `shell.header` | `ShellViewProps` data | `onCartToggle$` `shell.cart-toggle`, `onLogin$` `shell.login`, `onLogout$` `shell.logout`, `onAccount$` `shell.account`: () → `ActionResult` |
| slot `shell.footer`, `route.content`, `route.blog`, `route.blog-post` (anyOf found/missing) | per `views.ts` | – |
| slot `route.home` / `route.contact` | `HomeViewProps` / `ContactViewProps` data | `onSubscribe$` `home.subscribe` (str×2) / `onSubmit$` `contact.submit` (str×5) → `FormResult` |
| slot `checkout.loyalty-redemption` (Fallback `LoyaltyRedeem`) | loyalty projection | `onRedeemToggle$` `loyalty.redeem-toggle` (bool → `ActionResult`) |
| slots `cart.free-shipping-progress`, `payment.badges`, `pdp.payment-widget`, `pdp.guarantee-modal`, `account.order-card` (order = the 10 summary fields), `account.sustainability-badge`, `legal.copy` | per `registry.ts` | – |
| slot `pdp.waitlist` | `productId`, `productName`, `soldOut` | `onJoin$?` `pdp.waitlist-join` (str → `ActionResult`); not supplied today |
`ui.press`, `cart.quantity-select` and `filters.*` results are `void`: the platform returns nothing, so any value is replaced by `undefined` (the fixed schema for a void action). `ActionResult`/`FormResult` are exact `anyOf` object schemas.

**`dispatch<R>` (step 3).** `DispatchResults<R>` gains `schema`; `dispatch` returns `detach(schema, await method())`, and a result that fails it resolves `results.error` (`callbacks.ts:203-230`). `ACTION_RESULTS` uses `ACTION_RESULT`; `FORM_RESULTS` (`content.tsx:19`) uses `FORM_RESULT`. Order, `busy` admission and dispose behaviour are unchanged.

## 4. Mounts moved onto the gateway (file:line at `d798c70`)
| Site | Change |
|---|---|
| `platform/controllers/views.ts:1-12` | Deleted; presence booleans come from `gateway` (`hasView`) |
| `controllers/shell.tsx:22,45-65,70,79` | `<ShellHeaderView …data onCartToggle$={platformAction('shell.cart-toggle', onCartToggle$)} …/>`; footer likewise |
| `controllers/content.tsx:153,163,168,178,183,188,193,198,203,207` | Content/home/blog/blog-post/contact mounts render slot handles; `onSubscribe$`, `onSubmit$` wrapped with `platformAction` |
| `platform/blog.ts:8,29`; routes `index:19,247`, `layout:22,304,311`, `about:5,52`, `terms:5,204`, `returns:5,150`, `privacy:6,346`, `press:5,43`, `contact:5,162`, `blog:6,87`, `blog/[slug]:10,189`, `[...catchall]:9` | `hasView('…')` instead of the slot component |
| `components/cart-contents/CartContents.tsx:13,18,209,245-253` and `TrashIcon` | `FreeShippingProgressView`, `QuantityDropdown` handle (`onChange$` via `platformAction`) |
| `components/checkout/CheckoutOrderSummary.tsx:5,34-35` | `LoyaltyRedemptionView` (Fallback `LoyaltyRedeem`), action via `platformAction` |
| `components/footer/footer.tsx:5,8,172`; `routes/privacy/index.tsx:4,9,144`; `routes/account/index.tsx:12,27,125`; `routes/account/orders/index.tsx:9,16,69`; `routes/products/[...slug]/ProductPageView.tsx:13,17-19,25,195,373,375` | Slot handles |
| `ProductPageView.tsx:2-4,346,369`; `CartTotals.tsx:157,246`; `CheckoutPageView.tsx:88`; `layout.tsx:293,297` | `Alert`, `CheckIcon`, `OrderProcessingModal`, `MaintenanceScreen`, `ComingSoon` handles |
| `routes/index.tsx:11-16,35,107,109,119,158,169,192` | `homepageStyles`, home handles, `Price`, `ProductCard` |
| `routes/shop/index.tsx:172,240-243,277`; `search/index.tsx:117,127,140`; `collections/[slug]/index.tsx:59` | `Filters`, `SearchFilters`, `FiltersButton`, `ProductCard`; callbacks via `platformAction` |
| `routes/account/{index:157-191,272,281; password:132,159,166; address-book/index:76; address-book/[id]:150}`, `components/account/AddressCard.tsx:52,59`, `AccountNav.tsx`, `menu/Menu.tsx`, `auth/AuthError.tsx`, `routes/{forgot-password,password-reset,sign-in/SignInError,sign-in/confirm,verify,verify-email-address-change}` | Buttons (`icon`/`text`), `ErrorMessage`, `Success`, icon handles |
| `platform/product.ts:5`, `routes/account/orders/[code]`, `checkout/confirmation/[code]`, `ProductImageModal.tsx`, `ProductPageView.tsx:2`, `CartContents.tsx` | `OptimizedImage`/`generateImagePreloadLinks` from `~/components/ui/LazyImage` (L1), not the L2 barrel |
| `components/modal/Modal.tsx` | Reclassified L1 (`layers.json` L1 include, L2 exclude); uses gateway buttons/icons |

## 5. Import-graph rule (`scripts/check-gateway.mjs`, in `build`, `test:scripts`)
Reuses `check-imports.mjs` (`createResolver`, `classify`, `collectModuleSpecifiers`). For every non-test file under `src/` that is not L2/L3 and not under `layers.json gateway.dir` (`src/platform/gateway/`):
- `gateway-import`: a value import, re-export (`export … from`, `export *`), literal dynamic `import()` or `import.meta.glob` that resolves to an L2/L3 file or a `gateway.implementationModules` file (`src/components/slots/index.ts`). Type-only imports pass. `virtual:sellright-brand-slots` is allowed only in `src/components/slots/index.ts`.
- `gateway-dynamic-import`: a non-literal `import(expr)` (cannot be resolved).
- In gateway files, `gateway-raw-escape`: a raw (L2/L3/slot-lookup) import binding used anywhere except as a direct argument of `gate`/`slotGate`/`gateValue`, or re-exported.
- Everywhere in `src/`: `gateway-action-literal` (an object literal with `kind: 'sr-action'`) outside `gateway/actions.ts`.
Chains are covered: any path from L1 to a raw implementation has a first edge leaving a non-presentation file, and that edge is flagged; an L1 helper that re-exports a raw component is itself the flagged file. Presentation files may import each other freely.

## 6. `check-l2-boundary.mjs` and `live.ts` (step 5)
- (a) call-site analysis becomes an **advisory** regression detector: `checkL2Boundary` returns `{ findings, advisories }`; the CLI prints advisories as `warning:` and exits 0 for them (`--strict` makes them fail). Its header and rule text drop the completeness claims ("cannot launder") and point to the gateway invariant. Kept as-is otherwise (no new provenance work).
- (b) `l2-forbidden-import`, `l2-live-prop-type` and (c) eject checks stay blocking (import/context restrictions); compose (`compose.mjs:180-233`) is unchanged. Both copies stay byte-identical.
- `live.ts`: the marker comment says it is an advisory diagnostic; the guarantee is the gateway.
- `check-l2-boundary.test.mjs`: fixture call-site negatives assert `advisories`; the real tree has zero findings and zero advisories.

## 7. Tests (ruling list → file)
| Ruling item | Test |
|---|---|
| Six review rounds through the gateway (`gateway/rounds.render.test.tsx`, real Qwik `useStore`/`useSignal` state, SSR via `ssrRenderToDom`) | r1 map-callback line; r2 object/array/spread/bound wrappers; r3 named render helper, bound getter wrapper; r4 `slice()`/`filter()` of unmarked children, `Detached` projection positive; r5 `$(() => countries)` as data (rejected) and as an action (result detached), widened-return callback; r6 local alias `const View = Card`, conditional `c ? Card : Other`, bound object method. Each asserts rejection or recursively disjoint identities, and that mutating accepted output never changes the source (dev: frozen; production mode stubbed: copy mutated, source unchanged) |
| Schema unit (`gateway/schema.test.ts`) | accessors, methods, functions, signals, class instances, Map, symbol, bigint, unknown keys, holes, null-proto ok, nested live object copied disjoint, shallow copy rejected/copied, freeze in test, fresh in production |
| Actions (`gateway/actions.test.ts`, `gateway/actions.render.test.tsx`) | forged handle / wrong name / bare QRL rejected; args validated; sync, async and delayed results detached; bad result rejects; void result → `undefined`; later events after SSR resume (`trigger`) and delayed results |
| `dispatch` (`controllers/callbacks.test.ts`) | result schema applied, bad result → `error`; existing order, busy admission, dispose tests unchanged |
| Default output (`gateway/fallback.render.test.tsx`) | for every handle: SSR of `<Handle …/>` equals SSR of today's `<Raw …/>` after the `ssr-normalize.mjs` normalisation; slot handle with no slot renders the fallback/nothing; navigation simulated as a re-render with new props |
| Import graph (`scripts/check-gateway.test.mjs` + fixture tree) | negatives: direct L2 import, `export {X} from` L2, `export *`, L1 helper re-export chain, literal and non-literal dynamic import, `import.meta.glob`, `getSlot`, the brand-slots virtual module, gateway raw escape (export, assignment, return), action literal; positives: type-only import, L2→L2, gateway `gate(Raw)`, L1 using a handle and `platformAction`, local presentation state; real tree clean (CLI) |
| Types (`gateway/types.test.ts`) | `Infer<schema>` ⇄ prop types |
Render tests run with `vitest.render.config.ts` (Qwik optimizer plugin; `*.render.test.tsx`), added to `pnpm test`.

**Not covered here** (constraints: no storefront build, e2e or pm2): the e2e §2.7 SSR capture against main and real-router navigation/resumption in a browser. The unit-level fallback test is the substitute evidence until that run.

## 8. Implementation notes (as built)
- `gate.tsx` exports `action(...)`/`optionalAction(...)` to declare action props; icons share the simple `IconHandle` type (AccountNav lists them).
- Projections feeding strict schemas pick fields explicitly: `projectOrder` (10 summary fields, was a generic `detach`), `projectPolicies`, new `projectHeroPolicies` (`controllers/project.ts`). An API field added later can then never fail a render.
- A schema rejection is a thrown `GatewayError`: in production a mismatch fails the render (fail closed). Call sites are typed by `Infer<schema>`, so `tsc` catches drift first.
- Factory calls in `gateway/index.tsx` are `/*#__PURE__*/` so unused handles tree-shake; bundle and preload effects are unverified without a build.
- Render tests use `vitest.render.config.ts` with stubs for both virtual modules (`src/platform/gateway/__stubs__/brand-slots.ts`, which registers the slots the product ships in `src/brand-slots`).

## 9. Stock rule
No stock read, cache, TTL, debounce or loaded flag is added or moved. `ProductCard.inStock` and every stock path keep today's sources; `useCartToggle` (live refresh on open) still runs inside `shell.cart-toggle`.
