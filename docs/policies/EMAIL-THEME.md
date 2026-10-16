# Email theme tokens and mailer sender fallback

Status: implemented on `feat/defork-email-theme` (plan 3.8). Owner visual approval is required before any store relies on a non-default theme.

## Theme tokens

Resolved per store by `resolveEmailTheme(store.config)` in `packages/api/src/email/theme.ts`. Source: the existing `store.config` jsonb, key `emailTheme`. No migration.

```json
{
  "emailTheme": {
    "fontFamily": "Georgia, serif",
    "logoUrl": "https://cdn.example.com/logo.png",
    "footerText": "Example Shop",
    "colors": {
      "text": "#222", "muted": "#666", "footer": "#888", "rule": "#eee",
      "button": "#222", "buttonText": "#fff", "surface": "#f6f6f6"
    }
  }
}
```

All keys are optional. Engine defaults are the values the templates hard-coded before tokenisation.

Validation, per key (an invalid key falls back to its default; nothing else is affected):

- colours: `#rgb` or `#rrggbb` only
- `fontFamily`: `[A-Za-z0-9 ,'-]`, max 200 chars
- `logoUrl`: parseable `http(s)` URL, no whitespace, max 2048 chars; rendered only when valid
- `footerText`: non-empty, max 120 chars, no CR/LF; replaces the footer line and the text signature. Default is the store name.

Values are also HTML-attribute-escaped at render, so admin-entered config cannot inject markup or CSS.

## Where tokens apply

- `layout.ts` `renderEmailShell` is the single shell used by `templates.ts`, `templates-ops.ts` and `templates-contact.ts`. It replaces three duplicated `wrap` helpers.
- Body colours in all three template files read `colorsOf(store)`.
- `StoreCtx.theme` is optional. Omitted means engine defaults.
- `dispatch.ts` `emailCtx` fills `theme` from `store.config` for every enqueue/send path.

## Golden guarantee

A store with no `emailTheme` renders byte-identical output. `templates.golden.test.ts` compares `orderConfirmation` and `passwordReset` against `packages/api/src/email/golden/default-theme.golden.json`. That fixture was captured from the pre-change engine.

## Mailer sender fallback

`mailer.ts` built the message as `{ from, ...input }`. A caller passing `from: undefined` (key present) overwrote the resolved sender, and the message went out without a usable From. The fix is `{ ...input, from }`, so the resolved sender always wins. Regression test: `mailer.test.ts` "uses the resolved SMTP_FROM when the caller passes from: undefined" (fails on the old order).

The forbidden-sender-domain check (`FORBIDDEN_SENDER_DOMAINS`) was already generic in `sender-policy.ts` and is unchanged.

## Not in scope

- The fork's branded template redesign (different layout, button and key-box markup, merged subscriber templates) is not ported. It would change output for stores with no override, so it needs its own visual approval.
- Per-app theme overrides (`*_BY_APP` env maps). Only per-store config is supported.
