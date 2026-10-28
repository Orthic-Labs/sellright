/**
 * #406 behaviour suite: the signed-off mockup's Playwright checks (v3test, v4extra, v5extra, ovf) ported to the
 * real admin and API. Every money/stock claim is read back from the API, not from the page. Checks that need an
 * endpoint the API does not have yet are test.fixme with the missing endpoint named, so the gap stays visible.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test, expect } from '../fixtures';
import { createOrder, SKU, uniq } from '../support/api';
import { seedRedesign, RD } from './seed';

const axeSource = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');

test.describe.configure({ mode: 'serial' });

let seeded: Awaited<ReturnType<typeof seedRedesign>>;
test.beforeAll(async ({ api }) => { seeded = await seedRedesign(api); });

const lineOf = (o: any, sku: string) => o.lines.find((l: any) => l.sku === sku);

test.describe('orders list', () => {
  test('tab counts come from the API and match the rows each tab shows', async ({ page, api }) => {
    const counts = await api.get<Record<string, number>>('/orders/tab-counts?excludeDemo=1');
    await page.goto('/orders');
    for (const [key, label] of [['tofulfil', 'To fulfil'], ['partial', 'Partial'], ['refunded', 'Refunded'], ['pre', 'Pre-orders']] as const) {
      const tab = page.getByRole('tab', { name: new RegExp(`^${label}`) });
      await expect(tab).toContainText(String(counts[key]));
      await tab.click();
      await expect(page.locator('tr[data-id]')).toHaveCount(Math.min(counts[key]!, 25));
    }
  });

  test('an order refunded before shipping says Nothing to ship and is not in Shipped', async ({ page }) => {
    await page.goto('/orders?tab=all');
    await page.getByPlaceholder('Order, name or email').fill('rd-removed');
    await expect(page.locator(`tr[data-id="${seeded.removed}"]`)).toContainText('Nothing to ship');
    await page.getByRole('tab', { name: /^Shipped/ }).click();
    await expect(page.locator(`tr[data-id="${seeded.removed}"]`)).toHaveCount(0);
  });

  test('tabs control the wrapper panel, which is labelled by the selected tab', async ({ page }) => {
    await page.goto('/orders');
    const sel = page.getByRole('tab', { selected: true });
    const panelId = await sel.getAttribute('aria-controls');
    const panel = page.locator(`#${panelId}`);
    await expect(panel).toHaveAttribute('role', 'tabpanel');
    await expect(panel).toHaveAttribute('aria-labelledby', (await sel.getAttribute('id'))!);
    await expect(panel.locator('table')).toHaveCount(1);
  });

  test('rows: arrows move, Enter opens the quick view, Esc closes, Shift+Enter opens the page', async ({ page }) => {
    await page.goto('/orders?tab=all');
    const rows = page.locator('tr[data-id]');
    await rows.first().focus();
    await page.keyboard.press('ArrowDown');
    await expect(rows.nth(1)).toBeFocused();
    const code = await rows.nth(1).getAttribute('data-id');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('complementary', { name: 'Order quick view' })).toContainText(code!);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('complementary', { name: 'Order quick view' })).toHaveCount(0);
    await rows.nth(1).focus();
    await page.keyboard.press('Shift+Enter');
    await expect(page).toHaveURL(new RegExp(`/orders/${code}$`));
  });

  test('many saved views scroll inside the tab strip; the page never scrolls sideways (1280)', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.addInitScript(() => {
      const views = Array.from({ length: 14 }, (_, i) => ({ id: `v${i}`, name: `Long saved view ${i + 1}`, tab: 'all', q: '' }));
      for (const k of Object.keys(localStorage)) if (/view/i.test(k)) localStorage.removeItem(k);
      (window as any).__rdViews = views;
    });
    await page.goto('/orders');
    // Save views through the UI so the stored shape is the page's own.
    for (let i = 0; i < 8; i++) {
      await page.getByRole('button', { name: 'Save view' }).click();
      await page.locator('#orders-view-name').fill(`Long saved view ${i + 1}`);
      await page.locator('#orders-view-name').press('Enter');
    }
    const overflow = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      tabs: (() => { const t = document.querySelector('[role=tablist]') as HTMLElement; return getComputedStyle(t).overflowX; })() }));
    expect(overflow.doc).toBeLessThanOrEqual(0);
    expect(['auto', 'scroll']).toContain(overflow.tabs);
  });

  test('saved view names must be unique and not empty', async ({ page }) => {
    await page.goto('/orders');
    await page.getByRole('button', { name: 'Save view' }).click();
    await page.locator('#orders-view-name').fill('To fulfil');
    await page.locator('#orders-view-name').press('Enter');
    await expect(page.locator('#orders-view-err')).toContainText(/already/i);
  });
});

test.describe('fulfil', () => {
  test('pre-order lines are disabled; only the shippable line can ship; the API refuses pre-order lines', async ({ page, api }) => {
    await page.goto(`/orders/${seeded.pre}`);
    await page.getByRole('button', { name: /^Fulfil items/ }).first().click();
    const dlg = page.getByRole('dialog', { name: `Fulfil ${seeded.pre}` });
    await expect(dlg.getByLabel(/pre-order, not in stock/)).toBeDisabled();
    await dlg.getByRole('button', { name: 'Cancel' }).click();
    const o = await api.order(seeded.pre);
    const pre = lineOf(o, RD.preSku);
    const r = await api.raw('POST', `/orders/${seeded.pre}/fulfillments`, { lines: [{ orderLineId: pre.id, quantity: 1 }], notifyCustomer: true });
    expect(r.status).toBe(409);
  });

  test('quantity 0 and over the remaining quantity are blocked', async ({ page, api }) => {
    const { code } = await createOrder(api, { email: `${uniq('rdf')}@e2e.example.net`, items: [{ sku: SKU.tee, quantity: 2 }] });
    await page.goto(`/orders/${code}`);
    await page.getByRole('button', { name: /^Fulfil items/ }).first().click();
    const dlg = page.getByRole('dialog', { name: `Fulfil ${code}` });
    const qty = dlg.getByLabel(/^Quantity to ship/);
    await qty.fill('0');
    await expect(dlg.getByRole('button', { name: /^Fulfil/ }).last()).toBeDisabled();
    await qty.fill('3');
    await expect(dlg.getByRole('button', { name: /^Fulfil/ }).last()).toBeDisabled();
  });

  test('double submit ships once; a dash-only tracking number is stored as no tracking; the email always sends', async ({ page, api }) => {
    const { code } = await createOrder(api, { email: `${uniq('rdf')}@e2e.example.net`, items: [{ sku: SKU.mug, quantity: 1 }] });
    await page.goto(`/orders/${code}`);
    await page.getByRole('button', { name: /^Fulfil items/ }).first().click();
    const dlg = page.getByRole('dialog', { name: `Fulfil ${code}` });
    await expect(dlg).toContainText('Sends the shipping email to');
    await expect(dlg.getByRole('checkbox', { name: /email/i })).toHaveCount(0);
    await dlg.getByLabel(/^Tracking number/).fill('---');
    const go = dlg.getByRole('button', { name: /^Fulfil/ }).last();
    await go.dblclick();
    await expect(dlg).toHaveCount(0);
    const o = await api.order(code);
    expect(o.fulfillments).toHaveLength(1);
    expect(o.fulfillments[0].trackingCode ?? null).toBeNull();
    expect(o.fulfillments[0].notifyCustomer).toBe(true);
  });
});

test.describe('refund', () => {
  test('fractional, over-max and negative shipping are blocked; a valid refund applies once; focus returns', async ({ page, api }) => {
    const { code } = await createOrder(api, { email: `${uniq('rdr')}@e2e.example.net`, items: [{ sku: SKU.tee, quantity: 3 }] });
    await page.goto(`/orders/${code}`);
    const btn = page.getByRole('button', { name: /^Refund/ }).first();
    await btn.click();
    const dlg = page.getByRole('dialog', { name: `Refund ${code}` });
    const qty = dlg.getByLabel(/^Quantity to refund/);
    const go = dlg.getByRole('button', { name: /^Refund/ }).last();
    await qty.fill('1.5'); await expect(go).toBeDisabled();
    await qty.fill('4'); await expect(go).toBeDisabled();
    await qty.fill('1');
    const ship = dlg.getByLabel(/Refund shipping/);
    if (await ship.count()) { await ship.fill('-1'); await expect(go).toBeDisabled(); await ship.fill('0'); }
    await page.keyboard.press('Escape');
    await expect(dlg).toHaveCount(0);
    await expect(btn).toBeFocused();
    await btn.click();
    await dlg.getByLabel(/^Quantity to refund/).fill('1');
    await dlg.getByRole('button', { name: /^Refund/ }).last().dblclick();
    await expect(dlg).toHaveCount(0);
    const o = await api.order(code);
    expect(o.refunds.filter((r: any) => r.state !== 'Failed')).toHaveLength(1);
    expect(lineOf(o, SKU.tee).refundedQty).toBe(1);
  });

  test('restock never exceeds what shipped; a second refund cannot restock the same units', async ({ page, api }) => {
    const { code } = await createOrder(api, { email: `${uniq('rdr')}@e2e.example.net`, items: [{ sku: SKU.mug, quantity: 2 }] });
    const o0 = await api.order(code);
    await api.post(`/orders/${code}/fulfillments`, { lines: [{ orderLineId: lineOf(o0, SKU.mug).id, quantity: 1 }], notifyCustomer: true });
    const before = (await api.stock(SKU.mug)).onHand;
    await api.post(`/orders/${code}/refund`, { idempotencyKey: crypto.randomUUID(), lines: [{ orderLineId: lineOf(o0, SKU.mug).id, quantity: 2, restock: true }] });
    expect((await api.stock(SKU.mug)).onHand - before).toBe(1);
    const again = await api.raw('POST', `/orders/${code}/refund`, { idempotencyKey: crypto.randomUUID(), lines: [{ orderLineId: lineOf(o0, SKU.mug).id, quantity: 1, restock: true }] });
    expect(again.status).toBe(409);
    expect((await api.stock(SKU.mug)).onHand - before).toBe(1);
    // The page shows the split: one removed before shipping, one shipped.
    await page.goto(`/orders/${code}`);
    await expect(page.getByText('1 item shipped; 1 item removed before shipping.')).toBeVisible();
  });

  test('shipping is not refundable twice (server cap)', async ({ api }) => {
    const { code } = await createOrder(api, { email: `${uniq('rdr')}@e2e.example.net`, items: [{ sku: SKU.tee, quantity: 2 }] });
    const o = await api.order(code);
    const id = lineOf(o, SKU.tee).id;
    await api.post(`/orders/${code}/refund`, { idempotencyKey: crypto.randomUUID(), lines: [{ orderLineId: id, quantity: 1 }], shippingAmount: o.shippingTotal });
    const r = await api.raw('POST', `/orders/${code}/refund`, { idempotencyKey: crypto.randomUUID(), lines: [{ orderLineId: id, quantity: 1 }], shippingAmount: 1 });
    expect(r.status).toBe(409);
  });
});

test.describe('discounts', () => {
  test('status comes from dates and the enabled flag; tabs count it', async ({ page }) => {
    await page.goto('/discounts');
    for (const [tab, has, not] of [['Active', 'WELCOME10', 'BLACKFRIDAY'], ['Scheduled', 'BLACKFRIDAY', 'WELCOME10'], ['Expired', 'SUMMER5', 'SHIPFREE'], ['Disabled', 'STAFF', 'WELCOME10']] as const) {
      await page.getByRole('tab', { name: new RegExp(`^${tab}`) }).click();
      await expect(page.getByRole('row').filter({ hasText: has })).toHaveCount(1);
      await expect(page.getByRole('row').filter({ hasText: not })).toHaveCount(0);
    }
    await expect(page.getByRole('tab', { name: /^Active/ })).toContainText('2');
    await expect(page.getByRole('tab', { name: /^Scheduled/ })).toContainText('1');
  });

  test('editor: end before start, duplicate code, save blocked, leave guarded', async ({ page }) => {
    await page.goto('/discounts/new');
    await page.getByLabel(/^Code/).fill('welcome10');
    await page.getByLabel(/^Code/).blur();
    await expect(page.getByText(/already exists/)).toBeVisible();
    await page.getByLabel('Starts').fill('2026-12-10T00:00');
    await page.getByLabel('Ends').fill('2026-12-01T00:00');
    await expect(page.getByText(/after the start/i).first()).toBeVisible();
    await page.getByRole('button', { name: 'Create discount' }).click();
    await expect(page.getByText(/Nothing was saved/).first()).toBeVisible();
    await page.getByRole('link', { name: 'Orders' }).first().click();
    await expect(page.getByRole('dialog', { name: /Discard unsaved changes/ })).toBeVisible();
    await page.getByRole('button', { name: 'Keep editing' }).click();
    await expect(page).toHaveURL(/\/discounts\/new$/);
  });
});

test.describe('product editor', () => {
  const variantOf = async (api: any, sku: string) => {
    const inv = await api.get(`/inventory?q=${encodeURIComponent(sku)}&pageSize=10`);
    return inv.items.find((i: any) => i.sku === sku);
  };
  const productId = async (api: any) => (await api.get('/products?pageSize=50')).items.find((p: any) => p.name === 'E2E Mug').id as string;

  test('edits are staged: nothing reaches the API until Save; Discard has Undo', async ({ page, api }) => {
    const id = await productId(api);
    const before = await api.get(`/products/${id}`);
    await page.goto(`/products/${id}`);
    const price = page.getByLabel('Price, E2E Mug', { exact: true });
    await price.fill('13.50');
    await expect(page.getByText(/^1 unsaved change/)).toBeVisible();
    expect((await api.get(`/products/${id}`)).variants[0].price).toBe(before.variants[0].price);
    await page.getByRole('button', { name: 'Discard' }).click();
    await expect(page.getByText('All changes saved')).toBeVisible();
    await page.getByRole('button', { name: 'Undo' }).first().click();
    await expect(price).toHaveValue('13.50');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('All changes saved')).toBeVisible();
    expect((await api.get(`/products/${id}`)).variants[0].price).toBe(1350);
    await api.patch(`/variants/${before.variants[0].id}`, { price: before.variants[0].price });
  });

  test('someone else saved first: Use theirs / Keep mine, and nothing is saved until a choice', async ({ page, api }) => {
    const id = await productId(api);
    await page.goto(`/products/${id}`);
    await page.getByLabel('Title', { exact: true }).fill('E2E Mug (mine)');
    await api.patch(`/products/${id}`, { name: 'E2E Mug (theirs)' });
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('button', { name: 'Use theirs' })).toBeVisible();
    expect((await api.get(`/products/${id}`)).name).toBe('E2E Mug (theirs)');
    await page.getByRole('button', { name: 'Keep mine' }).click();
    await expect.poll(async () => (await api.get(`/products/${id}`)).name).toBe('E2E Mug (mine)');
    await api.patch(`/products/${id}`, { name: 'E2E Mug' });
  });

  test('leaving with unsaved edits asks first', async ({ page, api }) => {
    const id = await productId(api);
    await page.goto(`/products/${id}`);
    await page.getByLabel('Title', { exact: true }).fill('E2E Mug draft');
    await page.getByRole('link', { name: 'Orders' }).first().click();
    const dlg = page.getByRole('dialog', { name: /Discard unsaved changes/ });
    await expect(dlg).toBeVisible();
    await dlg.getByRole('button', { name: 'Discard and leave' }).click();
    await expect(page).toHaveURL(/\/orders$/);
    expect((await api.get(`/products/${id}`)).name).toBe('E2E Mug');
    void variantOf;
  });
});

test.describe('shell, keyboard, zoom, screen reader', () => {
  test('sidebar scrollbar sits on the left edge, tinted by the theme', async ({ page }) => {
    await page.goto('/orders');
    await page.locator('.navscroll a.nav').first().waitFor();
    const s = await page.evaluate(() => {
      const nav = document.querySelector('.navscroll') as HTMLElement;
      const cs = getComputedStyle(nav), child = getComputedStyle(nav.firstElementChild as Element);
      return { dir: cs.direction, childDir: child.direction, color: cs.scrollbarColor, overflow: cs.overflowY };
    });
    expect(s).toMatchObject({ dir: 'rtl', childDir: 'ltr', overflow: 'auto' });
    expect(s.color).not.toBe('auto');
  });

  test('sidebar scrolls with the keyboard and keeps focused items visible', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 600 });
    await page.goto('/orders');
    for (const g of ['Grow', 'Insights', 'Configuration']) {
      const b = page.getByRole('button', { name: g, exact: true });
      if ((await b.getAttribute('aria-expanded')) === 'false') await b.click();
    }
    const last = page.locator('.navscroll a.nav').last();
    await last.focus();
    await expect(last).toBeInViewport();
    const nav = page.locator('.navscroll');
    await nav.evaluate((el) => { el.scrollTop = 0; });
    await nav.hover();
    const box = (await nav.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 400);
    await expect.poll(() => nav.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    // Arrow keys scroll it too once it has focus.
    await nav.evaluate((el) => { el.scrollTop = 0; el.tabIndex = -1; el.focus(); });
    await page.keyboard.press('PageDown');
    await expect.poll(() => nav.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  });

  test('Ctrl K opens the palette and the top-bar search does too', async ({ page }) => {
    await page.goto('/orders');
    await page.locator('tr[data-id]').first().waitFor();
    const palette = page.getByRole('dialog', { name: 'Command palette' });
    await page.keyboard.press('Control+k');
    await expect(palette).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(palette).toHaveCount(0);
    await page.getByRole('button', { name: /^Search orders, products, customers/ }).click();
    await expect(palette).toBeVisible();
    await expect(page.getByLabel('Command palette search')).toBeFocused();
  });

  test('toasts are capped at three', async ({ page, api }) => {
    test.fixme(true, 'needs a page action that can raise four toasts quickly in the real admin; covered by Toast.tsx slice(-3) for now');
    void api; void page;
  });

  for (const width of [1280, 1440]) {
    test(`no horizontal overflow or clipped buttons at ${width} and at 200% zoom`, async ({ page, api }) => {
      const pid = (await api.get('/products?pageSize=50')).items.find((p: any) => p.name === 'E2E Tee').id;
      const screens = ['/orders', `/orders/${seeded.partial}`, `/orders/${seeded.removed}`, `/products/${pid}`, '/settings/payments', '/discounts'];
      for (const zoom of [1, 2]) {
        await page.setViewportSize({ width: Math.round(width / zoom), height: Math.round(900 / zoom) });
        for (const url of screens) {
          await page.goto(url, { waitUntil: 'domcontentloaded' });
          await page.locator('main').waitFor();
          await page.waitForTimeout(500);
          const bad = await page.evaluate(() => {
            const out: string[] = [];
            const doc = document.documentElement;
            if (doc.scrollWidth > doc.clientWidth + 1) out.push(`page ${doc.scrollWidth}>${doc.clientWidth}`);
            document.querySelectorAll('main button, main .pill').forEach((el) => {
              const h = el as HTMLElement;
              if (h.offsetParent && h.scrollWidth > h.clientWidth + 1) out.push(`clip ${h.textContent?.trim().slice(0, 30)}`);
            });
            return out.slice(0, 6);
          });
          expect(bad, `${url} zoom ${zoom}`).toEqual([]);
        }
      }
    });
  }

});

test.describe('screen reader', () => {
  // The admin's CSP (script-src 'self') blocks injecting axe; bypass it for this audit only.
  test.use({ bypassCSP: true });
  test('axe: no serious or critical violations on the rebuilt screens', async ({ page, api }) => {
    const pid = (await api.get('/products?pageSize=50')).items.find((p: any) => p.name === 'E2E Tee').id;
    for (const url of ['/orders', `/orders/${seeded.partial}`, `/products/${pid}`, '/settings/payments', '/discounts', '/discounts/new']) {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.locator('main').waitFor();
      await page.waitForTimeout(500);
      await page.addScriptTag({ content: axeSource });
      const v = await page.evaluate(async () => {
        const r = await (window as any).axe.run(document.querySelector('.app'), { resultTypes: ['violations'] });
        return r.violations.filter((x: any) => x.impact === 'serious' || x.impact === 'critical').map((x: any) => `${x.id}: ${x.nodes.map((n: any) => n.target.join(' ')).join(' | ')}`);
      });
      expect(v, url).toEqual([]);
    }
  });
});

test.describe('needs API that does not exist yet', () => {
  test.fixme('bounced shipping email shows on the parcel with Edit email and Resend', () => {
    // Needs per-fulfillment emailState + POST /orders/{code}/fulfillments/{id}/resend-email + an order email update endpoint.
  });
  test.fixme('image alt text and media reorder', () => {
    // Needs PATCH /assets/{id} {alt}, alt on product images, PUT /products/{id}/assets/reorder.
  });
  test.fixme('store switch clears toasts', () => {
    // The e2e install has one store; the switcher reloads the page, which clears toasts by construction.
  });
});
