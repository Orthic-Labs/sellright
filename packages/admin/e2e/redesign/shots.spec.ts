/**
 * #406 screenshot sweep: every rebuilt screen at 1280 and 1440 in all four themes (light), plus dark at 1440.
 * Opt-in (RD_SHOTS=1) because it only produces review artefacts: e2e/.run/shots-406/<screen>-<theme>-<mode>-<w>.png.
 */
import { join } from 'node:path';
import { test } from '../fixtures';
import { RUN_DIR } from '../support/env.mjs';
import { seedRedesign } from './seed';

const THEMES = ['vermillion', 'graphite', 'porcelain', 'carbon'] as const;
const OUT = join(RUN_DIR, 'shots-406');

test.skip(!process.env.RD_SHOTS, 'screenshot sweep is opt-in (RD_SHOTS=1)');

test('redesign screenshot sweep', async ({ page, api }) => {
  test.setTimeout(600_000);
  const o = await seedRedesign(api);
  const products = await api.get<{ items: { id: string; name: string }[] }>('/products?pageSize=50');
  const product = products.items.find((p) => p.name === 'E2E Tee') ?? products.items[0]!;
  const screens: Array<[string, string]> = [
    ['orders', '/orders'],
    ['orders-all', '/orders?tab=all'],
    ['order-partial', `/orders/${o.partial}`],
    ['order-removed', `/orders/${o.removed}`],
    ['order-pre', `/orders/${o.pre}`],
    ['product', `/products/${product.id}`],
    ['payments', '/settings/payments'],
    ['discounts', '/discounts'],
  ];
  const only = process.env.RD_SCREENS?.split(',');
  for (const theme of THEMES) {
    for (const [mode, widths] of [['light', [1280, 1440]], ['dark', [1440]]] as const) {
      await page.addInitScript(([t, m]) => { localStorage.setItem('sr-theme', t); localStorage.setItem('sr-mode', m); }, [theme, mode]);
      for (const w of widths) {
        await page.setViewportSize({ width: w, height: 900 });
        for (const [name, url] of screens) {
          if (only && !only.includes(name)) continue;
          // The sidebar polls tab counts, so the network never idles; wait for the page instead.
          await page.goto(url, { waitUntil: 'domcontentloaded' });
          await page.locator('main').waitFor();
          await page.waitForTimeout(900);
          await page.screenshot({ path: join(OUT, `${name}-${theme}-${mode}-${w}.png`) });
        }
      }
    }
  }
});
