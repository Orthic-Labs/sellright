# SellRight Features

Last reviewed: 2026-09-06

SellRight is a commerce backend for operators who want ownership, multi-store control, and a standard REST contract without building every commerce primitive from zero.

## Product Capabilities

| Capability | Status | Notes |
|---|---|---|
| Multi-store backend | Built | One schema, multiple stores, RLS isolation. |
| REST + OpenAPI | Built | `/v1/openapi.json` is generated from zod route schemas. |
| React admin | Built | Dashboard, catalog, orders, customers, settings, reports, staff, marketing, content, assets. |
| Catalog management | Built | Products, variants, collections, options, images, inventory, locations. |
| Static catalog manifest | Built | Fast storefront browse path with generated JSON. |
| Checkout | Built | Server-priced checkout with stock allocation, shipping, tax, coupons, gift-card tender. |
| Payments layer | Built (Stripe) | Stripe PaymentIntents, dual test/live mode, mode-bound webhook settlement, dashboard refund/dispute reconciliation. Storefront Stripe Elements checkout is implemented; the release gate is one real test-key E2E run. Additional shopper gateways are demand-driven, not launch requirements. |
| Refunds and returns | Built at backend level | Gateway-backed refund path exists for providers that implement it. |
| Customer auth/account | Built | Register, login, Google auth, sessions, profile, addresses, password reset, email verification. |
| Transactional email | Built | SMTP-backed event email flows. |
| Promotions | Built | Coupons, automatic discounts, eligibility, usage constraints. |
| Gift cards | Built | Gift-card creation, redemption, transaction ledger. |
| Tax and shipping | Built | Store rates, country tax zones, flat/conditional shipping methods. |
| Staff/RBAC | Built | Staff invites, store membership, role/permission model. |
| Webhooks | Built | Outbound webhooks plus inbound Stripe webhook route. |
| Affiliates | Built | Affiliate tracking and admin surfaces. |
| Blog/content | Built | Blog CMS routes and admin surface. |
| App/software licensing | Built | License issuance, device activation, update manifests, licensed downloads. |
| Reconciliation export | Built | SellRight-to-Vendure export retained as migration/rollback tooling; it does not define SellRight core architecture. |
| Subscriptions / recurring billing | Built | Stripe Billing; backing order → first invoice issues the license, renewals extend the entitlement; admin list + per-customer view + hosted Customer Portal. |
| Order bulk ops | Built | Bulk cancel / trash (soft-delete) / restore / gated purge (cascade + FK-coverage guard test). |
| Server cart lifecycle | Built | Server-authoritative cart, TTL + extend-on-activity, abandonment/cleanup jobs, checkout-reads-from-cart (fail-closed). |
| Storefront migration | In progress | Catalog, collections, cart, auth, account and checkout use the SellRight REST path; real Stripe test-key E2E remains a release receipt. |
| Carrier labels/rates | Not built | Manual/flat-rate fulfillment exists; carrier integrations are later. |
| Additional shopper payment providers | Deferred | Add PayPal/COD/other providers only when a concrete deployment requires them. |

## Admin Surface

The admin SPA includes pages for:

- Dashboard and activity.
- Products, product creation, product detail.
- Collections and collection detail.
- Inventory and locations.
- Orders, order detail, draft orders, abandoned carts.
- Customers and customer detail.
- Returns, gift cards, discounts.
- Reports, affiliates, import tracking.
- Blog/content, marketing/Listmonk, webhooks.
- Settings, staff, tax zones, currency rates.

## Storefront Surface

The storefront-facing API supports:

- catalog browse/search/product lookup;
- stock visibility;
- cart and checkout;
- guest and customer auth;
- account profile and addresses;
- order history;
- shipping eligibility;
- blog/newsletter support;
- payment intent creation and payment settlement.

## Commerce Rules

SellRight keeps the core rules explicit:

- Prices are selected on the server.
- Discounts are applied with line-level rounding.
- Tax and shipping are recalculated at checkout.
- Stock is reserved under transaction control.
- Payment-sensitive actions use idempotency.
- Refunds are ledgered and provider-aware.
- Store context is enforced at the database layer.

## App Licensing Surface

The software-sales subsystem supports catalog products that issue app licenses:

- license rows issued from paid order lines;
- app key scoping;
- license activation by device;
- seat limits;
- updates eligibility;
- protected update manifests;
- protected download artifacts.

This is distinct from licensing SellRight itself as a backend product.

## Launch status

The canonical launch-candidate gate is [`docs/plans/REMAINING-WORK.md`](plans/REMAINING-WORK.md). This feature inventory intentionally does not maintain a second launch checklist; historical migration requirements such as NMI/Sezzle parity are not SellRight release requirements.
