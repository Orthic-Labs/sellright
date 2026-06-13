# Go To Market

Last reviewed: 2026-06-13

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
- license decision.

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
