# SellRight Admin — Design Uplift

> Applied via `/review-frontend` + `ui-ux-pro-max` + interaction-design principles. Status: **shared-layer changes implemented & build-verified; NOT committed** — pending Adrian's eyes (CLAUDE.md §8). Per-page items below are ready on approval.

## Honest starting assessment

The admin is **not** "pieced together" — it's a competent, Shopify-Polaris-inspired system: a real token layer (`card`/`btn`/`input`/table primitives), semantic status badges (emerald/amber/rose/blue with ring pills), shimmer skeletons, consistent focus rings, tabular numerals, designed empty states. Brand `#008060` is literally Shopify's green. The job here is **elevation, not rescue** — make it read *designed and confident* instead of *familiar/cloned*.

## What I changed (shared layer — propagates to every screen)

All in `packages/admin/{tailwind.config.js, src/index.css, src/components/ui.tsx}`:

| Change | Before | After | Why |
|---|---|---|---|
| **Elevation scale** | one ad-hoc `0 1px 2px` shadow | `shadow-{card,card-hover,popover,modal}` layered tiers | depth via consistent shadow tiers, not borders (the "designed" tell) |
| **Card depth** | flat border + tiny shadow | `shadow-card` + lighter border | surfaces lift off the canvas |
| **Liftable cards** | — | `.card-interactive` (hover lift + shadow) | affordance for clickable tiles |
| **Button press** | `transition-colors` only | `active:scale-[0.98]` + shadow, 150ms multi-prop transition | tactile feedback (scale-feedback rule) |
| **Primary button** | flat green | + soft brand-tinted shadow on hover | confident primary CTA |
| **Table density** | `py-3` rows | `py-2.5` rows | more rows per screen for power users |
| **Table header** | plain | faint `bg-gray-50/60` tint + wider tracking, 11px | header reads as chrome, data reads as figure |
| **Row hover** | faint `gray-50` | `gray-100/70`, distinct from brand-light **selected** | hover ≠ selected (fixes the review's faint-hover + state-collision risk) |
| **Page titles** | `text-xl` | `text-2xl tracking-tight text-balance` | confident, balanced headings |
| **Reduced motion** | none | `prefers-reduced-motion` guard neutralises transforms/anim | accessibility (the #1 gate) |

**Build:** `pnpm build` green (CSS 34→36 KB). **Evidence:** before `/.audit/shots/*.png` → after `/.audit/shots/v2/*.png`.

### Motion decisions (interaction-design)
- One **150ms** rhythm shared across hover/press/lift; transitions name exact properties (never `transition: all`).
- Press = `scale(0.98)` (within the 0.95–1.05 tactile band), restored on release, disabled on `:disabled`.
- Card lift = `-translate-y-px` + shadow step — spatial, not decorative.
- All gated behind `prefers-reduced-motion`.

## Recommended next — ready on your approval (per-page, so gated)

1. **P1 · Orders double filter row** — the status `Tabs` pills + the saved-views row show overlapping labels. Merge into one control, or relabel the views row "Views" + make it a quieter segmented control. (`pages/Orders.tsx`)
2. **Dashboard KPI tiles → `.card-interactive`** — they're already `<Link>`s; swap the hover-border for the lift affordance for a livelier, more tactile dashboard. (`pages/Dashboard.tsx`)
3. **Badge refinement** — add a small status **dot** before the label (e.g. ● Paid) so state is legible without relying on color alone (accessibility `color-not-only`) and reads more designed. (`components/ui.tsx` Badge)
4. **Real logo** — replace the green-square placeholder in the sidebar + login with the wordmark. (Right Suite identity is for the *RightApps* fork, not SellRight-the-product — keep SellRight brand-neutral.)
5. **Sidebar polish** — tighten section-label rhythm, add a subtle active-item left accent bar, denser group spacing.
6. **Settings/Marketing QA mocks** (from the frontend review F2) — add their scenarios to `qa-mocks.ts` so the config pages can be visually QA'd offline.
7. **Density toggle** (optional) — a comfortable/compact switch for tables, like Linear.

## What I deliberately did NOT do
- No wholesale palette change — Polaris-green is fine and familiar; swapping it would be churn, not improvement.
- No new font/display face — Inter is correct for a data-dense admin; a display face would fight the utility.
- No per-page restructuring without approval — the eyes-gate (CLAUDE.md §8) means you approve visual direction before it ships.

_None of this is committed. Approve the direction (or redirect) and I'll land the shared layer + chosen per-page items in one commit._
