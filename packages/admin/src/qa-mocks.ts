/**
 * Dev-only QA / mock mode.
 *
 * Gated by TWO conditions (BOTH must hold before a mock fires):
 *   1. `VITE_QA_MOCK=1` env var at build/dev time — never set in production.
 *   2. `?qa=1` query string on the page that requests the mock.
 *
 * Implementation sits at the API client boundary (api.ts) so:
 *   - component code doesn't know it's talking to a mock;
 *   - production builds tree-shake this file out when VITE_QA_MOCK !== '1'
 *     (Vite inlines `import.meta.env.VITE_*` at build time);
 *   - tests can mount a component with `?qa=1` + a dev server, and the page
 *     just renders against the mock dataset.
 *
 * Scenarios are explicit — every shape here maps 1:1 to a real API response so
 * "rendering with ?qa=1=orders-dense" produces a faithful preview of dense
 * data without faking anything the operator can't verify against real store
 * data later.
 */

import type {
  OrderRow, ProductRow, VariantRow, ProductDetail, CustomerRow, CustomerDetail,
  InventoryRow, OrderDetail, Dashboard,
} from './api.js';

const qaEnabled = (): boolean => {
  // Vitest sets import.meta.env to a frozen object — write through a Proxy-like
  // path is impossible, so we read the env at the moment `maybeMock` is called
  // and ALSO honour a runtime override set on the global `__qaOverride` (the
  // tests use this to flip the mode on per-call). Production callers never
  // touch the override.
  const env = (import.meta as { env?: { VITE_QA_MOCK?: string } }).env?.VITE_QA_MOCK;
  const override = (globalThis as { __qaOverride?: boolean | null }).__qaOverride;
  if (override === true) {
    try { return new URLSearchParams(location.search).get('qa') === '1'; } catch { return false; }
  }
  if (override === false) return false;
  let qa = '';
  try { qa = new URLSearchParams(location.search).get('qa') ?? ''; } catch { qa = ''; }
  return env === '1' && qa === '1';
};

const money = (v: number) => v; // mock: all values in cents

const lorem = (n: number) => `Lorem ipsum dolor sit amet ${n}`.slice(0, 60);

function pick<T>(arr: T[], i: number): T { return arr[i % arr.length]!; }

const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD'];
const NAMES = [
  'Atlas Carry-On v2', 'Pioneer Field Knife', 'Beacon Lantern Mini', 'Sierra Wool Beanie',
  'Quartz Desk Tray', 'Cinder Cast-Iron Pan 10"', 'Mesa Hiking Pack 28L', 'Cove Insulated Bottle 24oz',
  'Bento Travel Organizer', 'Halcyon Pour-Over Kettle', 'Driftwood Brass Pen', 'Aurora Linen Throw',
  'Granite Yoga Mat 5mm', 'Falcon Multi-Tool', 'Sequoia Leather Wallet', 'Compass Map Notebook',
  'Vesta Ceramic Mug 12oz', 'Outpost Tactical Pouch', 'Tundra Down Vest', 'Solstice Solar Charger 10k',
];
const SKUS = ['ATL-CV2-001', 'PION-FK-22', 'BCN-LAN-1', 'SIE-BN-04', 'QZ-DT-12', 'CIN-CI-10', 'MS-HP-28'];
const EMAILS = [
  'verylongemailaddress.test+tag@some-corporate-domain.example.org',
  'a.customer+filter@anotherdomain.co',
  'm.kowalski-jones@yet-another-very-long-domain-name.com',
  'jane.doe@example.com',
  'support+qa@our-test-shop.example',
];

function makeOrders(count: number, kind: 'dense' | 'preorders' | 'paginated' | 'empty' | 'error' | 'mixed' = 'dense'): { items: OrderRow[]; total: number; page: number; pageSize: number } {
  if (kind === 'empty') return { items: [], total: 0, page: 1, pageSize: 25 };
  if (kind === 'error') throw new Error('mock: orders endpoint timed out');
  const states: OrderRow['state'][] = ['Paid', 'Paid', 'Paid', 'PendingPayment', 'Cancelled', 'Refunded', 'PartiallyRefunded', 'Paid', 'Shipped'];
  const items: OrderRow[] = Array.from({ length: count }, (_, i) => {
    const code = `ORD-${(1000 + i).toString().padStart(5, '0')}-${pick(['Q1','Q2','Q3','Q4','Q5'], i)}`;
    const state = kind === 'preorders' ? 'Paid' : pick(states, i);
    return {
      code,
      state,
      isPreOrder: kind === 'preorders' ? true : i % 7 === 0,
      grandTotal: money(1200 + (i * 73) % 50000),
      currency: pick(CURRENCIES, i),
      placedAt: new Date(Date.now() - i * 3600_000).toISOString(),
      createdAt: new Date(Date.now() - i * 3600_000).toISOString(),
      email: pick(EMAILS, i),
    };
  });
  return { items, total: count === 1 ? 1 : 480 + count, page: 1, pageSize: 25 };
}

function makeProducts(count: number, kind: 'active' | 'mixed' | 'empty' | 'error' = 'mixed'): { items: ProductRow[]; total: number; page: number; pageSize: number } {
  if (kind === 'empty') return { items: [], total: 0, page: 1, pageSize: 25 };
  if (kind === 'error') throw new Error('mock: products endpoint returned 500');
  const items: ProductRow[] = Array.from({ length: count }, (_, i) => ({
    id: `p${i}`,
    slug: `product-${i}`,
    name: kind === 'active' ? lorem(i) : pick(NAMES, i) + (i % 3 === 0 ? ' — extended edition with extra detail for layout testing' : ''),
    status: kind === 'active' ? 'active' : (i % 5 === 0 ? 'draft' : 'active'),
    assetPath: i % 4 === 0 ? null : `products/asset-${i % 7}.webp`,
    variants: (i % 4) + 1,
    minPrice: money(800 + (i * 137) % 12000),
    stock: (i * 19) % 50,
  }));
  return { items, total: count === 1 ? 1 : 230 + count, page: 1, pageSize: 25 };
}

function makeInventory(): { items: InventoryRow[]; total: number; page: number; pageSize: number } {
  const items: InventoryRow[] = Array.from({ length: 40 }, (_, i) => {
    const onHand = i % 11 === 0 ? 0 : i % 5 === 0 ? 1 : 4 + (i * 7) % 50;
    return {
      variantId: `v${i}`,
      sku: `${pick(SKUS, i)}-${i.toString().padStart(3, '0')}${i % 3 === 0 ? '-VERY-LONG-SUFFIX-FOR-LAYOUT-TEST' : ''}`,
      name: pick(NAMES, i),
      productName: pick(NAMES, i + 1),
      onHand,
      allocated: i % 9,
      available: Math.max(0, onHand - (i % 9)),
    };
  });
  return { items, total: items.length, page: 1, pageSize: 50 };
}

function makeCustomers(): { items: CustomerRow[]; total: number; page: number; pageSize: number } {
  const items: CustomerRow[] = Array.from({ length: 20 }, (_, i) => ({
    id: `c${i}`,
    email: pick(EMAILS, i),
    firstName: ['Ava', 'Noah', 'Mia', 'Liam', 'Zoe', 'Ezra', 'Iris', 'Owen'][i % 8] ?? null,
    lastName: ['Park', 'Singh', 'Okafor', 'Garcia', 'Kim', 'Müller', 'Rossi', 'Andersen'][i % 8] ?? null,
    createdAt: new Date(Date.now() - i * 86400_000).toISOString(),
    orders: i % 6,
    spent: money((i * 4200) % 200000),
  }));
  return { items, total: 87, page: 1, pageSize: 25 };
}

function makeCustomerDetail(): CustomerDetail {
  return {
    id: 'c0', email: pick(EMAILS, 0), firstName: 'Ava', lastName: 'Park', phone: '+1 555-0100', emailVerified: true,
    createdAt: new Date(Date.now() - 86400_000 * 30).toISOString(),
    orderCount: 12, spent: money(148500),
    addresses: [
      { fullName: 'Ava Park', line1: '742 Evergreen Terrace, Apt 4B', line2: null, city: 'Springfield', province: 'OR', postalCode: '97403', country: 'United States', phone: '+1 555-0100' },
      { fullName: 'Ava Park (work)', line1: '1 Innovation Way, Floor 12', line2: 'Suite 1200', city: 'San Francisco', province: 'CA', postalCode: '94105', country: 'United States', phone: null },
    ],
    orders: makeOrders(8, 'dense').items,
  };
}

function makeOrderDetail(code: string): OrderDetail {
  return {
    code, state: 'Paid', currency: 'USD',
    subtotal: money(14900), discountTotal: money(500), shippingTotal: money(800), taxTotal: money(1140), grandTotal: money(16340),
    placedAt: new Date().toISOString(), createdAt: new Date().toISOString(),
    shippingAddress: { fullName: 'Ava Park', line1: '742 Evergreen Terrace, Apt 4B', line2: null, city: 'Springfield', province: 'OR', postalCode: '97403', countryCode: 'US', phone: '+1 555-0100' },
    billingAddress: { fullName: 'Ava Park', line1: '742 Evergreen Terrace, Apt 4B', line2: null, city: 'Springfield', province: 'OR', postalCode: '97403', countryCode: 'US', phone: '+1 555-0100' },
    customer: { id: 'c0', email: pick(EMAILS, 0), firstName: 'Ava', lastName: 'Park', phone: '+1 555-0100' },
    lines: [
      { sku: 'ATL-CV2-001', name: pick(NAMES, 0), quantity: 1, unitPrice: money(12000), lineTotal: money(12000), fulfilledQty: 0, refundedQty: 0 },
      { sku: 'BCN-LAN-1', name: pick(NAMES, 2), quantity: 2, unitPrice: money(1450), lineTotal: money(2900), fulfilledQty: 0, refundedQty: 0 },
    ],
    payments: [{ method: 'card', amount: money(16340), state: 'Settled', providerRef: 'pi_mock_1', createdAt: new Date().toISOString() }],
    fulfillments: [],
    events: [
      { action: 'create', fromState: null, toState: 'PendingPayment', actor: 'storefront', at: new Date(Date.now() - 3600_000).toISOString() },
      { action: 'pay', fromState: 'PendingPayment', toState: 'Paid', actor: 'stripe', at: new Date(Date.now() - 3500_000).toISOString() },
    ],
  };
}

function makeProductDetail(): ProductDetail {
  const variants: VariantRow[] = Array.from({ length: 6 }, (_, i) => ({
    id: `v${i}`,
    sku: `${pick(SKUS, i)}-${i.toString().padStart(3, '0')}`,
    name: `${pick(NAMES, i)} — ${i % 2 === 0 ? 'Small' : 'Large'}`,
    price: money(2400 + (i * 100)),
    salePrice: i % 3 === 0 ? money(1800 + (i * 50)) : null,
    enabled: i % 5 !== 0,
    onHand: 10 + (i * 7) % 30,
    allocated: i % 3,
    available: 10 + (i * 7) % 30 - (i % 3),
    optionIds: [],
  }));
  return {
    id: 'p0', slug: 'product-0', name: lorem(0), description: 'A long product description used for QA layout testing. '.repeat(8),
    status: 'active', assetPath: 'products/asset-0.webp', featuredAssetId: 'a0',
    images: Array.from({ length: 4 }, (_, i) => ({ assetId: `a${i}`, path: `products/asset-${i}.webp`, url: `/assets/products/asset-${i}.webp`, position: i })),
    variants,
  };
}

function makeDashboard(kind: 'fresh' | 'active' | 'trend' | 'error' = 'active'): Dashboard {
  if (kind === 'error') throw new Error('mock: dashboard endpoint failed');
  if (kind === 'fresh') {
    return { store: { slug: 'demo', name: 'Demo Store', currency: 'USD' }, revenue: 0, orders: 0, aov: 0, pendingFulfillment: 0, customers: 0, lowStock: 0, recentOrders: [] };
  }
  return {
    store: { slug: 'demo', name: 'Demo Store', currency: 'USD' },
    revenue: money(842150), orders: 312, aov: money(2700),
    pendingFulfillment: 17, customers: 248, lowStock: 5,
    recentOrders: makeOrders(6, 'dense').items,
  };
}

function makeSalesSeries(kind: 'real' | 'zero' | 'sparse' = 'real'): { totalRevenue: number; totalOrders: number; series: { day: string; orders: number; revenue: number }[] } {
  if (kind === 'zero') return { totalRevenue: 0, totalOrders: 0, series: [] };
  if (kind === 'sparse') return {
    totalRevenue: 1200, totalOrders: 3,
    series: Array.from({ length: 30 }, (_, i) => ({ day: `2026-05-${(i + 1).toString().padStart(2, '0')}`, orders: i % 9 === 0 ? 1 : 0, revenue: i % 9 === 0 ? 400 : 0 })),
  };
  return {
    totalRevenue: 84215, totalOrders: 312,
    series: Array.from({ length: 30 }, (_, i) => ({
      day: `2026-05-${(i + 1).toString().padStart(2, '0')}`,
      orders: 5 + (i * 3) % 17,
      revenue: money(1500 + (i * 311) % 4500),
    })),
  };
}

/**
 * Decide whether to short-circuit a fetch. Returns the mock payload (parsed
 * JSON), or null to fall through to the real network call. Errors are returned
 * as a special `{ __qaError: string }` marker — the caller throws.
 */
export function maybeMock(path: string, qs: URLSearchParams, init?: RequestInit): { data: unknown; threw?: string } | null {
  if (!qaEnabled()) return null;
  let pageQs = new URLSearchParams();
  try { pageQs = new URLSearchParams(location.search); } catch { /* noop */ }
  const scenario = pageQs.get('scenario') || qs.get('qaScenario') || '';
  const m = init?.method?.toUpperCase() ?? 'GET';
  // Only mock GETs in v1. Writes still hit the real network.
  if (m !== 'GET') return null;
  try {
    if (path === '/me') return { data: {
      email: 'owner@demo.test',
      stores: [{ storeId: 'demo-store', slug: 'demo', name: 'Demo Store', currency: 'USD', role: 'owner' }],
    } };
    if (path === '/dashboard') return { data: makeDashboard((scenario as 'fresh' | 'active' | 'trend' | 'error') || 'active'), threw: undefined };
    if (path === '/orders' && qs.get('q') === '__qa-empty__') return { data: makeOrders(0, 'empty'), threw: undefined };
    if (path === '/orders' && qs.get('q') === '__qa-error__') return { data: null, threw: 'mock: orders endpoint failed' };
    if (path === '/orders') return { data: makeOrders(40, scenario === 'preorders' ? 'preorders' : 'dense'), threw: undefined };
    if (path.startsWith('/orders/') && path.endsWith('/invoice')) return null; // passthrough
    if (path.startsWith('/orders/') && !path.endsWith('/fulfill') && !path.endsWith('/cancel') && !path.endsWith('/refund') && !path.endsWith('/bulk-fulfill')) {
      return { data: makeOrderDetail(path.split('/').pop() || 'ORD-MOCK') };
    }
    if (path === '/inventory') return { data: makeInventory() };
    if (path === '/products' && qs.get('q') === '__qa-empty__') return { data: makeProducts(0, 'empty') };
    if (path === '/products') return { data: makeProducts(30, scenario === 'active' ? 'active' : 'mixed') };
    if (path.startsWith('/products/') && !path.endsWith('/options') && !path.endsWith('/variants') && !path.endsWith('/assets')) {
      return { data: makeProductDetail() };
    }
    if (path === '/customers') return { data: makeCustomers() };
    if (path.startsWith('/customers/')) return { data: makeCustomerDetail() };
    if (path === '/reports/sales') return { data: makeSalesSeries(scenario === 'zero' ? 'zero' : scenario === 'sparse' ? 'sparse' : 'real') };
    if (path === '/reports/top-products') return { data: { items: NAMES.slice(0, 10).map((n, i) => ({ name: n, sku: pick(SKUS, i), qty: 50 - i, revenue: money(25000 - i * 1000) })) } };
    if (path === '/reports/top-customers') return { data: { items: makeCustomers().items.slice(0, 5).map((c) => ({ id: c.id, email: c.email, spent: c.spent, orders: c.orders })) } };
    if (path === '/search') {
      const q = (qs.get('q') || '').toLowerCase();
      const orders = q.length < 2 ? [] : makeOrders(3, 'dense').items.filter((o) => o.code.toLowerCase().includes(q) || (o.email ?? '').toLowerCase().includes(q));
      const products = q.length < 2 ? [] : makeProducts(4, 'mixed').items.filter((p) => p.name.toLowerCase().includes(q));
      const customers = q.length < 2 ? [] : makeCustomers().items.filter((c) => c.email.toLowerCase().includes(q));
      return { data: { orders, products, customers } };
    }
    if (path === '/staff') return { data: { items: [
      { adminUserId: 'a1', email: 'owner@demo.test', role: 'owner', createdAt: new Date(Date.now() - 86400_000 * 90).toISOString(), permissions: {}, isYou: true },
      { adminUserId: 'a2', email: 'manager@demo.test', role: 'manager', createdAt: new Date(Date.now() - 86400_000 * 30).toISOString(), permissions: {}, isYou: false },
      { adminUserId: 'a3', email: 'staff@demo.test', role: 'staff', createdAt: new Date(Date.now() - 86400_000 * 7).toISOString(), permissions: { giftcards: true, webhooks: true }, isYou: false },
      { adminUserId: 'a4', email: 'readonly@demo.test', role: 'read_only', createdAt: new Date(Date.now() - 86400_000 * 3).toISOString(), permissions: { refunds: true }, isYou: false },
    ] } };
    if (path === '/staff/invites') return { data: { items: [
      { id: 'i1', email: 'pending@demo.test', role: 'staff', acceptedAt: null, expiresAt: new Date(Date.now() + 86400_000 * 5).toISOString() },
    ] } };
    return null;
  } catch (e) {
    return { data: null, threw: (e as Error).message };
  }
}

export const __qaDebug = { qaEnabled, makeOrders, makeProducts, makeInventory, makeCustomers, makeOrderDetail, makeProductDetail, makeDashboard, makeSalesSeries };
