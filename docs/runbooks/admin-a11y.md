# Admin a11y runbook (ra-014)

The admin boots a runtime axe-core pass in QA mode. This file is the operator
manual for that pass.

## How it works

`packages/admin/src/qa-a11y.ts` is a side-effect import that only loads when
the admin boots with `import.meta.env.MODE === 'qa'`. It attaches two globals:

- `window.__axe` — the raw axe-core API
- `window.__runA11yAudit(selector?)` — convenience wrapper that runs the WCAG
  2.0/2.1 A+AA + best-practice ruleset against the current document (or a CSS
  selector), logs a per-rule summary to the console, and returns a structured
  result.

In `main.tsx`:

```ts
if (import.meta.env.MODE === 'qa') {
  void import('./qa-a11y.js');
}
```

Vite statically eliminates the import in production builds (the `MODE` check
is a string literal), so the helper never ships to real users.

## Manual workflow (today)

```bash
# 1. Start the admin in QA mode
pnpm --filter @sellright/admin qa:browser
# → http://127.0.0.1:4300/

# 2. Log in (qa-mocks give a fake admin), navigate to the page under test.

# 3. In devtools console:
await __runA11yAudit()

# 4. Read the result:
#  - log: "[a11y] /products — N rule violation(s), M passes, K needs-review, J n/a. <impact breakdown>"
#  - groups: one collapsed group per violated rule, with up to 3 node targets
#    + a link to the rule docs
#  - return value: { url, violations[], passes, incomplete, inapplicable }
```

To scope the audit (e.g. only the orders table):

```js
await __runA11yAudit('[data-testid="orders-table"]')
```

## Automated workflow (follow-up)

The same `__runA11yAudit` is the seam a Playwright suite targets. Sketch:

```ts
// packages/admin/qa/a11y.test.ts (future)
test('home has no critical a11y violations', async ({ page }) => {
  await page.goto('http://127.0.0.1:4300/')
  await page.waitForEvent('a11y:ready')   // dispatched by qa-a11y.ts
  const result = await page.evaluate(() => window.__runA11yAudit())
  const critical = result.violations.filter(v => v.impact === 'critical')
  expect(critical).toEqual([])
})
```

The Playwright runner + snapshot directory are separate infrastructure
decisions (where do violations live? HTML report or just JSON? which CI step
runs them?). Land that as a dedicated PR — this runbook only assumes the
contract `window.__runA11yAudit()` is stable.

## What this catches (and doesn't)

Catches: WCAG 2.0/2.1 A+AA misses, missing aria-labels, broken heading
order, missing form labels, color contrast (omitted by default — see below),
focus-trap issues on dialogs, missing alt text.

Doesn't catch: keyboard-only flows (axe can't drive a keyboard), screen-reader
output (needs NVDA/VoiceOver), responsive layout breakage (use the visual
audit). Pair with `qa:browser` and a manual sweep before release.

## Omitted rules

- `color-contrast` — the QA mode boots against the in-app design tokens, not
  the final store theme. Token-driven contrast shifts can produce noisy
  violations mid-iteration. Flip the omission off in `qa-a11y.ts` once the
  design system is frozen.

## When you find a violation

1. Check the `helpUrl` in the rule's log group — axe links to the WCAG spec
   + remediation guidance.
2. Fix at the source. Most are component-level (missing `aria-label`,
   `<button>` without text, `<img>` without alt) and live in
   `packages/admin/src/components/**`.
3. If a violation is in a 3rd-party lib, the fix is to wrap the component
   in `packages/admin/src/components/` (a small `<Foo>` that adds the
   missing attrs) rather than patching the dep.
4. Re-run the audit to confirm.

## Threshold for blocking a release

Currently informational — the manual workflow is a check, not a gate. Once
the Playwright suite is in place, the recommended gate is:

| Impact   | Blocks release? |
| -------- | --------------- |
| critical | yes             |
| serious  | yes             |
| moderate | no (file issue) |
| minor    | no              |
