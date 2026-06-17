# SellRight Admin Validation Fix Plan

## Summary

Local SellRight product work only. Current local `main` is clean and matches GitHub `adrdsouza/sellright main` at `460d117`.

Validation found:

- Admin typecheck/build pass only when run directly from `packages/admin`; root workspace filters skip admin because it is excluded from `pnpm-workspace.yaml`.
- Staff permissions UI can erase existing grants because `GET /staff` does not return stored permissions.
- No global toast system.
- No `Ctrl/Cmd+K` command palette.
- Dashboard still relies on all-time `/dashboard` metrics instead of period trends.
- Order/Product/Customer detail pages are still less polished than redesigned list/settings pages.
- Bulk order actions and saved views are absent.
- Dense-row QA is under-proven because there is no dev-only mock data mode.

Reviewer feedback folded in: avoid a big-bang build, preserve backward compatibility, add measurable acceptance criteria, and do not implement bulk actions as unreliable client-side N+1 calls.

## Implementation Guide

### Phase 1 - Correctness And Verification Foundation

1. Fix root verification scripts.
   - Add root scripts:
     - `admin:typecheck`: `pnpm --dir packages/admin typecheck`
     - `admin:build`: `pnpm --dir packages/admin build`
   - Update root `verify` to include those scripts explicitly.
   - Keep `packages/admin` excluded from workspace unless there is a separate dependency reason to change it.
   - Update admin README with the correct root and package-local commands.

2. Fix Staff permissions data integrity.
   - Backend: update `GET /v1/admin/staff` to return `permissions` from `admin_user_store.permissions`.
   - Frontend: add `permissions?: Record<string, boolean> | null` to `StaffMember`.
   - Initialize `PermissionsMatrix` from actual member permissions, not `{}`.
   - Reset local checkbox state when switching members or when server data refreshes.
   - Keep `PUT /staff/{id}/permissions` backward-compatible:
     - Do not reject unknown existing keys in this phase.
     - Only render known permission keys in the UI.
     - When saving, preserve unknown existing keys and overwrite only known UI-managed keys.
   - Add a visible "No extra permissions granted" state.
   - Acceptance:
     - Existing grants display correctly.
     - Saving one permission does not erase other known or unknown grants.
     - A staff member with `giftcards: true` still has that grant after opening/saving the editor.

3. Add automated tests for Phase 1.
   - API test: `GET /staff` includes `permissions`.
   - API test: permission update preserves unknown keys.
   - Frontend/component test or focused integration test: permissions editor initializes from server data and preserves untouched grants.
   - Verification commands:
     - `pnpm verify`
     - `pnpm --dir packages/admin typecheck`
     - `pnpm --dir packages/admin build`

### Phase 2 - Feedback And Navigation Polish

1. Add global toast system.
   - Add `ToastProvider` near the admin root provider tree.
   - Add `useToast()` hook.
   - Toast shape:
     - `id`
     - `tone: success | error | info`
     - `title`
     - optional `message`
     - optional `action`
   - Success/info auto-dismiss after 4s.
   - Errors remain until dismissed.
   - Accessibility:
     - success/info use `role="status"`
     - errors use `role="alert"`
   - Layout:
     - desktop top-right stack
     - mobile bottom stack
   - Wire first to high-frequency mutations:
     - inventory stock save
     - marketing connect/sync/campaign draft
     - product create/save/image upload
     - order fulfill/cancel/refund
     - staff invite/role/permission/session/remove
   - Keep inline field errors for correction; toasts are confirmation and global failure visibility.

2. Add command palette.
   - Mount `CommandPalette` inside `Layout`.
   - Open with `Ctrl+K` and `Meta+K`.
   - Do not remove existing header search.
   - Commands:
     - main routes
     - create actions
     - settings/staff/report shortcuts
     - remote results from `/v1/admin/search?q=...`
   - Search behavior:
     - no API call for 0-1 chars
     - debounce 150-250ms
     - group results by Orders, Products, Customers
   - Keyboard behavior:
     - ArrowUp/ArrowDown moves active item
     - Enter executes
     - Escape closes
     - click outside closes
     - focus returns after close
   - Shortcut safety:
     - ignore when target is input/textarea/contenteditable unless modifier shortcut is used intentionally.
   - Metrics to expose in code/loggable events:
     - palette opened
     - command executed
     - search result executed
     - no-result search

3. Phase 2 tests.
   - Toast success appears exactly once after a mocked mutation.
   - Error toast appears on mutation failure.
   - Command palette opens/closes with keyboard.
   - Route commands navigate correctly.
   - Search results navigate correctly.
   - Escape restores focus.

### Phase 3 - Dashboard And Detail Page Upgrade

1. Extract shared report helpers.
   - Move Reports half-period delta logic into an admin `lib` helper.
   - Add tests for:
     - positive delta
     - negative delta
     - zero previous period
     - empty series
     - short series

2. Upgrade Dashboard trends.
   - Add query for `/v1/admin/reports/sales?days=30`.
   - Preserve existing operational cards as the first visual priority.
   - Add compact revenue/orders trend display with honest labels:
     - "last 30 days"
     - "vs previous period"
     - "new" or neutral state when prior period is zero
   - Add a small sparkline/bar strip using real series data.
   - Do not fabricate trend data.

3. Redesign detail pages using existing primitives.
   - OrderDetail:
     - use `PageHeader`, `StatusBadge`, `FormSection`, `InlineAlert`, `ErrorState`
     - separate items, fulfillment, timeline, customer, address, payment, refund/danger sections
     - disabled states for non-fulfillable orders
     - toast on fulfill/cancel/refund success
   - ProductDetail:
     - section product basics, media, status, variants/inventory, options
     - clear dirty state with Save/Cancel
     - preserve current validation before PATCH
     - toast on save/image/variant changes
   - CustomerDetail:
     - summary KPI cards
     - profile edit section
     - ResourceTable-style order history
     - address/contact panels
     - empty states for no orders/addresses

4. Phase 3 tests.
   - Dashboard trend helper unit tests.
   - Detail pages render loading/error states.
   - Long names, addresses, SKUs, and emails do not overflow.
   - Save buttons disable while pending.
   - Destructive actions require confirmation.
   - Mutation success emits toast.

### Phase 4 - Orders Bulk Actions And Saved Views

1. Extend `ResourceTable` with optional selection.
   - Optional checkbox column.
   - Selected row ids controlled by parent.
   - Select all visible rows only.
   - Clear selection.
   - Bulk toolbar slot.
   - No cross-page hidden selection in v1.

2. Add backend batch endpoint for safe bulk fulfillment.
   - Add `POST /v1/admin/orders/bulk-fulfill`.
   - Request:
     - `orders: Array<{ code: string; state: "Shipped" | "Delivered"; trackingCode?: string; carrier?: string }>`
     - max 100 orders per request
   - Reuse existing fulfillment transition rules.
   - Return per-order results:
     - `code`
     - `ok`
     - `fulfillment?`
     - `error?`
   - Do not make the whole batch fail because one order is ineligible.
   - Add audit log entries per successful order.
   - Send shipping notifications only for successful shipped transitions, same semantics as existing single-order fulfill.

3. Add Orders UI bulk actions.
   - Enable selection only on current visible page.
   - Bulk toolbar actions:
     - Export selected CSV from visible row data.
     - Mark selected shipped.
     - Mark selected delivered.
   - Show confirmation before fulfillment actions.
   - Show inline result panel after bulk action:
     - successes
     - skipped/ineligible
     - failed with order code and reason
   - Emit summary toast after completion.
   - Clear selection after successful batch or filter/page change.

4. Add saved views.
   - URL-backed filters remain source of truth.
   - Built-in views:
     - All
     - Paid
     - Pending
     - Pre-orders
     - Cancelled
     - Refunded
   - User-created local presets stored in localStorage:
     - name
     - `state`
     - `preOrder`
     - `q`
   - No backend persistence in v1.
   - Add rename/delete for local presets only.

5. Phase 4 tests.
   - API bulk endpoint handles mixed success/failure.
   - API max batch limit enforced.
   - Selection clears on page/filter changes.
   - Bulk action result panel identifies failed order codes.
   - Saved view survives reload.
   - URL params and selected tab remain consistent.

### Phase 5 - Dev-Only QA Mode

1. Add admin QA/mock mode.
   - Gate with both:
     - explicit env var
     - `?qa=1`
   - Implement at the admin API client boundary, not inside page components.
   - Production builds must not activate mocks without the env var.

2. Mock scenarios.
   - Dashboard: empty store, active store, trend data, error.
   - Orders: dense rows, long emails, pre-orders, pagination, empty, error.
   - Products: images/no images, long names, draft/active, empty, error.
   - Inventory: low stock, stock edits, long SKUs, empty, error.
   - Staff: existing permissions, pending invites, read-only user.
   - Reports: real series, zero series, sparse series.
   - Detail pages: long data, no addresses/orders/images, mutation success/failure.

3. QA evidence checklist.
   - Desktop and mobile screenshots for:
     - Dashboard
     - Orders
     - Products
     - Inventory
     - Staff
     - Reports
     - OrderDetail
     - ProductDetail
     - CustomerDetail
   - Keyboard checks:
     - command palette
     - nav groups
     - action menus
     - mobile drawer
     - focus rings
     - Escape close behavior

## Success Metrics

- `pnpm verify` actually includes admin typecheck/build.
- Staff permission grants are never erased by simply opening/saving the UI.
- 90%+ of high-frequency mutations show clear success/failure feedback.
- Command palette opens and executes a route/search result in under 2 keyboard actions after launch.
- Dashboard shows real 30-day trend context without fake deltas.
- Bulk fulfillment returns per-order outcomes and does not fail an entire batch for one bad order.
- QA mode can visually prove dense rows, wrapping, pagination, empty/loading/error states without writing real store data.

## Assumptions

- SellRight is the product codebase being validated and fixed.
- No store-specific catalog, customer, order, or production data should be added to SellRight.
- Work is local-first; deployment and server operations are outside this implementation plan.
- Recommended implementation order is Phase 1 first, then Phase 2, then Phase 3. Phase 4 and Phase 5 can follow once the core correctness and UX foundation is stable.
