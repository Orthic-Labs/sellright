/**
 * Deterministic baseline for the admin suite, written entirely through the real admin API
 * (products, variants + stock, shipping methods) on top of the migrations + bootstrap that
 * start-api.mjs already applied. Orders / customers / staff are NOT pre-seeded here: each spec
 * arranges the rows it mutates (see createOrder & friends in api.ts) so specs stay independent
 * and a trash/cancel/ship in one never changes the expectations of another.
 *
 * Idempotent: re-running against a seeded DB is a no-op (SKU / code lookups first).
 */
import { AdminApi, SKU, SHIPPING } from './api';

interface SeedVariant { sku: string; name: string; price: number; onHand: number }
interface SeedProduct { name: string; slug: string; variants: SeedVariant[] }

export const CATALOG: SeedProduct[] = [
  { name: 'E2E Tee', slug: 'e2e-tee', variants: [{ sku: SKU.tee, name: 'E2E Tee / M', price: 2500, onHand: 500 }] },
  { name: 'E2E Mug', slug: 'e2e-mug', variants: [{ sku: SKU.mug, name: 'E2E Mug', price: 1200, onHand: 500 }] },
  // Available (on hand - allocated) <= 3 is the Inventory page's "low stock" definition.
  { name: 'E2E Low Stock Cap', slug: 'e2e-low-cap', variants: [{ sku: SKU.low, name: 'E2E Cap', price: 1800, onHand: 2 }] },
  { name: 'E2E Sold Out Poster', slug: 'e2e-oos-poster', variants: [{ sku: SKU.oos, name: 'E2E Poster', price: 900, onHand: 0 }] },
];

export async function seedBaseline(api: AdminApi): Promise<void> {
  const existing = new Set((await api.get<{ items: { sku: string }[] }>('/inventory?pageSize=100')).items.map((i) => i.sku));
  for (const p of CATALOG) {
    if (p.variants.every((v) => existing.has(v.sku))) continue;
    const { id } = await api.post<{ id: string }>('/products', { name: p.name, slug: p.slug, status: 'active' });
    for (const v of p.variants) await api.post(`/products/${id}/variants`, { sku: v.sku, name: v.name, price: v.price, onHand: v.onHand });
  }

  const methods = new Set((await api.get<{ items: { code: string }[] }>('/shipping-methods')).items.map((m) => m.code));
  if (!methods.has(SHIPPING.flat)) await api.post('/shipping-methods', { code: SHIPPING.flat, name: 'E2E Flat Rate', calculator: { flat: 500 }, enabled: true });
  if (!methods.has(SHIPPING.free)) await api.post('/shipping-methods', { code: SHIPPING.free, name: 'E2E Free Shipping', calculator: { flat: 0, min: 10000 }, enabled: true });
}
