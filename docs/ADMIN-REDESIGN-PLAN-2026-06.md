# SellRight Admin Redesign Plan

Date: 2026-06-13
Status: proposed, revised after `/review-self plan`
Scope: `packages/admin`

## Decision

Redesign the admin from a flat CRUD console into a Shopify-caliber operator workspace.
The first pass should preserve the existing React/Vite/Tailwind stack and API contracts,
but replace the shell, navigation model, empty/list states, settings IA, and shared
surface patterns.

The product should feel like a serious daily operating tool: dense enough for repeated
use, calm enough for new merchants, and specific to store operations rather than a
generic admin template.

## Success Criteria

- The top-left shell identity shows the active store name, not `SellRight`.
- The 20-item sidebar is grouped into clear operating areas.
- Every high-frequency page has a useful empty state and a real list/table scaffold.
- Orders, Products, Customers, Inventory, Marketing, Reports, Staff, and Settings each
  have page-specific workflows instead of generic card layouts.
- Mobile has an explicit navigation affordance and usable top bar.
- Forms have labels, validation, error states, and save/cancel behavior that is visually
  consistent.
- Visual QA passes desktop and mobile screenshots for shell, dashboard, list pages,
  settings, forms, dropdowns, loading, empty, error, hover, focus, and selected states.
- A merchant can answer these in under 10 seconds from the UI: what needs fulfillment,
  what stock needs attention, whether payments/integrations are healthy, and where to
  add or edit products.
- Repeated workflows require fewer obvious context switches: product creation, order
  triage, inventory adjustment, and settings edits each stay inside one coherent page
  model.

## Non-goals

- Do not change commerce logic, RLS, auth, payments, or API contracts unless a UI state
  cannot be represented with the current API.
- Do not chase a marketing-site aesthetic. This is an operator console.
- Do not clone Shopify visually. Use Shopify as a bar for information architecture,
  density, state quality, and interaction polish.
- Do not introduce a new design system library in the first pass.
- Do not rebuild the storefront.

## Benchmarks

Use Shopify Admin, Stripe Dashboard, Linear, and modern inventory/ops tools as reference
standards:

- Shopify: store-first shell, grouped admin navigation, high-quality empty states,
  resource lists, bulk actions, settings IA.
- Stripe: precise status language, strong table density, trustworthy detail views.
- Linear: compact navigation, keyboard-friendly interactions, refined hover/focus states.

## Quality Bar

This redesign is not complete because it looks cleaner. It is complete when the admin
behaves like a market-leading operating tool:

- **Information architecture:** the navigation teaches the product model in one scan.
- **Density:** tables and settings are compact but not cramped; whitespace has a job.
- **State quality:** empty, loading, error, disabled, validation, success, and partial
  data states are designed, not incidental.
- **Workflow continuity:** primary tasks keep context on screen and do not throw the user
  between unrelated page patterns.
- **Trust:** money, inventory, fulfillment, and security states use precise labels and
  conservative confirmation patterns.
- **Speed:** common actions are one obvious click away; secondary actions are available
  but visually quieter.

## Current Problems

### Shell Identity

`packages/admin/src/components/Layout.tsx` hard-codes `SellRight` in the sidebar and
mobile header while the active store appears separately in the top-right switcher. This
creates a split identity: the merchant is operating `MailRight`, but the app insists on
showing `SellRight`.

### Navigation

The sidebar exposes 20 destinations at the same level:
Home, Orders, Returns, Products, Collections, Inventory, Locations, Customers,
Discounts, Gift cards, Affiliates, Marketing, Blog, Reports, Activity, Tax zones,
Currencies, Webhooks, Staff, Settings.

This violates basic decision-cost and grouping principles. It is a sitemap, not an
admin IA.

### Page Patterns

Most pages use the same pattern: `PageHeader`, one white card, centered empty state.
That makes the admin feel unfinished even when the underlying feature exists.

### Settings

Settings is a two-column card grid mixing store identity, payment providers, Google
sign-in, shipping, staff, 2FA, and account. These are different workflows and should
not compete at the same hierarchy level.

### Responsive Shell

At mobile width, the sidebar disappears and the header compresses awkwardly. There is
no obvious way to reach navigation.

### States

Loading, empty, error, validation, focus, hover, selected, disabled, and success states
are under-designed. `Webhooks` can remain on a bare loading state; `Marketing` empty
submit does not surface strong validation; many empty pages provide no next step.

## Target Information Architecture

### Sidebar Groups

Primary nav groups:

- Run store
  - Home
  - Orders
  - Returns
  - Customers
- Catalog
  - Products
  - Collections
  - Inventory
  - Locations
- Grow
  - Discounts
  - Gift cards
  - Affiliates
  - Marketing
  - Blog
- Insights
  - Reports
  - Activity
- Configuration
  - Settings
  - Staff
  - Tax zones
  - Currencies
  - Webhooks

Default open groups: Run store, Catalog.
Collapsed groups should remember local preference. Keep Settings visible at the bottom
only if it remains a primary task entry, but do not duplicate it in two places.

### Store-first Shell

Top-left:

- Store mark or generated initials
- Active store name, e.g. `MailRight`
- Optional small product label: `SellRight admin`

Top bar:

- Global search
- Store switcher
- Account menu

Mobile:

- Menu button
- Active store name
- Search icon or compact search
- Account/store switcher

## Target Page Patterns

### Dashboard

Purpose: daily operating cockpit.

Add:

- Setup checklist when the store has no activity.
- Today / last 7 days / last 30 days switcher.
- Operational cards: to fulfill, returns awaiting action, low-stock SKUs, abandoned
  carts, failed payments or provider issues.
- Recent activity feed.
- Recent orders table with status badges and quick actions.

Avoid: four detached KPI cards plus a giant empty recent orders card.

### Orders

Purpose: order queue.

Keep:

- Status tabs.
- Search.
- New order.

Improve:

- Group secondary actions into an actions menu: export, import tracking, abandoned carts.
- Add table scaffold even when empty: order, date, customer, payment, fulfillment, total.
- Add saved views later: Open, Unfulfilled, Paid, Returns, Pre-orders.
- Add bulk selection and bulk action affordance once rows exist.

### Products

Purpose: catalog management.

Improve:

- Empty state should offer `Add product`, `Import products`, `Create collection`.
- Table scaffold: product, status, inventory, category/collection, price range, updated.
- Add resource-list controls: search, status filter, inventory filter, sort.
- Product create should become a full workflow page with sections:
  product information, media, pricing, inventory, variants, SEO, publishing.

### Inventory

Purpose: stock operations.

Improve:

- Table scaffold: SKU, product, location, available, committed, incoming, status.
- Add low-stock saved view and threshold controls.
- Add inline adjustment pattern for stock changes with reason.

### Customers

Purpose: customer operations.

Improve:

- Table scaffold: customer, location, orders, amount spent, last order, tags.
- Empty state should include import customers and create customer.
- Detail pages should prioritize timeline, orders, addresses, notes/tags.

### Marketing

Purpose: integration and campaign operations.

Improve:

- Separate integration setup from campaign/email features.
- Add connection state: not connected, connecting, connected, failed.
- Inline validation for URL, API user, API token.
- Explain what Listmonk syncs and when.
- After connected, show lists, subscribers, recent campaigns, sync health.

### Reports

Purpose: performance understanding.

Improve:

- Add charts or trend sparklines; static zero counters are not enough.
- Separate sales, products, customers, and acquisition.
- Every metric should show period comparison, not only current value.
- Empty/zero state should explain whether the store has no orders or the date range has
  no orders.

### Staff

Purpose: team and permissions.

Improve:

- Keep team table and invite flow.
- Move permission key reference behind a disclosure, tab, or secondary page.
- Add role explanation and permission preview before invite generation.

### Settings

Purpose: configuration hub.

Replace two-column mixed cards with section navigation:

- Store profile
- Payments
- Checkout
- Shipping
- Taxes
- Notifications
- Customer accounts
- Security
- Team
- Integrations
- Developer

Each section should have one primary action and a clear save/cancel model.

## Shared Component Work

Create or upgrade these reusable primitives in `packages/admin/src/components`:

- `AppShell`
- `SidebarGroup`
- `MobileNavDrawer`
- `TopBar`
- `ResourcePage`
- `ResourceToolbar`
- `ResourceTable`
- `EmptyStateActionPanel`
- `StatusBadge`
- `ActionMenu`
- `SettingsSectionNav`
- `FormSection`
- `InlineAlert`
- `SkeletonBlock`
- `ErrorState`

Keep the first pass small: evolve the existing `Layout.tsx` and `ui.tsx` before
splitting too aggressively.

## Visual System Direction

Use a restrained commerce-ops palette:

- Neutral base with enough contrast between shell, canvas, surfaces, and controls.
- Green remains the command/accent color, not a decorative wash.
- Semantic colors for payment, fulfillment, inventory, risk, success, warning, error.
- Reduce overuse of large white cards. Use tables, panels, section dividers, and
  grouped rows where they fit the workflow.
- Keep radii modest. Cards should be individual surfaces, not nested decorative boxes.
- Use tabular numerals for KPIs, totals, counts, and table money.
- Preserve visible focus rings and keyboard navigation.

## Implementation Sequence

Before Phase 1, create a small visual QA dataset or mock mode for admin pages. Empty
stores are useful, but they are not enough to judge table density, row actions, long
names, money formatting, low stock, failed provider states, or permission variations.

### Phase 1: Shell and Navigation

Files:

- `packages/admin/src/components/Layout.tsx`
- `packages/admin/src/components/ui.tsx`
- `packages/admin/src/index.css`

Tasks:

- Replace `SellRight` header identity with active store name.
- Add small `SellRight admin` product label where needed.
- Group navigation into the IA above.
- Add mobile nav drawer and menu button.
- Improve store switcher and account menu states.
- Add accessible labels for global search and icon-only controls.

Acceptance:

- Desktop sidebar has grouped nav.
- Mobile has usable nav.
- Active route is clear inside a group.
- Store identity is not duplicated/confusing.
- Keyboard focus can move through groups, store switcher, search, account menu, and
  mobile drawer without trapping the user.

### Phase 2: Resource List Standard

Files:

- `packages/admin/src/components/ui.tsx`
- `packages/admin/src/pages/Orders.tsx`
- `packages/admin/src/pages/Products.tsx`
- `packages/admin/src/pages/Inventory.tsx`
- `packages/admin/src/pages/Customers.tsx`

Tasks:

- Build `ResourcePage`, `ResourceToolbar`, `ResourceTable`, and richer empty states.
- Convert Orders, Products, Inventory, Customers to the shared pattern.
- Add table scaffolds for zero states.
- Normalize search/filter/action placement.
- Add QA rows covering long product names, long customer emails, multiple statuses,
  money totals, low stock, and empty dates.

Acceptance:

- Empty lists no longer feel like blank cards.
- Primary action is obvious.
- Secondary actions are grouped.
- Tables have stable headers, status badges, and loading/error/empty states.
- Table layout does not shift when rows, filters, or loading states appear.

### Phase 3: Settings IA

Files:

- `packages/admin/src/pages/Settings.tsx`
- possible new settings section components

Tasks:

- Replace mixed card grid with settings section navigation.
- Give payments, shipping, tax, security, staff, customer sign-in, and account distinct
  sections.
- Standardize edit/save/cancel behavior.
- Add inline validation and explanatory helper text only where it prevents mistakes.

Acceptance:

- Settings feels like a configuration hub, not a dashboard.
- Payment provider toggles communicate configured vs unavailable vs enabled.
- Security and account actions are visually distinct from store configuration.
- Dangerous or account-level actions are separated from routine store settings.

### Phase 4: Workflow Pages

Files:

- `Marketing.tsx`
- `Reports.tsx`
- `Staff.tsx`
- `ProductCreate.tsx`
- `ProductDetail.tsx`

Tasks:

- Add Listmonk connection states and validation.
- Upgrade reports with trend/comparison structure.
- Move Staff permission reference into secondary disclosure.
- Expand product create/detail into sectioned product workflow.

Acceptance:

- Marketing setup cannot silently fail.
- Reports communicate period, comparison, and zero-state meaning.
- Product create feels like a merchant workflow, not a raw form.

### Phase 5: Polish and QA

Tasks:

- Capture desktop and mobile screenshots for shell, dashboard, orders, products,
  settings, marketing, staff, reports, and product create.
- Test hover, focus, selected, loading, empty, error, validation, dropdown, drawer, and
  save/cancel states.
- Run typecheck/build.
- Fix text wrapping, contrast, hit areas, and focus order.
- Compare the redesigned pages against the captured baseline screenshots in
  `.cache/admin-audit` and record remaining regressions.

Acceptance:

- Visual review passes under `review-frontend`.
- No major responsive overlap.
- Keyboard navigation reaches search, nav, store switcher, menus, forms, and actions.

## Test Plan

- `pnpm --dir packages/admin build`
- Manual browser QA against local admin:
  - desktop 1440x1000
  - tablet 768x1024
  - mobile 390x844
- Verify:
  - login
  - store switcher
  - global search open/close/no results
  - grouped nav active states
  - mobile drawer open/close
  - list page empty/loading/error
  - settings edit/save/cancel
  - marketing validation
  - product create validation
- Seeded/mock visual states:
  - populated resource table
  - empty resource table
  - long text/overflow rows
  - loading state
  - API error state
  - disabled action
  - validation error
  - successful save

## Risks

- Scope creep: trying to redesign every detail page in one pass could stall the work.
  Mitigation: land shell and resource-list primitives first.
- API gaps: richer states may need fields the API does not return. Mitigation: design
  graceful UI states first; add API fields only when unavoidable.
- Shopify imitation: copying surface styling would make SellRight feel derivative.
  Mitigation: benchmark workflow quality, not visual branding.
- Data-light screenshots: empty stores hide table density problems. Mitigation: add
  seeded QA data or mock rows for visual QA.
- Accessibility regressions: custom grouped nav and menus can break focus behavior.
  Mitigation: keyboard QA is part of Phase 5.
- Over-building shared components too early could make the simple pages harder to change.
  Mitigation: extract components only after two pages prove the pattern.
- Visual polish can mask weak workflow decisions. Mitigation: every phase has a workflow
  acceptance check, not only a screenshot check.

## Rollout

Ship in slices:

1. Shell/nav behind normal build.
2. Resource list pattern for Orders/Products/Customers/Inventory.
3. Settings IA.
4. Marketing/Reports/Staff/Product workflow upgrades.
5. Final visual QA and polish pass.

Rollback is simple for each slice because API contracts remain unchanged. Each phase
should be a reviewable PR or commit-sized patch.

## `/review-self plan` Result

Verdict: PASS WITH REVISIONS.

Findings applied:

- Clarified the market-leader quality bar so "Shopify-caliber" means IA, density,
  state quality, trust, and workflow speed rather than visual imitation.
- Promoted seeded/mock visual data from a risk to a pre-Phase-1 task.
- Added keyboard and table-stability acceptance criteria.
- Added explicit handling for dangerous/account-level settings actions.
- Added baseline screenshot comparison against `.cache/admin-audit`.

Residual risks:

- The plan still needs actual pixel execution and `review-frontend` evidence before any
  implementation can be called good.
- Some richer workflow states may require small API additions once the UI is built
  against real populated data.
