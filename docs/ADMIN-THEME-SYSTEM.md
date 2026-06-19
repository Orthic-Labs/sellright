# SellRight Admin — Theme System

> Implemented via `/brand-identity` + `ui-ux-pro-max`. Status: **built & build-verified, NOT committed** — pending Adrian's eyes on the real renders. Default theme **Vermillion**; full switchable pool; new type system.

## What shipped

Replaced the Shopify-green clone with a **runtime-swappable, multi-theme, light/dark token system**.

- **4 themes**, each light + dark, all **WCAG AA verified** (real contrast calc in `.audit/themes/check.cjs`):
  - **Vermillion** (default) — warm paper / warm near-black + coral-vermillion `#CB3D14`/`#FF6242`
  - **Graphite** — cool neutral + iris `#5B5BD6`/`#7C7CF0`
  - **Porcelain** — clean white / true black + cobalt `#0B5FFF`/`#4D8DFF`
  - **Carbon** — warm dark-first + amber `#985C00`/`#F5A623`
- **Switcher** in the top bar (`ThemeMenu`): pick theme + Light/Dark/System. Persists to `localStorage`; a no-flash `<head>` script applies it before first paint.
- **New type system** (replaces Inter everywhere): **Schibsted Grotesk** (display/titles/KPIs) · **Hanken Grotesk** (UI/body, tabular) · **JetBrains Mono** (ids/money/data). All OFL/free, **self-hosted as variable WOFF2** (latin + latin-ext subsets, ~176 KB, loaded on demand) in `src/fonts/` + `src/fonts.css` — no CDN dependency. Regenerate with `.audit/themes/selfhost-fonts.cjs`.
- **Lucide icons** kept (modern, consistent 2px stroke — not the problem).
- **Status dots** added to badges (color + shape → color-blind safe), `prefers-reduced-motion` honored.
- **Always-dark shell:** the sidebar uses a dedicated `--shell-*` token set that is **dark in every theme and every mode** (constant, not overridden by `.dark`), so the content area always sits lighter above it — dramatic in light mode (dark rail + light canvas), subtle in dark. Active nav item = theme accent. All shell text/active pairs pass WCAG AA.
- **Op-cards fixed:** "To fulfill" / "Low stock" tiles now use `bg-{warning,danger}-soft` tokens (were hardcoded light tints → illegible light-on-light in dark mode).

## Architecture (how it works / how to extend)

- `src/theme-tokens.css` — **generated** by `.audit/themes/gen-tokens.cjs`. Per-theme CSS variables as **RGB channels** (`--accent: 203 61 20`) on `:root` / `[data-theme="x"]` / `.dark[data-theme="x"]`.
- `tailwind.config.js` — maps every token via `rgb(var(--x) / <alpha-value>)`, so opacity modifiers (`bg-accent/20`, `ring-accent/35`) work. The **`gray` scale is remapped to a per-theme neutral ramp that inverts in dark** — this is why existing `text-gray-500` / `border-gray-100` / `bg-gray-50` across 34 files re-theme with **zero component edits**. `brand` is repointed to the active accent (so all `bg-brand`/`text-brand`/`bg-brand-light` re-theme too).
- `src/theme.tsx` — `useTheme()` hook + `ThemeMenu` + `applyTheme()` (flips `data-theme` + `.dark` on `<html>`).
- **To add a theme:** add one entry to `THEMES` in `gen-tokens.cjs` (light + dark palette + neutral ramp), run it, add a row to `THEMES` in `theme.tsx`. Re-verify with `check.cjs`.

Files touched: `tailwind.config.js`, `src/index.css`, `src/theme-tokens.css` (new), `src/theme.tsx` (new), `src/components/ui.tsx` (badges/alerts/deltas/title), `src/components/Layout.tsx` (switcher), `src/pages/Dashboard.tsx` (op-card tints), `index.html` (no-flash init), + `bg-white`→`bg-surface` swap.

## Evidence (real admin, mock data)

`.audit/shots/v3/` — Vermillion light + dark, the open switcher, Porcelain light (cobalt), Graphite + Carbon dark. Build + typecheck green.

## Known follow-ups (small, not blocking)

1. **~10 hardcoded semantic tints** (`bg-red-50`, `bg-amber-50`, `bg-emerald-50`, `bg-amber-100`) in low-traffic pages will look slightly washed in dark — swap to `bg-{danger,warning,success}-soft`. (High-traffic surfaces already done.)
2. **Stray `text-white` on accent** in a few pages — fine in Vermillion (white on-accent) but should be `text-accent-on` for the light-accent dark themes (Graphite/Porcelain/Carbon dark).
3. ✅ ~~Self-host the fonts~~ — done (variable WOFF2, latin + latin-ext, in `src/fonts/`).
4. Optional: a density toggle; settings-page mirror of the theme picker.

## Not committed

This is a large visual change — it's staged for your approval on the real renders, not committed. On your go I'll land it (foundation + the follow-up sweep) in one commit and push.
