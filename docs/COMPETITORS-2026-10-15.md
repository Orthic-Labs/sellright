# SellRight versus the field, 2026-10-15

Competitor cells are the first word of a sourced answer; full text and URLs are in `~/sites/.work/rs-docs/reports/sellright-competitors-2026-10-15.md`. SellRight's column is from the truth sheet. "unknown" means the vendor's pages checked do not say (several Sylius, Bagisto, Adobe and WooCommerce pages returned 404).

| # | Feature | SellRight | Vendure | Medusa | Saleor | Sylius | Spree | Solidus | Bagisto | Magento | WooCommerce | Shopify | PrestaShop | Shopware |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Self-hostable | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | no | yes | yes |
| 2 | Licence / production threshold | BSL 1.1; production free up to 25 people; Apache 2.0 after 4 years | GPLv3 + plugin exception;  | MIT core; Enterprise Editi | BSD-3-Clause; pricing page | MIT; Sylius Plus paid | BSD-3-Clause backend/MIT f | BSD-3-Clause; no threshold | MIT; no threshold stated | Magento OSS: OSL 3.0 (+ AF | unknown | unknown | open source; licence name  | MIT; Fair Usage: over EUR  |
| 3 | Several stores in one install | yes | yes | partial | yes | partial | yes | unknown | partial | yes | unknown | partial | yes | yes |
| 4 | One DB, row/schema isolation per store (stated) | yes (PostgreSQL row-level security, one DB) | unknown | unknown | unknown | unknown | partial | unknown | unknown | unknown | unknown | unknown | unknown | unknown |
| 5 | REST API | yes | no | yes | no | yes | yes | yes | unknown | yes | yes | partial | partial | partial |
| 6 | OpenAPI or GraphQL schema published | yes (OpenAPI at /v1/openapi.json) | yes | unknown | yes | unknown | yes | unknown | unknown | partial | unknown | yes | partial | partial |
| 7 | Browser admin included | yes (React) | yes | yes | yes | unknown | yes | yes | yes | yes | unknown | yes | yes | unknown |
| 8 | Reference storefront included | yes (Qwik) | unknown | yes | yes | unknown | yes | yes | partial | unknown | unknown | unknown | yes | partial |
| 9 | Payment providers built in | Stripe, NMI, Sezzle | partial | partial | partial | partial | yes | unknown | unknown | Braintree, PayPal variants | partial | unknown | unknown | unknown |
| 10 | Order editing after payment | yes | yes | partial | unknown | unknown | unknown | unknown | unknown | unknown | unknown | partial | unknown | unknown |
| 11 | Partial fulfilment and returns | yes | partial | partial | partial | unknown | unknown | unknown | unknown | unknown | unknown | partial | unknown | unknown |
| 12 | Software/digital licence keys product type | yes (licences, device activation, update manifests) | unknown | unknown | unknown | unknown | unknown | unknown | unknown | unknown | unknown | unknown | unknown | unknown |
| 13 | One-command / image install, signed images | yes (one command; api, admin and storefront images cosign-signed) | partial | partial | partial | partial | partial | unknown | partial | unknown | unknown | no | partial | partial |
| 14 | Published minimum server requirements | yes (2 GiB RAM, 10 GiB disk, Ubuntu or Debian) | partial | partial | partial | yes |  | ^22 (via search snippet; p | partial | partial | unknown | yes | yes | unknown | yes | partial |
| 15 | Pricing: self-hosted / vendor cloud | self-host free to 25 people; no cloud | Self-host: plans EUR 199/5 | Self-host: not on pricing  | Self-host: not stated; Clo | Self-host: free (MIT); Plu | Self-host: Community free; | unknown | Self-host: free (MIT); Bag | unknown | Self-host: free, 0% revenu | Self-host: n/a; hosted Bas | Self-host: free; hosted EU | Self-host: Community EUR 0 |
| 16 | Language and DB stack | TypeScript/Node (Hono), React 19, Qwik 2; PostgreSQL 17 | TypeScript, Node.js, NestJ | no | Python (pyproject.toml in  | PHP/Symfony/API Platform;  | Ruby gem backend (Rails no | Ruby (Rails); PostgreSQL,  | Laravel, Vue.js; MySQL, Ma | PHP; MariaDB/MySQL; OpenSe | PHP on WordPress, React; M | unknown | PHP; MySQL/MariaDB | PHP/Symfony 7, Vue.js 3; D |

## Both directions, read from the cells

**What SellRight has that the twelve do not state:** one database with row-level isolation per store (only Spree's vendor blog claims PostgreSQL RLS, in its paid Multi Tenant edition, and the same post also describes a database per tenant); software licence keys as a product type (unknown for all twelve: nobody advertises it); cosign-signed images in the install path (none states it); order editing after payment stated outright (Vendure yes; Medusa and Shopify partial; the rest unknown); a production-use threshold instead of per-month plans (Vendure self-host runs EUR 199 to 2,499 a month with Enterprise from EUR 60,000 a year; Medusa, Saleor and Shopware sell cloud or paid tiers; Shopify is hosted only at $29 to $359 a month plus Plus from $2,300).

**What they have that SellRight does not:** a vendor cloud (Medusa, Saleor, Bagisto, PrestaShop, Shopware, Shopify; Vendure's in beta); marketplaces of plugins, themes and apps (Magento, WooCommerce, Shopify, Shopware, PrestaShop, Sylius); PayPal and the long payment lists (Magento names Braintree and PayPal variants; SellRight has three providers and the SDK); GraphQL (Vendure, Saleor, Shopify); multi-database choice (Vendure, Sylius, Solidus, Bagisto run on MySQL as well; SellRight is PostgreSQL only); importers from WooCommerce and Shopify (SellRight imports from Vendure only); years of ecosystem, agencies and documentation; and for the non-technical founder you described, Shopify's and WooCommerce's hosted onboarding, which SellRight has no equivalent of yet.

**Gaps the table could not settle:** rows 4, 12 and 13 are unknown for almost everyone because vendors do not publish them; that is a reason to publish ours loudly, with the evidence, since nobody else does.

