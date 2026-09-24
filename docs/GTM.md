# Go To Market

Last reviewed: 2026-09-17

SellRight's GTM should start as proof-led dogfooding, not a public launch. The product is credible only after it runs real brands.

## GTM Principle

Do not sell the promise. Sell the proven operating model:

- one backend;
- multiple stores;
- owned data and deployment;
- REST/OpenAPI contract;
- database-enforced tenant isolation;
- real payment and refund flows;
- documented migration path.

## Linked Foundation Docs

Read these before changing the GTM:

- [Architecture](ARCHITECTURE.md): what the product is technically.
- [Features](FEATURES.md): what is built and what is not.
- [Competitors](COMPETITORS.md): how SellRight compares.
- [Market Placement](MARKET-PLACEMENT.md): who it is for.
- [Moat And Disruption](MOAT-AND-DISRUPTION.md): why it can win.

## Phase 1: Internal Proof

Goal: one owned brand runs real orders on SellRight.

Required proof:

- storefront fully uses SellRight REST for catalog/account/search/checkout;
- sandbox payment e2e passes;
- live payment e2e passes;
- refund path reaches the gateway;
- emails send;
- backup and restore are tested;
- rollback/reconciliation path is documented.
- cart/order separation and the cart-hardening gates below pass against the release candidate.

Public messaging: none. This is operating proof.

## Phase 2: Portfolio Proof

Goal: two or more brands run from one backend.

Required proof:

- stores share one API/admin;
- RLS isolation gate stays green;
- brand-specific catalog, settings, payments, and content are isolated;
- admin can switch stores safely;
- one deployment updates the shared backend without breaking stores.

Public messaging: "built for multi-brand operators" becomes credible here.

## Phase 3: Narrow Founder-Led Release

Target:

- technical founders;
- small agencies operating owned brands;
- operators with two to ten stores;
- teams leaving a duplicated Shopify/Vendure/WooCommerce setup.

Offer:

- self-hosted backend;
- paid setup or migration package;
- limited support;
- no hosted promise yet.

Sales motion:

1. Publish an architecture walkthrough.
2. Publish one migration case study from an owned brand.
3. Offer direct founder-led installs to a small number of operators.
4. Use each install to harden docs, setup scripts, and support boundaries.

## Phase 4: Productized Self-Hosted

Only after the narrow release works:

- stable install guide;
- sample storefront;
- seed data;
- migration commands;
- backup/restore guide;
- release process;
- security checklist;
- accurate documentation of the existing license and commercial-use terms.

This is the first phase where packaging and pricing matter.

## Phase 5: Hosted Option

Hosted SellRight is a separate business. Defer until:

- self-hosted support burden is known;
- production runbooks are boring;
- security posture is reviewed;
- backup/restore and incident response are rehearsed;
- pricing covers real operational responsibility.

## Messaging Spine

Use this shape:

1. **Problem:** multiple stores create duplicated backend work and platform lock-in.
2. **Product:** one owned commerce backend for multi-brand operators.
3. **Proof:** dogfooded on real brands with live checkout.
4. **Difference:** REST/OpenAPI, Postgres RLS, static catalog path, explicit money path.
5. **Boundary:** not for non-technical first stores; not a Shopify replacement for everyone.

## Launch Assets To Create Later

- Architecture post.
- Competitor comparison post.
- Migration case study.
- OpenAPI explorer.
- Local install walkthrough.
- Demo admin with sample data.
- Backup/restore proof note.
- Payment/refund proof note.

Do not create broad marketing material before Phase 2 proof exists.

## Launch Handoff

Status: implementation requirements, not completed work. The private September 17 launch audit carries the detailed SR/PAR/OPS findings and DD/RH migration procedure; do not publish that operational report or its customer-data rehearsal artifacts. This GTM document records the product hardening and public-release gates for the implementation owner, Devin. Backend readiness, private demo preparation and public product launch are distinct milestones.

Keep generic implementation in SellRight. The backend gates below do not depend on choosing or upgrading a particular storefront. No DNS, deployment, public GitHub change or real-money operation is authorized merely by this guide. Follow the sanctioned source/release workflow and obtain explicit approval for the target environment and publication. Estimate bounded implementation packets after the release baseline and deployment targets are established; no total delivery duration has been verified.

## Cart Hardening Before Production

Preserve the existing architecture: a fast local display mirror, a server-authoritative cart in separate cart/cart_line tables, and an order created only on explicit Place Order submission. Adding or editing cart items must not create orders, consume order numbers or reserve stock. Payment retries should resume the resulting order, not create another order. There is no need for a new cart service, plugin framework or additional checkout entity merely to enforce these rules.

These are source-level findings/recommendations from the September 17 follow-up, not newly executed concurrency tests. Reproduce each failure with synthetic data before fixing it.

| Gate | Implementation requirement | Acceptance receipt |
|---|---|---|
| CART-01: single conversion | Serialize checkout against cart edits, merges and competing checkout requests using the existing transaction machinery. Enforce one order for a converted cart, including requests with different or missing idempotency keys. Bind idempotency to a validated request fingerprint; same key with changed input must not silently reuse a different request. An authorized retry after a lost response returns the original order/receipt. | Race identical/different-key submissions against the same cart and concurrent edits. Exactly one order, one stock allocation and one promotion/tender application; no extra charge initiation. Replays cannot disclose another customer's receipt. |
| CART-02: terminal converted carts | Reject line edits, identity changes and merge operations that would reopen a converted cart. The current applyLines helper resets status to active without this guard. Start a fresh cart for new shopping; keep recovery of the existing payment/order separate. | Convert, then PATCH/merge the old token: conversion remains terminal and its order link unchanged. Repeat after failed payment, reload and delayed network responses. |
| CART-03: revision-aware updates | Introduce a monotonic cart revision and reject stale writes across line, merge and checkout operations. Return a current snapshot/conflict so a caller can reconcile; do not silently overwrite newer quantities. Keep the legacy tokenless checkout path explicitly scoped during compatibility rollout, not an accidental bypass of server-cart rules. | Two clients read revision N; only the first conflicting write succeeds. Checkout of a stale revision requires reconciliation. Deletions, rapid changes, cross-device merge and out-of-order responses retain the intended contents. |
| CART-04: lifecycle and retention | Separate inactivity, resumability and data-retention rules. Current cleanup removes only expired empty active carts and retains abandoned carts. Record owner-approved durations for abandoned contents/contact data; aggregate or anonymize analytics where appropriate. Converted-cart cleanup must preserve financial orders and required history. Do not treat an email match as proof of account ownership. | Time-controlled cleanup/recovery tests cover active, abandoned, converted and returning carts, verified account merge, and tenant isolation. No accidental loss of open payment recovery, order history or stock ownership. |

Primary targets: packages/api/src/routes/cart.ts, routes/checkout.ts, db/schema-content.ts, jobs/cart-maintenance.ts, cart/ttl.ts and their migrations/tests. Use one consistent locking/version protocol across mutations, conversion and background jobs. Do not hold a database transaction open during gateway network calls. Reuse existing order/payment recovery, RLS and outboxes.

**CART-04 durations — owner decision 2026-09-24:** idle carts, including abandoned and non-converted ones, are retained 24 hours before purge. `CART_TTL_DAYS` (empty active/merged carts) and `CART_RETENTION_DAYS` (non-empty abandoned carts) both default to `1` (env-overridable; `CART_RETENTION_DAYS` previously had no deployment default at all and defaulted to "retain forever" per store). `CART_ABANDON_HOURS` (default 4, unchanged) still just flags a non-empty cart 'abandoned' for recovery/analytics partway through that window — it is not itself a deletion point. Converted carts and their orders are never purged by any of these knobs, at any age.

Exit: focused route/database concurrency tests pass under the nonowner runtime role, followed by the normal product gates. The acceptance matrix explicitly proves no order exists before Place Order, stock remains unreserved during shopping, and one submission produces at most one order even under retries. These are production gates, not demo polish.

## Domain and Demo Store

Adrian reports purchasing sellright.cc. Registration is owner-reported; DNS delegation, hosting and TLS are not yet verified. Recommended layout:

| Host | Purpose |
|---|---|
| sellright.cc | Canonical product site, documentation at /docs, installation/license/support links and entry points to the demo. |
| www.sellright.cc | Redirect to the canonical apex; do not maintain duplicate content. |
| demo.sellright.cc | Working demonstration shop with a same-origin /v1 reverse proxy to the isolated demo API. |
| demo-admin.sellright.cc | Restricted demonstration admin, also using a same-origin /v1 proxy to that demo API. Never the production staff console. |

This layout is an engineering recommendation, not a platform requirement. Avoid adding a separate public API host until there is a concrete consumer need. Serve exact allowed hostnames with HTTPS, use host-only cookies rather than Domain=.sellright.cc, and test authentication, CORS/CSRF and redirects across the selected hosts. DD and RH keep their own customer-facing domains. Configure origin restrictions through the existing deployment tooling; a DNS record alone does not establish a working, secure service. See [Cloudflare subdomain guidance](https://developers.cloudflare.com/dns/manage-dns-records/how-to/create-subdomain/).

### Demo Requirements

- Provide both an actual shopping journey and a restricted admin view. Use a synthetic catalog with licensed/original product images, variants, stock, preorder/sale examples and seeded order/refund/fulfillment history. A second synthetic store can demonstrate tenant switching without exposing an actual brand's records.
- Use an isolated demo deployment, database identity/database, asset namespace, session/signing secrets and gateway environment. Do not attach public visitors to the production API or rely only on a store selector/RLS to protect live merchants. Never seed from the DD/RH clone, production customer accounts, password hashes, addresses, historical provider IDs or affiliate balances.
- Use provider sandboxes/test credentials only and fail closed if live mode or live credentials are configured. Keep public demo traffic separate from the private gateway acceptance environment so visitors/reset jobs cannot corrupt PAY-1/PAY-2 evidence. Stripe supports isolated sandboxes; a simulated/mock result must be labeled simulated, not presented as provider verification. [Stripe sandbox documentation](https://docs.stripe.com/sandboxes)
- Route email to a controlled sink. Disable outbound customer email, SMS, push, Listmonk enrollment, merchant feed publication, indexing submissions, arbitrary webhooks and real fulfillment. Do not collect real card details; prominently identify the environment as a demo with no shipment or real payment.
- Default the public admin to server-enforced read-only access with sensitive endpoints blocked. No public shared superadmin, credential/settings editing, staff invites, arbitrary uploads, exports or outbound URL configuration. Offer write-capable demonstrations only through separately isolated sessions or supervised access after abuse controls are proven.
- Rate-limit public creation and mutation endpoints, cap cart/order volume and storage, and monitor errors/resource use. Define a deterministic reset cadence, preserve only required diagnostics, expire sessions/tokens after reset, and prevent late sandbox webhooks from attaching to reused identities. Reset jobs must assert a demo-only environment/database marker and refuse production targets.
- Mark demo content noindex; robots directives are not access control. Keep the product site indexable, use canonical URLs and check all navigation/demo links on mobile and desktop.

### Implementation Sequence

1. Close backend blockers and CART-01 through CART-04 on the reviewed release candidate. Private demo design/fixture preparation can proceed concurrently; do not expose known unsafe cart/payment/admin paths publicly.
2. Inventory existing bootstrap, schema/test fixtures and deployment tooling. Reuse them for a deterministic synthetic demo seed/reset command; the inspected bootstrap is not proof a complete demo catalog/reset capability exists. Record planned files, commands and bounded estimates before implementation.
3. Provision the approved isolated environment and seed data. Configure sandbox-only payment, outbound sinks, restricted roles and quotas; verify that production networks, secrets and resources are inaccessible to it.
4. Implement a minimal functional sample shop against SellRight's public contracts, reusing suitable existing client code without introducing generic backend changes elsewhere. Preserve no-order-before-submit behaviour. Mount the existing admin with the restricted demo policy rather than building a second admin application.
5. Configure the approved sellright.cc DNS/proxy/TLS routes and www redirect. Validate HTTPS, exact host routing, cookie isolation, demo noindex and origin access restrictions. Do not change DD/RH DNS or webhook ownership for a product demo.
6. Test shopping, checkout, controlled sandbox payment, admin browsing, reset, expired sessions, late webhooks, abuse limits and attempted access to sensitive operations. Record exact commit/build, demo fixture version and screenshots. Prove zero live charges, external customer messages and production data access.
7. Publish the demo and link it from the product site/GitHub only after its safety gates pass and public release is approved. Keep the existing proof-led GTM sequence: a public demo is useful for the founder-led release, but it does not replace DD/RH production and migration receipts. An invitation-only preview can precede broad promotion.

Exit: a visitor can inspect the product and complete the demonstrated journey without spending money, contacting a real customer or changing a production store. A demo supports public product release; building it does not itself block a separately approved DD/RH cutover.

## Final Launch Note: Clean Up Public GitHub Information

Before public product promotion, audit and finish the entire public-facing repository presentation. Do not leave half-finished scaffolding, contradictory claims or stale installation instructions. This is a required GTM deliverable, not a claim that cleanup has already happened.

- Review the actual public repository, not just the local checkout: About description, sellright.cc website link, topics, social preview, README, pinned material, documentation links, releases and screenshots. External metadata changes require the normal GitHub access/release workflow.
- Rewrite setup and architecture instructions against a fresh checkout of the exact release. The inspected root README still lists a packages/storefront layout; reconcile every path/command with the actual product. State supported deployment models, requirements, migrations and recovery clearly, without publishing internal hostnames, infrastructure maps or credentials.
- Preserve the authoritative LICENSE and accurately describe its existing source-available/commercial terms. Do not casually relabel the current BSL product as OSI open source, invent new licensing terms or turn an already-set license into a new owner gate.
- Distinguish implemented, verified and planned capabilities. Remove unsupported zero-defect/production-ready claims and fake badges, metrics or testimonials. Check demo, docs, install and support links; use screenshots from synthetic data only.
- Review CONTRIBUTING, issue/PR templates, changelog/release notes, support expectations and private security-reporting instructions. Add or repair missing community/security files as appropriate, and verify actual branch/security settings instead of assuming configuration files prove they are enabled. [GitHub community-profile guidance](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/about-community-profiles-for-public-repositories)
- Inspect publishable files, Git history and release artifacts for credentials, personal/customer data, internal audit dumps and accidental generated content using existing scanners. Do not commit the private .audit tree or migration manifests. If a secret is found, stop publication and arrange revocation/rotation; deleting a file is not remediation. Do not rewrite history, delete unrelated work or remove attribution without explicit approval. [GitHub repository-security guidance](https://docs.github.com/en/repositories/creating-and-managing-repositories/best-practices-for-repositories)

Final receipt: reviewed public URLs/screenshots, fresh-checkout setup verification, working demo/docs links, accurate license/status text and scanner results tied to the approved release. Public GitHub cleanup is complete only after the visible repository has been checked, not merely because a checklist or local README edit exists.
