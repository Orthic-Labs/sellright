# Changelog — SellRight web, API, and admin

Notable changes to the SellRight commerce API, storefront, and desktop-browser
admin. The native iOS admin ships separately and is tracked in
[`ios/CHANGELOG.md`](ios/CHANGELOG.md).

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Every user-facing feature, fix, security change, or operational contract change
must update the matching changelog in the same push.

## [Unreleased]

### Security

- API cache policy keeps a route-set `Cache-Control` verbatim when a strict parse finds an exact `no-store` and only `no-cache`, `must-revalidate`, `proxy-revalidate`, `private` or zero `max-age`/`s-maxage` directives (anything else, including look-alikes, quoted values and empty segments, fails closed), on any route, method and status, instead of rewriting it to `private, no-store`; a plugin's frozen `no-cache, no-store, must-revalidate` now reaches clients unchanged. Anything that grants caching, or sets nothing, is still forced to `private, no-store`, and CDN headers and `Cache-Tag` are still stripped.
- API cache policy also strips `Cache-Tag` from every response, cacheable exceptions included (Cloudflare ties tags to cached content, so a no-store response carries none). E2E stock-parity now captures the real `q-loader-*.json` requests of client navigation before the first navigation, awaiting every check (and submits the probe form's `routeAction$` POST; `run-parity.sh` sets `E2E_PLATFORM_PROBE=1`) and asserts one `private, no-store` header with no CDN header and no `Cache-Tag`.

### Added

- **Storefront compose: a sanctioned path for brand deploy files** (`layers.json deploy`). A brand's declared deploy file (`brand.json deployFiles`) that sits in no layer and matches `deploy.operationalScripts` (`scripts/*.mjs`, `scripts/*.sh`, `ecosystem.config.cjs`: build and process files, never bundled) or `deploy.publicScripts` (`public/ios-privacy-sw.js`, `public/analytics.js`: fixed URLs a live brand must keep answering) is exempt from the overlay import, shape and executable-asset rules; storefront source never is. Compose writes `.compose-deploy-files.txt` so `check:imports`/`check:shape` in the composed tree apply the same rule.
- **Storefront: brand seams for a shared-base brand to match its own site** (Rotten parity). `head.json`: `imagePreloads` srcset entries may name a brand media import (`~/brand/media/hero.png?format=avif&w=768&url`), which the build turns into the same hashed URL the brand view renders; preload `paths` accept a `/prefix/*` form; `verification.pinterest`. `routes.json`: `copy.cart.emptyTitle`/`emptyBody` (cart drawer empty state), `cart.openAfterAddMs` (the configurator drawer opens after the brand's own "Added" confirmation), `shop.detailProducts[].facts.material`. The branded shop page renders one platform-built `ProductGroup` per configurator product (variants with options and price, no availability); the branded product page adds brand, condition, material, colour and size lists, plain-text description and absolute image URLs to the API's product JSON-LD (offers untouched).
- Storefront: the PDP reviews block reads on document ready and renders nothing until the read answers (no stuck "Loading reviews…"); a brand home view no longer preloads the base hero image.

- **API: product links follow the store's product path** (`seo.productUrlPattern`, already used by the sitemap and JSON-LD): the Cloudflare purge hook, the review-approved email and the restock emails now build the product URL with `productPath(seoConfigFromStore(store), slug)` instead of a hard-coded `/products/`, so a `/shop/{slug}/` store (Rotten Hand) gets `/shop/<slug>/` links. Default stores keep `/products/<slug>/` (now with the trailing slash the storefront serves).
- **Storefront: single-segment content paths** (for the Rotten brand layer's `/slow-fashion/` and `/shipping-returns/`): routes.json `content` now accepts one-segment paths. The `[key]` route renders a declared one as `route.content` with its declared head; `/<key>.txt` (IndexNow) and every undeclared single-segment path answer exactly as before (key file or a plain 404).
- **Storefront stock settings wired (plan A20/A21, owner decisions O1/O3)**: the three platform settings now reach the build and change stock-read timing only. compose validates brand.json `settings` and writes each one into `.env.production` as its build env name (`VITE_SR_PDP_STOCK_TRIGGER`, `VITE_SR_SHOP_STOCK_ON_LOAD`, `VITE_SR_PDP_BFCACHE_REFRESH`; brand.json `publicConfig` may not set them, a process-environment override fails `env-setting-overridden`); `src/platform/settings.ts` reads them and only `src/platform/stock-triggers.ts` (L1) consumes them: `pdp.stockRefreshTrigger` (`qidle` default, `qinit` for Damned) is the document event of the PDP's one automatic read (base PDP and the brand product view), `pdp.bfcacheRefresh` (off by default) re-reads live stock on a back/forward-cache restore, `shop.stockOnLoad` (`manifest` default, `live` for Rotten) makes one live, uncached, fail-closed listing read per shop view on load (base shop page and the brand shop view). No cache, TTL, debounce or sessionStorage; missing stock stays out of stock; defaults are today's behaviour. The `wired: false` flags are gone; `env-setting-unwired` stays for a future unwired setting.
- **Storefront brand views, PR2 (shop and product views on the gateway)** (plan `docs/plans/2026-10-11-brand-views-pr2.md`, review fold below): two new view slots, `route.shop` and `route.product` (found or missing), rendered only through gateway handles; with no view files the shop and product pages render as before.
  - **Configurator controller**: detail is metadata only (every variant starts `unchecked`); exactly one automatic live stock read per view (direct load on qidle, SPA navigation by a browser task, whichever first), covering every product the view can sell, under one `AbortController` and generation; a superseded or late response is dropped; per-product outcomes (one product failing leaves its siblings purchasable); 404 and a SKU the response omits are out of stock; retry only after an error. Selection, product selection and add never read stock: the add's own server response is the SKU's live check (`added`, `added-unavailable`, or `rejected` with `cart-changed`/`cart-error`/`not-eligible`), from the new `CartService.addLine` `applied`/`line` fields. Eligibility requires a live `inStock === true` (a pre-order flag only shows the label and asks consent); the quantity is normalised to the live cap on every selection or cart change and revalidated at add.
  - **Loaders**: `readCatalogGeneration` reads several catalog files from one pinned generation; the branded PDP reads the route product and its configurator siblings, and the branded shop the listing and every detail product, all from one generation or all live, never mixed. Missing products are a 404 with `ProductMissingView`, `Product Not Found` + noindex, and no controller or stock read.
  - **routes.json**: `productPath` (`/products/:slug/` default, or `/shop/:slug/` with a new `/shop/[slug]` route and a query-preserving 301 from `/products/<slug>/`; every storefront product link now comes from `platform/product-path.ts`), `shop.detailProducts` (key, slug, per-product head copy applied only while the product is found, breadcrumb name, allowlisted static schemas such as FAQPage), `shop.productQuery` (`?style=`), `operational.cartSeedPath` / `analyticsPath`. Static schemas also allow `CollectionPage` and nested `ItemList`.
  - **Operational adapters (plan v3.1 §3.5)**: `/checkout/cart-link/` (and the alias) replaces the cart from `products=SKU[:qty],...` with each add classified from its own response, then lands on checkout with `skipped`/error codes; `/api/analytics/events/` (and the alias) accepts view_item/add_to_cart/begin_checkout (413/429/400/204/202, purchase refused, GA4 Measurement Protocol copy only when the browser tag did not send it, no ad pixels); a consent-gated conversion subscriber (mounted only when head.json declares analytics) pushes the dataLayer and beacons; begin_checkout at checkout entry and purchase once per order on the confirmation page.
  - API-side product URLs (cache purge, review-approved and restock emails) keep `/products/<slug>/`, which the 301 forwards with its query; changing them needs the store's `seo.productUrlPattern` threaded through those callers (follow-up).
- **Storefront brand views, PR1 (boundary, shell/head/content seams)**: a brand can now replace whole views through typed slots (`shell.header`, `shell.footer`, `route.home`, `route.content`, `route.blog`, `route.blog-post`, `route.contact`; plan `docs/plans/2026-10-11-brand-views.md`, v3.1) and shape the document head through data (`src/brand/head.json`, `src/brand/routes.json`, validated at build, served as `virtual:sellright-brand-data`). With no view files or data the storefront renders exactly as before.
  - **Boundary**: header, menu, footer, head, auth, verification, reviews, cart totals and contents, the address and billing forms, customer info, loyalty, order tracking, `AddressCard`, `AccountNav`, `OrderReturns`, `LazyImage`, `src/theme/**` and the legacy `ProductPageView` seam are now L1 (not ejectable; brands style them with tokens and CSS). New import rules r1-r14 in both checker implementations (`scripts/` and the packaged copies in `tools/compose/checkers`): transitive L1 reach, framework symbol allowlist, Node built-ins, private platform modules, type-only L1 imports, HTML/script/element injection, QRL introspection, worker registration, executable overlay assets, brand stock flags, and `scripts/check-l2-boundary.mjs` (live state may not reach an L2 component; run by `pnpm build`, CI and compose). `scripts/check-public-surface.mjs` keeps `~/platform/views` and `~/platform/head` free of re-exported internals. Compose refuses a `layers.json` from before these rules instead of passing silently.
  - **Views**: `~/platform/views` (prop and result types, `Link`, `OptimizedImage`, `RichContent`, `TurnstileMount`, `formatMoney`), detached and frozen (dev/test) projections, awaited and serialised `on*$` actions with typed results and a synchronous busy guard, a sanitised-HTML-only renderer, forms (newsletter, contact) moved into the platform. `cart.free-shipping-progress` gains `countryCode` and `discountedSubtotalCents`; `checkout.loyalty-redemption` takes a projection (`balance`, `minRedeemPoints`, `offer`, `applied`) and `onRedeemToggle$`, with the redemption signal owned by the checkout route; `account.order-card` receives a detached order.
  - **Head and content**: `head.json` (title template, default description, canonical policy, favicon, font/image preloads, verification, GTM analytics with consent mode, service-worker mode, allowlisted static JSON-LD) with one precedence rule; declared content paths (two or more segments) served by the catch-all with their own title and no `noindex`; blog `pageSize`; GTM CSP origins only when analytics is declared.
  - **Tooling**: `env-setting-unwired` (compose) refuses a non-default value for a platform setting no code reads yet (`wired: false` in `brand-env.schema.json`; the three stock settings today). It is a migration gate: the setting stays in the brand's files and the brand stays on its current base pin until the wiring lands; `scripts/ssr-normalize.mjs` and `e2e/ssr-fallback-capture.spec.ts` for the before/after SSR comparison.

- **Storefront brand views: presentation gateway** (issue 206, plan `docs/plans/2026-10-11-brand-views-gateway.md`): L1 now reaches presentation code (base L2 components and brand slots) only through `~/platform/gateway` handles. A handle rebuilds every data prop from a fixed schema (new plain objects all the way down; accessors, functions, methods, signals, class instances and undeclared fields are rejected, never dropped; frozen in dev/test) and accepts only platform actions from a fixed list (`platformAction`), whose arguments and every result, asynchronous ones included, pass fixed schemas; `dispatch` rebuilds method results the same way. Children never cross (buttons take `icon`/`text` data; `components/modal` moves to L1). `scripts/check-gateway.mjs` (in `pnpm build`) rejects any other L1 import of L2/L3 modules or the slot lookup, including re-exports, dynamic imports and globs. `check-l2-boundary.mjs` call-site analysis becomes an advisory diagnostic (`--strict` to fail on it). Render tests (`vitest.render.config.ts`) cover SSR, resumption, later events, delayed results and default output; with no brand views each handle renders the same markup as before.
- Admin: **agent seats** — API-token login for automation (`kind=agent`), same roles and grants as staff, hard block on irreversible/identity/credential/system routes (`auth/agent-policy.ts`), token-bound browser sessions, `assert:agent-boundary` gate, `agent-token` owner script (docs/ADMIN-AGENTS.md).
- **Payment policy hooks (PAYMENT-TIMING §3.1)**: `PaymentPolicy` gains `authorizeInvoiceEffect` (subscription entitlement effects, effects worker), `revalidateForIssuance` (issuance effects, under the order lock set), `onReservationTransition` (projection in the transition's own transaction), `shapeSettlementResponse` (`/pay` response shaping only) and `lockPlan` (lock-set plan contributor). `beforePaymentAttempt` may return `reserve` requests; the engine creates the `order_reservation` rows in the same transaction. Placement tenders (zero total, gift card, admin manual `markPaid`, order-edit `record_payment`) run the placement check. Defaults allow, apply, ok and no-op, so SellRight standalone behaviour is unchanged. Exported from `@sellright/api/payments`.
- Admin order purge refuses while a held reservation has provider work that could still move money, and releases the order's reservations (projected as `order_purged`) before the order row is deleted.

- **Release registration policy host**: the engine owns `POST /v1/admin/apps/releases`; plugins supply `ApiPlugin.releaseRegistration` (app/channel claims, tenant-bound service credential, validation hook, optional `repointArtifacts`). Startup fails on conflicting claims or a re-registered host route. Admin-session republish of the same `(app, channel, platform, version)` is now an upsert (was a unique-violation error); `download_artifact` conflicts still keep the existing row unless the policy opts in. See `docs/policies/RELEASE-REGISTRATION.md`.
- Entitlement authorization policy: one plugin policy consulted by every activation, refresh, update-feed, lease, trial and StoreKit link path. The default policy changes nothing.
- `/v1/licenses/activate` alias for licence activation.
- Signed entitlement formats above v2 can be negotiated with `x-entitlement-versions`; unnegotiated clients always receive byte-identical v2 tokens.
- Admin essentials for running real stores:
  - **Refunds**: per-line quantity + independent per-line restock toggle
    (a single refund can restock one line and not another), a separate
    `shippingAmount` refunded on top of the item total (own `refund.shippingAmount`
    ledger column, not folded into the adjustment bucket), and a `reason`
    field — all surfaced end to end (API `POST /v1/admin/orders/{code}/refund`
    + the order-detail refund panel), plus per-refund history with the
    restock/reason breakdown.
  - **Partial fulfillment**: `POST /v1/admin/orders/{code}/fulfillments`
    creates a fulfillment scoped to selected lines/quantities (distinct from
    the existing all-or-nothing `POST /fulfill`, unchanged for its CSV/bulk
    callers), with an optional ship-from location, tracking/carrier, and a
    `notifyCustomer` toggle that gates the customer email without ever
    gating the outbound `order.shipped` webhook. Multiple partial
    fulfillments per order are supported (split shipments); the order-detail
    page gets a per-line quantity picker and a fulfillment history list.
  - **Stock adjustments**: `POST /v1/admin/variants/{id}/stock/adjust` applies
    a signed delta with a mandatory reason — never an absolute overwrite —
    recorded as a new `stock_movement` row (now carrying an `actor`) every
    time; `GET .../stock/history` and a per-location breakdown
    (`GET .../stock/locations`) are surfaced in a new Inventory "Adjust"
    modal. Terminology is "Committed" everywhere (already was; verified
    consistent). Stock reads remain live/uncached throughout.
  - **Discounts admin**: the existing `startsAt`/`endsAt`, minimum-order-amount
    and native item-scope conditions (whole order, collections, products,
    tags — `money/coupon.ts`'s condition vocabulary, at most one scope per
    discount) and usage limits are now editable in the admin UI, including
    an edit flow for existing discounts (the API already supported all of
    this; only the UI was missing it). Discounts saved with the retired
    `at_least_n_with_facets` condition hydrate with a warning and drop the
    condition on save.
  - **Order timeline internal notes**: `POST /v1/admin/orders/{code}/notes`
    appends a staff-only note into the same `audit_log`-backed timeline as
    every other order event (no second feed to keep in sync).
  - **Shared `ConfirmDialog`**: an accessible, focus-managed confirm modal
    (`useConfirmDialog()`) replaces every `window.confirm(...)` call site in
    the admin app (orders bulk-purge, order cancel/refund, product
    archive/variant delete, blog post delete, tax zone delete, staff
    removal, affiliate payout). Icon-only buttons without an accessible name
    (copy link, remove line item, delete variant, remove/add collection
    product) now carry `aria-label`.

- Order/payment/fulfillment status split (backend de-Vendure work). The order
  API surfaces (admin order list/detail, account order list/detail, the
  public receipt, and guest tracking) now expose three separate, lowercase
  snake_case, wire-facing fields alongside the existing combined `state`:
  - `status`: `open` | `completed` | `cancelled` | `archived` — a Postgres
    STORED GENERATED column (migration 0080) computed from `state` +
    `deleted_at`, backfilled automatically for every existing order.
  - `paymentStatus`: `pending` | `authorized` | `paid` | `partially_refunded`
    | `refunded` | `voided` | `failed` — computed at read time from the
    order's payment rows (`orders/status.ts`); NOT a persisted column (see
    migration 0080's header comment for why: it depends on another table
    that changes at many independent call sites, so persisting it would need
    either a trigger or manual dual-write at every one of those sites — read-
    time derivation from the same source of truth is correct by construction
    instead).
  - `fulfillmentStatus`: `unfulfilled` | `partially_fulfilled` | `fulfilled`
    | `partially_delivered` | `delivered` — same reasoning, derived from
    `order_line`/`fulfillment` rows.

  `GET /v1/admin/orders` gains `?status=`, `?paymentStatus=`, and
  `?fulfillmentStatus=` filters (the last two backed by SQL fragments in
  `orders/status-sql.ts` that a DB test proves agree with the TS derivation).
  The internal FSM (`money/fsm.ts`, the `order_state` enum, every transition
  guard) is completely unchanged — this is a read-side projection only.

- Native coupon/promotion conditions replace the Vendure-era
  `at_least_n_with_facets` (which read `productVariant.metafields
  .facetValueIds`). Three native item-targeting conditions are available:
  `at_least_n_in_collections`, `at_least_n_products`, `at_least_n_with_tags`
  — matching against a product's real `collection_product` membership,
  product id, or native `product.tags`. `money/coupon.ts` (the runtime
  evaluator used by cart/checkout/admin order-line edits) no longer has any
  Vendure-shaped concept in it. The Vendure importer (`import/catalog.ts`,
  which is explicitly allowed to know about Vendure) now resolves each
  `at_least_n_with_facets` condition's target facet values into synthetic,
  unpublished native collections at migration time and rewrites the
  condition to `at_least_n_in_collections` — the facet id never reaches a
  live store.
- **Customer return requests** (storefront + API): `GET`/`POST /v1/shop/account/orders/{code}/returns`
  let a signed-in customer ask to return units that have shipped (only paid orders, only shipped and
  not-yet-refunded units, never the same unit in two open requests) and read each request's status
  (requested / approved / received / refunded / rejected) on their account order page. Requests land in the
  admin Returns queue unchanged; the shopper never chooses restock. New error code `NOT_RETURNABLE`.
- **Sign-in links in the storefront**: the sign-in page offers "Email me a sign-in link" when the store has
  it on (`GET /v1/shop/config` now reports `auth.magicLink`), and `/account/magic-link` exchanges the emailed
  token for a session (the API already minted the link; the storefront had no page for it).

- **Order editing** (migration 0084): `GET /v1/admin/orders/{code}/edit/context`, `GET .../edit/variants`,
  `POST .../edit/preview` (stateless: totals, per-line diff, stock delta, balance) and `POST .../edit/commit`
  (guarded by `expectedGrandTotal`, idempotent) edit a paid order's lines, adjustments, coupon and shipping.
  Stock deltas are reserved live, never cached. Adjustments are labelled +/- amounts in `order_adjustment`; each
  committed edit writes an `order_edit` row (before/after snapshot, balance, settlement). `order.shipping_override`
  marks a hand-set shipping amount. `PUT /v1/admin/orders/{code}/address` edits an address on any non-cancelled
  order. A balance is settled by refunding the difference, recording a manual payment, or emailing a pay link.
- **Balance payments**: `/pay`, NMI and Sezzle accept a Paid order with a positive amount due and charge only the
  balance. Payment status gains `balance_due` (filterable on the admin order list and export); the receipt-scoped
  `/orders/{code}` page on the storefront takes the balance payment. Edit refunds are tagged by the server-set
  `refund.metadata.source`, never the free-text reason, so they neither re-open the amount due nor claw points back twice.
- **Persisted shipping method** (migration 0086): `order.shipping_method_code` / `shipping_method_name`, also set by
  the Vendure importer. Orders created before it keep the order-edit inference fallback.
- **Loyalty bonus rules and program dashboard**: `store.config.loyalty` gains review, sign-up, first-order and
  birthday bonus points and per-product earn multipliers (all 0 / empty = off; `signupBonusSince` stops imported
  accounts qualifying retroactively). Bonus ledger rows (new `bonus` kind, migration 0085) carry a deterministic
  `source_ref` so a trigger pays once; `POST /v1/admin/loyalty/ledger/{id}/reverse` reverses a bonus without
  re-enabling it. Customers get optional `birth_month` / `birth_day`. Admin: settings for every field plus
  `GET /v1/admin/loyalty/summary` (issued, redeemed, outstanding, liability).
- **Product reviews** (migration 0085, `product_review`): `GET`/`POST /v1/shop/catalog/products/{slug}/reviews`
  (approved reviews plus rating aggregate; submissions are moderated, one per product per email). Admin queue at
  `/v1/admin/reviews` with approve/reject, public reply (`PUT /v1/admin/reviews/{id}/reply`) and
  `/v1/admin/reviews-settings`. Approval grants the review bonus. Product detail returns `productId`.
- **Storefront**: `/account/rewards`, PDP reviews (AggregateRating JSON-LD only when the count is above 0),
  earn-points notes from the store's loyalty settings, receipt-scoped balance-pay page.
- **Owner gaps**: affiliate stats by date range with per-SKU sales (`GET /v1/admin/affiliates/{id}/stats`);
  TipTap blog editor (lazy chunk); waitlist demand report + CSV (`/v1/admin/waitlist/report[.csv]`); sitemap
  preview/refresh and an SEO settings card (`/v1/admin/seo/sitemaps[/refresh]`); clear a customer's SheerID
  verification (`POST /v1/admin/customers/{id}/verification/clear`, new `customer_verification` staff permission;
  the legacy revoke route now requires it). Admin also gains the customer list counts fix, an order export dialog
  (date range, statuses, method, country, coupon, per-line rows, column presets), a manual tracking grid, CSV
  tracking import with preview, a shipping rule editor, auto-deliver run-now, accept-invite page,
  invoice/packing-slip buttons, a Stripe mode-switch error toast, and force-purge of a trashed paid order with a
  required reason.
- **Browser e2e suites**: admin (`packages/admin/e2e`, 13 specs / 54 `test()` blocks) and storefront
  (`packages/storefront/e2e`, 10 specs / 51 blocks). Each starts a throwaway API over a freshly created
  `sellright_admin_e2e` / `sellright_storefront_e2e` database on a non-superuser role and refuses
  non-e2e targets; CI jobs `e2e-admin` and `e2e-storefront`. Storefront money specs run mock NMI/Sezzle/IndexNow
  receivers and an SMTP sink.
- **Demo**: new visitor tenants start with points on at the product defaults and reviews on (no review rows are
  seeded); the demo policy allows the new owner features inside the visitor's own store (see `deploy/demo/README.md`);
  the demo admin helper understands the `/admin` mount (login hint, sidebar links, Export).

### Changed — BREAKING (pre-1.0 API consumers)

- Admin discounts API: the canonical route is now `/v1/admin/discounts`
  (`GET`/`POST`/`GET :id`/`PATCH :id`/`DELETE :id`), matching what the admin
  dashboard has always called this feature. `/v1/admin/promotions*` remains
  mounted as a deprecated alias (flagged `deprecated: true` in the OpenAPI
  doc, identical handler) for one release, then will be removed.
- Payment record wire state: an individual payment's `state` field (order
  detail endpoints, the public receipt, guest tracking) now reads lowercase,
  and `Settled` reads as `captured` instead — `pending`, `authorized`,
  `captured`, `declined`, `failed`. This is distinct from the new order-level
  `paymentStatus` above. The underlying `payment_state` Postgres enum and
  every internal read/write of it are unchanged.
- Admin dashboard label: "Tax Zones" is now "Taxes" (nav item, page title,
  empty state, delete-confirmation copy). The route path, API path
  (`/tax-zones`), and `TaxZone` type name are unchanged.

- Points & rewards (loyalty). Per-store program in `store.config.loyalty`
  (off by default): points earned per $1, points needed per $1 off, minimum
  redemption, optional maximum discount (% of subtotal) and optional expiry.
  Registered customers earn on the post-discount merchandise subtotal
  (never shipping or tax) when an order reaches Paid, once per order.
  Checkout accepts `redeemPoints` (signed-in only): re-validated under a
  per-customer lock, applied as a pre-tax discount, reserved on the order,
  released when an unpaid order is cancelled (including the stale-unpaid
  job) and restored/reversed in proportion to refunds. Balances are the sum
  of an append-only, FORCE-RLS `loyalty_ledger` (migration 0070); reversals
  the balance can't cover are recorded as shortfall, never a negative
  balance. Admin: Points settings page, per-customer balance/ledger, and
  `loyalty`-permission-gated manual adjustments (audited). Shop API:
  `GET /v1/shop/account/loyalty`, `loyalty` terms on `/v1/shop/config`,
  `pointsToEarn` on cart estimates. Storefront: account balance card,
  points-to-earn on cart totals, and a redeem control at checkout.
- Importer: store-credit balances (`account_credit`) become loyalty
  `import` entries at the target's `pointsPerDollarOff` (optional
  `loyalty` block in the migration config); `account_credit_discount` and
  discount + free-shipping multi-action promotions are recorded as counted
  exclusions instead of failing the run.

### Changed

- Blog posts: `<h2>`/`<h3>` ids now survive sanitisation (new `blog` policy: ids only on h2/h3, lowercase hyphenated words, at most 80 characters), so the "In this guide" links point at rendered anchors. The related-post and body pipeline moved to `platform/blog.ts` and `platform/blog-content.ts`.
- Checkout loyalty: the checkout route reads the shopper's points account and resets an applied redemption when the discountable amount no longer allows it; the control no longer fetches by itself.
- Storefront `Price` no longer accepts the unused `variantSig` prop.
- `POST /v1/shop/orders/{code}/pay`: a settled tender is recorded before the reply. A payment policy may shape that reply to a 409 (for example `ORDER_NOT_PAYABLE`); with no override the success body is unchanged.

- Malformed typed extensions on trial and activation requests return 400 `INVALID_REQUEST` instead of 500.
- NMI test profiles can use an existing merchant account on the production
  endpoint with per-transaction test mode. Endpoint identity is retained for
  replay, reconciliation and refunds.

- Web/admin favicons, touch icons, and manifest artwork now use the selected
  SellRight mark from the verified cross-platform asset kit.

### Fixed

- Storefront: two optional brand tokens for the root layout: `--brand-color-page` (the page background behind every route, default the parchment colour) and `--brand-header-offset` (the header height `<main>` clears, default 4rem); a brand whose header is not 64px tall no longer starts every page 4px off.
- Storefront: the base element typography (h1-h6, body/p/li/span/div, strong, form controls) moved from `@layer utilities` to `@layer base`. As utilities they overrode every base- and components-layer rule, so a brand theme could not set its body weight or let a span inherit its parent's display font; utility classes and unlayered component styles still override them.
- Storefront: the base `global.css` no longer imports Inter from Google Fonts (blocked by the `font-src 'self'` CSP); `googleFontsPreconnect` now defaults to off.
- Storefront: the home, about, contact, privacy, terms, returns, press, order-payment and order-confirmation heads passed the identity loader's wrapper instead of the store identity (`og:image` read `undefinedundefinedundefined`, the home `og:url`/canonical fell back to the static theme origin).

- Storefront: **converted carts keep their way back to the unpaid order.** A cart that became an order is no longer erased from the browser by a stale response, a second tab, a merged/converted 409 or a confirmation page for another order. The cart service now runs every operation under one origin-wide Web Lock (`sr-cart`; without Web Locks the cart-changing flows fail closed with "Please update your browser to use the cart."), binds every response to the token it was requested for, retires a cart only on proof (definitive `CART_NOT_FOUND`, merged, or its original order read as settled/cancelled — and for a confirmation page, that page's own order), and keeps a converted cart's token. Checkout of a converted cart resumes the **original order** from its own minimal payment view (reusing the read-only `GET /v1/shop/cart/{token}/checkout`; no address/shipping form, stock gate or order POST), and shows a cancelled order as cancelled. The cart drawer offers *Continue checkout* for a converted cart and *Start a new cart* only once the order is settled or cancelled; converted lines are read-only. New orders keep the live stock read, revision check and form validation unchanged. No API, schema or stock-architecture change. Design: `docs/plans/2026-10-11-stale-cart-recovery.md`.

- Stripe balance payments: the PaymentIntent idempotency key now carries the settled-tender count and a settled
  replay is skipped (a later edit raising the total by the same amount used to replay the earlier succeeded intent
  within Stripe's 24h window); `/pay` always namespaces the balance claim by settled-tender count; `/pay` no longer
  reports Settled for a failed or amount-mismatched intent on an already-Paid order.
- Admin: toggling a discount's enabled flag no longer applies schema defaults (it zeroed the value); the discount
  edit modal no longer shows stale values after save; admins with 2FA can sign in from the UI; customer detail
  includes tags so an edit no longer wipes them. `affiliate_payouts` was missing from `UI_PERMISSION_KEYS`.
- Storefront: the confirmation receipt poll aborts on unmount; CartService adopts only the latest snapshot (stale
  coupon/refresh responses could resurrect a removed coupon or a discarded cart); legacy `sr()` sends
  `sr_cust_csrf` for signed-in customers.
- Demo: the PDP reviews read was refused by the demo policy, so the reviews block hid itself; without a catalog
  manifest the PDP had no product id or rating (now taken from product detail and the reviews summary).
- Admin **Returns -> Approve**: the "Restock" choice is now honoured (`POST /v1/admin/returns/{id}/approve`
  accepts `restock`); it used to be silently dropped, so the flag set when the request was opened always won.
- Storefront **account**: a full page load of any `/account/*` page bounced signed-in customers to `/sign-in`
  (the server-side guard looked for a cookie name the API never sets); the address book could not add or
  edit an address (empty country list, missing name/phone fields, server-side write rejected by CSRF) and
  showed stale lists; the order detail page failed to render on a direct load (invalid `<div>` inside `<p>`);
  the bare `/orders/{code}` link in order emails was a dead end and now leads to the account order or the
  order-tracking lookup.
- NMI refund reconciliation requires successful matching refund evidence,
  rather than treating a known transaction reference as settlement.
- Gateway replay and verification reject endpoint changes with a controlled
  conflict response.
- Opt-in gateway tests require an explicitly named disposable database and
  independent single-use tokens for charge and refund acceptance.
- Container CI provides the required non-owner role password and empty gateway
  secret file.

- Postgres transactions no longer stay open while Stripe, SMTP, or APNs calls
  wait on the network. Payments and refunds use a cross-process advisory lock
  around short prepare/result transactions; outboxes use claim → send →
  conditional-finalize. This prevents the idle-transaction timeout from killing
  live commerce requests and keeps retry/idempotency behavior intact.
- Broken Postgres clients are evicted when rollback fails, while the original
  request error is preserved for diagnosis.

### Security

- Google and Apple sign-in no longer reveal whether an address has an account.
  A non-authoritative identity (an address its provider does not own) gets the
  same `202 { verificationRequired, nonce }` for every address and an emailed
  link. The link redeems once, only alongside the nonce the starting client
  holds (cookie for browsers, request body for native apps), at
  `POST /v1/shop/auth/federated/confirm`. A different existing Google or Apple
  link on the account is never overwritten.
- Sign in with Apple links to an existing account by email only for
  Apple-owned addresses (Private Relay, icloud.com, me.com, mac.com); an
  unverified Apple email is refused.
- Storefront Google sign-in and its CSP origins are decided per validated
  request host, so a second host on a pinned deployment never gets the pinned
  store's button.
- The no-Vendure source guard detects wrapped `gql` tags syntactically and
  fails closed if its scanner fails.

### Security

- Google and Apple account linking reads the account row under a lock, so a
  confirmation link for an address the account has just moved away from can no
  longer attach to that account. An already-linked Google or Apple identity
  signs in even when the address is mail-throttled or no link secret is set.

### Operations

- New storefront runtime settings: `SELLRIGHT_GOOGLE_SIGNIN_HOSTS` (the pinned
  store's public hosts; empty turns Google sign-in off) and
  `SELLRIGHT_TRUST_FORWARDED_HOST=1` (set in the compose deployment) so the CSRF
  origin and store host follow the HTTPS proxy. Newsletter confirm/unsubscribe
  form posts now work behind an HTTPS-terminating proxy.
- Migration 0096 adds `federated_link_redemption` (expand-only; rollback is
  dropping the table). Production needs a sign-in link secret of at least 32
  characters (`COOKIE_SECRET`, `LICENSING_HMAC_SECRET` or `DOWNLOAD_URL_SECRET`)
  or Google and Apple sign-in for non-authoritative addresses is refused.
- Postgres operations now enable `pg_stat_statements`, log queries over one
  second, and expose a repeatable top-query inspection loop before further
  tuning. The update-heavy email and push outboxes use lower per-table
  autovacuum thresholds to prevent queue bloat.
- Postgres connections now carry a deployment-specific `application_name`.
  The operator runbook defines database-qualified statement, lock, and
  idle-in-transaction timeouts and their verification queries.

## 2026-07-17

### Added

- Mobile-admin push delivery, including APNs device-token ownership and Live
  Activity payload support (`383b53c`, `bfac16a`).
- Order detail now exposes line IDs needed to construct per-line refunds
  (`7be6ad6`).

## 2026-07-05

### Added

- Self-service account deletion and export, SQL-compiled smart collections,
  server-authoritative shipping, and DB-backed route integration coverage.

### Security

- Stored HTML sanitization, newsletter and artifact-host SSRF defenses,
  CSRF/RBAC hardening, tenant RLS coverage, and safer error disclosure.
