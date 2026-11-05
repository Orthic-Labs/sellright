/**
 * #406 screenshot sweep: every rebuilt screen at 1280 and 1440 in all four themes (light), plus dark at 1440.
 * Opt-in (RD_SHOTS=1) because it only produces review artefacts: e2e/.run/shots-406/<screen>-<theme>-<mode>-<w>.png.
 */
import { join } from 'node:path';
import { test } from '../fixtures';
import { RUN_DIR } from '../support/env.mjs';
import type { AdminApi } from '../support/api';
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

/** The views a review asked for that the page sweep can't reach by URL: dialogs, quick view, bulk bar, palette,
 *  a 9×6 grouped variant grid (Rotten Hand's shape) and the shared states. 1440, one theme light and dark. */
test('redesign interaction screenshot sweep', async ({ page, api }) => {
  test.setTimeout(600_000);
  const o = await seedRedesign(api);
  const grid = await seedGridProduct(api);
  const shot = (name: string, theme: string, mode: string) => page.screenshot({ path: join(OUT, `${name}-${theme}-${mode}-1440.png`) });
  const settle = async (url: string) => {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.locator('main').waitFor();
    await page.waitForTimeout(900);
  };
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const [theme, mode] of [['vermillion', 'light'], ['vermillion', 'dark'], ['carbon', 'dark']] as const) {
    await page.addInitScript(([t, m]) => { localStorage.setItem('sr-theme', t); localStorage.setItem('sr-mode', m); }, [theme, mode]);

    await settle('/orders?tab=all');
    await page.locator('tr[data-id]').first().focus();
    await page.keyboard.press('Enter');
    await page.getByRole('complementary', { name: 'Order quick view' }).waitFor();
    await page.waitForTimeout(600);
    await shot('quick-view', theme, mode);

    await settle('/orders?tab=all');
    for (const cb of (await page.getByRole('checkbox', { name: /^Select (?!all)/ }).all()).slice(0, 2)) await cb.check();
    await page.waitForTimeout(400);
    await shot('bulk-bar', theme, mode);

    await settle('/orders');
    await page.keyboard.press('Control+k');
    await page.getByRole('dialog', { name: 'Command palette' }).waitFor();
    await page.keyboard.type('ord');
    await page.waitForTimeout(400);
    await shot('palette', theme, mode);
    await page.keyboard.press('Escape');

    await settle(`/orders/${o.open}`);
    await page.getByRole('button', { name: /^Fulfil items/ }).first().click();
    await page.getByRole('dialog').waitFor();
    await page.waitForTimeout(400);
    await shot('dialog-fulfil', theme, mode);

    await settle(`/orders/${o.open}`);
    await page.getByRole('button', { name: /^Refund/ }).first().click();
    await page.getByRole('dialog').waitFor();
    await page.waitForTimeout(400);
    await shot('dialog-refund', theme, mode);

    await settle(`/orders/${o.open}`);
    await page.getByRole('button', { name: /More actions/ }).click();
    await page.getByRole('menuitem', { name: /^Cancel order/ }).click();
    await page.getByRole('dialog').waitFor();
    await page.waitForTimeout(400);
    await shot('dialog-cancel', theme, mode);

    await settle(`/products/${grid}`);
    await shot('product-grouped-9x6', theme, mode);

    // Shared states.
    await settle('/orders?tab=all&q=zz-no-such-order');
    await shot('state-filtered-empty', theme, mode);
    await page.route('**/v1/admin/orders?*', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"Internal error"}' }));
    await settle('/orders?tab=all');
    await page.waitForTimeout(1500);
    await shot('state-load-error', theme, mode);
    await page.unroute('**/v1/admin/orders?*');
    await page.route('**/v1/admin/orders?*', () => { /* never answers: the loading state */ });
    await page.goto('/orders?tab=all', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(700);
    await shot('state-loading', theme, mode);
    await page.unroute('**/v1/admin/orders?*');

    await settle(`/products/${grid}`);
    await page.route('**/v1/admin/products/*', (r) => r.request().method() === 'PATCH'
      ? r.fulfill({ status: 409, contentType: 'application/json', body: '{"error":"Product changed since you opened it"}' }) : r.continue());
    await page.locator('#pt').fill('E2E Grid Shirt (edited)');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await page.getByRole('button', { name: 'Keep mine' }).waitFor();
    await shot('state-conflict', theme, mode);
    await page.unroute('**/v1/admin/products/*');
    await page.route('**/v1/admin/products/*', (r) => r.request().method() === 'PATCH'
      ? r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"Internal error"}' }) : r.continue());
    await settle(`/products/${grid}`);
    await page.locator('#pt').fill('E2E Grid Shirt (edited)');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await page.waitForTimeout(1200);
    await shot('state-save-failed', theme, mode);
    await page.unroute('**/v1/admin/products/*');
  }
});

/** 9 colours × 6 sizes, like Rotten Hand's shirt: above the grouping threshold, so the editor groups by colour. */
async function seedGridProduct(api: AdminApi): Promise<string> {
  const found = await api.get<{ items: { id: string; name: string }[] }>(`/products?q=${encodeURIComponent('E2E Grid Shirt')}&pageSize=10`);
  const hit = found.items.find((p) => p.name === 'E2E Grid Shirt');
  if (hit) return hit.id;
  const colours = ['Hot Pink', 'Electric Blue', 'Blood Red', 'Deep Purple', 'Storm Grey', 'Cloud White', 'Midnight Black', 'Forest Green', 'Desert Yellow'];
  const sizes = ['XS', 'S', 'M', 'L', 'XL', 'XXL'];
  const { id } = await api.post<{ id: string }>('/products', { name: 'E2E Grid Shirt', slug: 'e2e-grid-shirt', status: 'active' });
  await api.post(`/products/${id}/option-groups`, { name: 'Colour', values: colours });
  await api.post(`/products/${id}/option-groups`, { name: 'Size', values: sizes });
  const { groups } = await api.get<{ groups: { name: string; options: { id: string; value: string }[] }[] }>(`/products/${id}/options`);
  const opt = (g: string, n: string) => groups.find((x) => x.name === g)!.options.find((x) => x.value === n)!.id;
  let i = 0;
  for (const c of colours) for (const s of sizes) {
    const v = await api.post<{ id: string }>(`/products/${id}/variants`, { sku: `E2E-GRID-${++i}`, name: `${c} / ${s}`, price: 7500, onHand: (i * 7) % 13 });
    await api.put(`/variants/${v.id}/options`, { optionIds: [opt('Colour', c), opt('Size', s)] });
  }
  return id;
}
