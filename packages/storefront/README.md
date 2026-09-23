# @sellright/storefront

A generic, themeable e-commerce storefront built with [Qwik](https://qwik.dev/) and Qwik City, wired to the SellRight REST commerce API (`packages/api`). No brand identity is hardcoded in this package — store name, logo, colors, fonts, contact details, social links, payment providers, and JSON-LD organization data are all supplied per-deployment through `src/theme/theme.config.ts` and its environment variables.

Pages: home, shop (with client-side category/search filters), collection/category pages, product detail (with variant selection), cart drawer, checkout, account, order tracking, search, and blog.

## Configuring a store

All configuration is env-driven (Vite `VITE_*` vars, read at build time). Nothing needs to be hardcoded to rebrand a deployment — set env vars and rebuild.

| Variable | Purpose | Default |
|---|---|---|
| `VITE_SELLRIGHT_API_URL` | SellRight API base URL | `http://127.0.0.1:3300` |
| `VITE_SELLRIGHT_STORE_SLUG` | Store slug sent as `x-store-slug` | `demo` |
| `VITE_PUBLIC_DOMAIN` | Public domain (no protocol), used for canonical/CSP/allowed-hosts | `localhost:4100` |
| `VITE_PUBLIC_SITE_ORIGIN` | Full origin used by sitemap/robots generation | `https://example.com` |
| `VITE_STORE_NAME` | Display name (header, footer, JSON-LD, page titles) | `Storefront Demo` |
| `VITE_STORE_LEGAL_NAME` | Legal entity name (terms/privacy copy) | = `VITE_STORE_NAME` |
| `VITE_STORE_TAGLINE` | One-line tagline (hero, meta description default) | `Quality products, delivered.` |
| `VITE_STORE_SUPPORT_EMAIL` | Public support/contact email | `support@example.com` |
| `VITE_STORE_LOGO_TEXT` | Wordmark text if no logo image configured | = `VITE_STORE_NAME` |
| `VITE_STORE_LOGO_URL` | Logo image path/URL | none (text logo) |
| `VITE_STORE_OG_IMAGE` | og:image / JSON-LD image path | `/og-image.jpg` |
| `VITE_STORE_ADDRESS_STREET` / `_CITY` / `_REGION` / `_POSTAL` / `_COUNTRY` | Postal address for Organization JSON-LD and legal pages | unset (address omitted) |
| `VITE_STORE_SOCIAL_INSTAGRAM` / `_FACEBOOK` / `_TWITTER` / `_TIKTOK` / `_YOUTUBE` | Social profile URLs | unset (icon hidden) |
| `VITE_THEME_COLOR_PRIMARY` / `_SECONDARY` / `_ACCENT` / `_BACKGROUND` / `_SURFACE` / `_TEXT` / `_TEXT_MUTED` / `_BORDER` | Brand colors (CSS custom properties) | neutral blue/gray palette |
| `VITE_THEME_FONT_DISPLAY` / `_BODY` / `_MONO` | Font stacks | Inter (Google Fonts) |
| `VITE_STORE_CURRENCY` / `VITE_STORE_LOCALE` | Currency/locale defaults | `USD` / `en` |
| `VITE_SHOP_CATEGORIES` | Comma-separated shop-page category filter labels | `New,Bestsellers,Sale` |
| `VITE_HOME_SPOTLIGHT_SLUG` | Optional homepage spotlight product slug | unset (section hidden) |
| `VITE_SEZZLE_MERCHANT_UUID` | Enables the Sezzle payment badge/widget | unset (hidden) |

Payment providers (Stripe, NMI, Sezzle) are never hardcoded — the storefront calls `GET /v1/shop/config` on the API and only shows a tender path the store has actually configured server-side (see `src/utils/sellright.ts:srShopConfig`).

See `src/theme/theme.config.ts` for the full typed config surface.

## Development

Development mode uses [Vite's development server](https://vitejs.dev/). During development, the `dev` command will server-side render (SSR) the output.

```shell
pnpm dev
```

## Preview

```shell
pnpm preview
```

## Production

### SellRight Catalog Notifications

Automatic IndexNow submission uses `POST /indexnow/`, not the manual GET key.
Configure `INDEXNOW_HOST`, `INDEXNOW_KEY`, optional `INDEXNOW_KEY_LOCATION`,
`INDEXNOW_STORE_ID` (the SellRight store UUID), and `INDEXNOW_WEBHOOK_SECRET`.
Serve the key file on that host as required by the
[IndexNow protocol](https://www.indexnow.org/documentation).
Register a SellRight webhook endpoint for this storefront's HTTPS `/indexnow/`
URL, with the same signing secret and topic `catalog.product_changed`.
Use a distinct endpoint/secret for each store.

```shell
pnpm build
```

## Known gaps

- `/v1/shop/collections/{slug}` (packages/api) returns `slug`/`name`/`minPrice` only — no image or in-stock flag, unlike `/v1/shop/catalog/search`. The collection page therefore renders a text/price grid, not full product cards. Adding `image`/`inStock` to that endpoint would allow reusing `ProductCard`.
- `searchQueryWithCollectionSlug` (`src/providers/shop/products/products.ts`) silently drops `collectionSlug` when `term` is empty, because `/v1/shop/catalog/products` has no collection filter — only `/v1/shop/catalog/search` does, and that requires a non-empty term. The collection page works around this by calling `/v1/shop/collections/{slug}` directly instead.
- No shop-facing affiliate-stats REST endpoint exists yet; `src/providers/shop/affiliate/affiliate.ts` still issues a raw GraphQL query against a Vendure plugin that this stack doesn't have. The `/affiliate` route is present but will not return real data until a `/v1/shop/affiliate/*` endpoint is added to `packages/api`.
