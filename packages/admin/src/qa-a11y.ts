/**
 * QA-only a11y helper (ra-014). Side-effect import: when the admin boots in
 * `--mode qa`, this file is imported and exposes `window.__runA11yAudit()` so
 * a human in devtools (or a future Playwright/automation suite) can run an
 * axe-core pass against the live rendered DOM without rebuilding.
 *
 * Why a runtime side-effect, not a test:
 *   - The admin's `test` script runs against jsdom (vitest config) which
 *     doesn't exercise real layout / focus / ARIA trees — the things axe
 *     actually checks.
 *   - Spinning up a full Playwright suite is its own infrastructure decision
 *     (which runner? where do the snapshots live? what about CI?).
 *   - This file gets us 80% of the value: axe is loaded in the same JS
 *     context as the real app, attached to window, and callable from the
 *     browser console. The same call is also the seam a Playwright test
 *     would target (page.evaluate(() => window.__runA11yAudit())).
 *
 * Usage (manual):
 *   1. pnpm --filter @sellright/admin qa:browser
 *   2. Open http://127.0.0.1:4300/, log in, navigate to the page under test.
 *   3. In devtools console: await __runA11yAudit() — returns a structured
 *      object, also logs a human summary with violation counts per rule.
 *
 * Usage (future automation):
 *   await page.evaluate(() => window.__runA11yAudit())
 *   // assert no 'critical' / 'serious' violations, fail the test if any.
 */
import axe, { type Result, type RunOptions } from 'axe-core';

declare global {
  interface Window {
    __runA11yAudit: (selector?: string) => Promise<{
      url: string;
      violations: Result[];
      passes: number;
      incomplete: number;
      inapplicable: number;
    }>;
    __axe: typeof axe;
  }
}

const VIOLATION_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] as const;
const RULES_TO_OMIT: string[] = [
  // color-contrast is noisy against the in-app preview tokens (focus rings
  // can hit sub-3:1 on the QA surface if the design tokens are mid-iteration).
  // It's still WCAG-relevant — flip this off once the tokens are stable.
  'color-contrast',
];

const runOptions: RunOptions = {
  runOnly: { type: 'tag', values: [...VIOLATION_TAGS] },
  rules: Object.fromEntries(RULES_TO_OMIT.map((id) => [id, { enabled: false }])),
};

function summarize(results: Result[]): string {
  if (results.length === 0) return 'no violations';
  const byImpact: Record<string, number> = {};
  for (const v of results) byImpact[v.impact ?? 'minor'] = (byImpact[v.impact ?? 'minor'] ?? 0) + v.nodes.length;
  return Object.entries(byImpact)
    .sort((a, b) => b[1] - a[1])
    .map(([impact, n]) => `${n} ${impact}`)
    .join(', ');
}

window.__axe = axe;
window.__runA11yAudit = async (selector?: string) => {
  const context = selector ? { include: [selector] } : document;
  const results = await axe.run(context, runOptions);
  const summary = summarize(results.violations);
  // eslint-disable-next-line no-console
  console.info(
    `[a11y] ${location.pathname} — ${results.violations.length} rule violation(s), ${results.passes.length} passes, ${results.incomplete.length} needs-review, ${results.inapplicable.length} n/a. ${summary}`,
  );
  for (const v of results.violations) {
    // eslint-disable-next-line no-console
    console.groupCollapsed(`[a11y][${v.impact}] ${v.id} — ${v.help} (${v.nodes.length} node${v.nodes.length === 1 ? '' : 's'})`);
    // eslint-disable-next-line no-console
    console.info(v.helpUrl);
    for (const n of v.nodes.slice(0, 3)) {
      // eslint-disable-next-line no-console
      console.info(n.target, n.failureSummary);
    }
    if (v.nodes.length > 3) {
      // eslint-disable-next-line no-console
      console.info(`…and ${v.nodes.length - 3} more`);
    }
    // eslint-disable-next-line no-console
    console.groupEnd();
  }
  return {
    url: location.href,
    violations: results.violations,
    passes: results.passes.length,
    incomplete: results.incomplete.length,
    inapplicable: results.inapplicable.length,
  };
};

// Surface that the audit is loaded so a Playwright suite can wait for it.
window.dispatchEvent(new CustomEvent('a11y:ready'));
