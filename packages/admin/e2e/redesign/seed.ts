/**
 * #406 redesign fixtures: a small, realistic order mix for the rebuilt screens (to fulfil, partially shipped,
 * refunded before shipping, pre-order). Written through the real admin API; idempotent per DB via a marker email.
 */
import { AdminApi, createOrder, ensureCustomer, SKU } from '../support/api';
import { seedBaseline } from '../support/seed';

export const RD = { preSku: 'E2E-PRE-1', marker: 'rd-marker@e2e.example.net' } as const;

export async function seedRedesign(api: AdminApi): Promise<{ partial: string; removed: string; pre: string; open: string }> {
  const prior = await api.get<{ items: { code: string; email: string | null }[] }>(`/orders?q=${encodeURIComponent('rd-')}&pageSize=50`);
  const by = (p: string) => prior.items.find((o) => o.email?.startsWith(p))?.code;
  await seedBaseline(api);
  if (by('rd-marker')) return { partial: by('rd-partial')!, removed: by('rd-removed')!, pre: by('rd-pre')!, open: by('rd-open')! };

  const inv = await api.get<{ items: { sku: string }[] }>('/inventory?pageSize=100');
  if (!inv.items.some((i) => i.sku === RD.preSku)) {
    const { id } = await api.post<{ id: string }>('/products', { name: 'E2E Pre-order Knife', slug: 'e2e-pre-knife', status: 'active' });
    const v = await api.post<{ id: string }>(`/products/${id}/variants`, { sku: RD.preSku, name: 'E2E Pre-order Knife', price: 4000, onHand: 0 });
    await api.patch(`/variants/${v.id}`, { isPreOrder: true });
  }

  const open = await createOrder(api, { email: 'rd-open@e2e.example.net', items: [{ sku: SKU.tee, quantity: 2 }, { sku: SKU.mug, quantity: 1 }] });
  const partial = await createOrder(api, { email: 'rd-partial@e2e.example.net', items: [{ sku: SKU.tee, quantity: 4 }, { sku: SKU.mug, quantity: 1 }] });
  const pd = await api.get<{ lines: { id: string; sku?: string; variantSku?: string; quantity: number }[] }>(`/orders/${partial.code}`);
  const tee = pd.lines.find((l) => (l.variantSku ?? l.sku) === SKU.tee)!;
  await api.post(`/orders/${partial.code}/fulfillments`, { lines: [{ orderLineId: tee.id, quantity: 2 }], trackingCode: '9400111899223197428490', carrier: 'USPS', notifyCustomer: true });

  const removed = await createOrder(api, { email: 'rd-removed@e2e.example.net', items: [{ sku: SKU.mug, quantity: 2 }] });
  const rd = await api.get<{ lines: { id: string; quantity: number }[] }>(`/orders/${removed.code}`);
  await api.post(`/orders/${removed.code}/refund`, { idempotencyKey: crypto.randomUUID(), lines: rd.lines.map((l) => ({ orderLineId: l.id, quantity: l.quantity, restock: false })), reason: 'Customer changed their mind' });

  const pre = await createOrder(api, { email: 'rd-pre@e2e.example.net', items: [{ sku: RD.preSku, quantity: 1 }, { sku: SKU.tee, quantity: 1 }] });
  const day = 86_400_000, at = (d: number) => new Date(Date.now() + d * day).toISOString();
  for (const d of [
    { code: 'WELCOME10', type: 'percentage', value: 10, startsAt: at(-30), endsAt: null, usageLimit: 500 },
    { code: 'SHIPFREE', type: 'free_shipping', value: 0, startsAt: at(-5), endsAt: at(25) },
    { code: 'BLACKFRIDAY', type: 'percentage', value: 25, startsAt: at(28), endsAt: at(32) },
    { code: 'SUMMER5', type: 'fixed', value: 500, startsAt: at(-120), endsAt: at(-60) },
    { code: 'STAFF', type: 'percentage', value: 30, enabled: false },
  ]) await api.post('/discounts', d);
  await ensureCustomer(api, RD.marker);
  await createOrder(api, { email: RD.marker, items: [{ sku: SKU.mug, quantity: 1 }] });
  return { partial: partial.code, removed: removed.code, pre: pre.code, open: open.code };
}
