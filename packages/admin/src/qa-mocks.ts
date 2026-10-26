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
      { id: 'l0', sku: 'ATL-CV2-001', name: pick(NAMES, 0), quantity: 1, unitPrice: money(12000), lineTotal: money(12000), fulfilledQty: 0, cancelledQty: 0, refundedQty: 0 },
      { id: 'l1', sku: 'BCN-LAN-1', name: pick(NAMES, 2), quantity: 2, unitPrice: money(1450), lineTotal: money(2900), fulfilledQty: 0, cancelledQty: 0, refundedQty: 0 },
    ],
    payments: [{ id: 'pay0', method: 'card', amount: money(16340), state: 'Settled', providerRef: 'pi_mock_1', createdAt: new Date().toISOString() }],
    fulfillments: [],
    refunds: [],
    locations: [],
    events: [
      { id: 'e0', action: 'create', fromState: null, toState: 'PendingPayment', actor: 'storefront', at: new Date(Date.now() - 3600_000).toISOString() },
      { id: 'e1', action: 'pay', fromState: 'PendingPayment', toState: 'Paid', actor: 'stripe', at: new Date(Date.now() - 3500_000).toISOString() },
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
    return { store: { slug: 'demo', name: 'Demo Store', currency: 'USD', published: true }, revenue: 0, orders: 0, aov: 0, pendingFulfillment: 0, customers: 0, lowStock: 0, recentOrders: [] };
  }
  return {
    store: { slug: 'demo', name: 'Demo Store', currency: 'USD', published: true },
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
  // Only GETs and the read-only dry-run POST (api.ts READ_ONLY_POSTS). Writes still hit the real network.
  if (m !== 'GET' && !(m === 'POST' && path === '/import-tracking/preview')) return null;
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
    // #380 fulfilment pages: open orders for Manual; the dry run of the real Avid sample (one Amazon order, left out),
    // the response the API returns for it (admin-order-ops.parity.db.test.ts).
    if (path === '/fulfillment/open-orders') return { data: { total: 4, items: [
      { code: 'DD30362', placedAt: '2026-10-24T15:02:00Z', isPreOrder: false, email: 'jordan@example.com', name: 'Jordan Lee', state: 'Paid', country: 'US', fulfillmentStatus: 'unfulfilled', items: [], shippedTracking: [] },
      { code: 'DD30364', placedAt: '2026-10-25T09:41:00Z', isPreOrder: false, email: 'sam@example.com', name: 'Sam Rivera', state: 'Paid', country: 'US', fulfillmentStatus: 'partially_fulfilled', items: [], shippedTracking: [] },
      { code: 'DD30366', placedAt: '2026-10-25T18:20:00Z', isPreOrder: true, email: 'alex@example.com', name: 'Alex Chen', state: 'Paid', country: 'CA', fulfillmentStatus: 'unfulfilled', items: [], shippedTracking: [] },
      { code: 'DD30367', placedAt: '2026-10-26T11:05:00Z', isPreOrder: false, email: 'casey@example.com', name: null, state: 'Paid', country: 'US', fulfillmentStatus: 'unfulfilled', items: [], shippedTracking: [] },
    ] } };
    // #382-#396 audit screens (synthetic data, shapes per the API routes).
    if (path === '/account-credit') return { data: { items: [
      { id: 'ac-1', code: 'ACC-7QK2M', email: 'jordan@example.com', currency: 'USD', initialAmount: 5000, balance: 3899, held: 0, available: 3899, disabled: false, createdAt: '2026-09-14T10:02:00Z' },
      { id: 'ac-2', code: 'ACC-R4T8W', email: 'sam.rivera@example.com', currency: 'USD', initialAmount: 2500, balance: 2500, held: 1200, available: 1300, disabled: false, createdAt: '2026-10-02T16:40:00Z' },
      { id: 'ac-3', code: 'ACC-9HZ3P', email: 'alex.chen@example.com', currency: 'USD', initialAmount: 10000, balance: 0, held: 0, available: 0, disabled: true, createdAt: '2026-08-21T08:15:00Z' },
    ] } };
    if (path.startsWith('/account-credit/')) return { data: {
      account: { id: 'ac-1', code: 'ACC-7QK2M', email: 'jordan@example.com', currency: 'USD', initialAmount: 5000, balance: 3899, held: 0, available: 3899, disabled: false, createdAt: '2026-09-14T10:02:00Z' },
      ledger: [
        { id: 'l3', kind: 'ADJUST', status: 'POSTED', amount: 500, delta: 500, balanceAfter: 3899, reason: 'Goodwill for late shipment', actor: 'owner@demo.test', orderCode: null, createdAt: '2026-10-20T12:00:00Z' },
        { id: 'l2', kind: 'REDEEM', status: 'POSTED', amount: 1601, delta: -1601, balanceAfter: 3399, reason: null, actor: null, orderCode: 'DD30331', createdAt: '2026-10-05T09:30:00Z' },
        { id: 'l1', kind: 'ISSUE', status: 'POSTED', amount: 5000, delta: 5000, balanceAfter: 5000, reason: 'Warranty replacement credit', actor: 'owner@demo.test', orderCode: null, createdAt: '2026-09-14T10:02:00Z' },
      ],
      redeemedOrders: [{ orderId: 'o-1', orderCode: 'DD30331', lines: [
        { id: 'ol-1', name: 'Pioneer Field Knife — Black', quantity: 1, unitCreditCents: [1201] },
        { id: 'ol-2', name: 'Leather Sheath', quantity: 2, unitCreditCents: [200, 200] },
      ] }],
    } };
    if (path === '/stock/tree') return { data: { total: 3, truncated: false, items: [
      { id: 'p1', name: 'Pioneer Field Knife', enabled: true, variants: [
        { id: 'v1', name: 'Black / M390', sku: 'PION-FK-BLK', enabled: true, onHand: 14, allocated: 2 },
        { id: 'v2', name: 'Stonewash / M390', sku: 'PION-FK-SW', enabled: true, onHand: 0, allocated: 0 },
        { id: 'v3', name: 'Damascus', sku: 'PION-FK-DAM', enabled: false, onHand: 3, allocated: 1 },
      ] },
      { id: 'p2', name: 'Falcon Multi-Tool', enabled: true, variants: [{ id: 'v4', name: 'Default', sku: 'FALC-MT-1', enabled: true, onHand: 42, allocated: 5 }] },
      { id: 'p3', name: 'Sierra Wool Beanie', enabled: true, variants: [
        { id: 'v5', name: 'Charcoal', sku: 'SIE-BN-CH', enabled: true, onHand: 8, allocated: 0 },
        { id: 'v6', name: 'Oat', sku: 'SIE-BN-OT', enabled: true, onHand: 1, allocated: 1 },
      ] },
    ] } };
    if (path === '/sheerid/config') return { data: { storeId: '048dc9af-0000-4000-8000-000000000000', configured: true, programId: '64f0c1e2a5b7d90012ab34cd', theme: null, hasWebhookSecret: true, hasClientCredentials: true, verificationTtlDays: 365 } };
    if (path === '/affiliates') return { data: { commissionPct: 10, items: [
      { id: 'af-1', email: 'creator.one@example.com', code: 'BLADEWORKS', status: 'Active', earned: 48250, settled: 30000, unsettled: 18250, orders: 37, lastSettledAt: '2026-09-30T00:00:00Z' },
      { id: 'af-2', email: 'edc.reviews@example.com', code: 'EDCREV10', status: 'Active', earned: 12900, settled: 0, unsettled: 12900, orders: 11, lastSettledAt: null },
      { id: 'af-3', email: 'old.partner@example.com', code: 'SUMMER24', status: 'Disabled', earned: 5400, settled: 5400, unsettled: 0, orders: 6, lastSettledAt: '2026-06-30T00:00:00Z' },
    ] } };
    if (/^\/affiliates\/[^/]+\/stats$/.test(path)) return { data: { range: { from: null, to: null }, commissionPct: 10,
      totals: { orders: 30, units: 34, revenue: 499860, commission: 49986 },
      bySku: [
        { sku: 'PION-FK-BLK', name: 'Pioneer Field Knife — Black', units: 21, orders: 19, revenue: 418950, commission: 41895 },
        { sku: 'FALC-MT-1', name: 'Falcon Multi-Tool', units: 9, orders: 8, revenue: 80910, commission: 8091 },
      ] } };
    if (/^\/affiliates\/[^/]+$/.test(path)) return { data: {
      id: 'af-1', email: 'creator.one@example.com', code: 'BLADEWORKS', status: 'Active', accessToken: 'tok_demo_0000', commissionPct: 10,
      earned: 48250, settled: 30000, unsettled: 18250,
      topSellers: [
        { name: 'Pioneer Field Knife', sku: 'PION-FK-BLK', qtySold: 21, revenue: 418950 },
        { name: 'Falcon Multi-Tool', sku: 'FALC-MT-1', qtySold: 9, revenue: 80910 },
      ],
      orders: [
        { code: 'DD30340', state: 'Paid', subtotal: 19950, discountTotal: 1995, basis: 17955, commission: 1796, placedAt: '2026-10-22T14:10:00Z', createdAt: '2026-10-22T14:08:00Z' },
        { code: 'DD30318', state: 'Paid', subtotal: 8990, discountTotal: 899, basis: 8091, commission: 809, placedAt: '2026-10-12T09:44:00Z', createdAt: '2026-10-12T09:40:00Z' },
      ],
      settlements: [{ amountCents: 30000, periodStartAt: '2026-09-01T00:00:00Z', periodEndAt: '2026-09-30T23:59:59Z', settledAt: '2026-10-01T10:00:00Z', txRef: 'PAYPAL-8XK21', notes: 'September payout' }],
    } };
    if (path === '/blog') return { data: { items: [
      { id: 'b1', title: 'Choosing a steel: M390 vs S35VN', slug: 'm390-vs-s35vn', isPublished: true, publishDate: '2026-10-18T09:00:00Z', authorName: 'Damned Designs', readingTime: 6, tags: ['steel', 'guides'], createdAt: '2026-10-17T15:00:00Z' },
      { id: 'b2', title: 'Sharpening at home', slug: 'sharpening-at-home', isPublished: false, publishDate: null, authorName: 'Workshop Team', readingTime: 4, tags: ['care'], createdAt: '2026-10-24T11:00:00Z' },
    ] } };
    if (path.startsWith('/blog/')) return { data: {
      id: 'b1', title: 'Choosing a steel: M390 vs S35VN', slug: 'm390-vs-s35vn', excerpt: 'Edge retention, toughness and corrosion resistance, side by side.',
      body: null,
      bodyHtml: '<h2>Why steel matters</h2><p>Two of our most asked-about steels are <strong>M390</strong> and <em>S35VN</em>. Here is how they compare.</p>'
        + '<ul><li><strong>Edge retention:</strong> M390 holds longer.</li><li><strong>Toughness:</strong> S35VN chips less.</li><li><strong>Sharpening:</strong> S35VN is easier.</li></ul>'
        + '<blockquote><p>Pick the steel for the work, not the spec sheet.</p></blockquote>'
        + '<h3>Care tips</h3><ol><li>Wipe dry after use.</li><li>Strop often.</li></ol>'
        + '<p>Read our <a href="https://example.com/care">care guide</a> or run <code>hone --angle 20</code> on a guided sharpener.</p>'
        + '<p><img src="https://placehold.co/640x320/png" alt="Blade close-up"></p>',
      authorName: 'Damned Designs', tags: ['steel', 'guides'], isPublished: true, publishDate: '2026-10-18T09:00:00Z',
      seoTitle: 'M390 vs S35VN — which knife steel?', seoDescription: 'Edge retention, toughness and care for two premium knife steels.',
      featuredAssetId: null, featuredAssetPath: null, seoRevision: 'rev-1',
    } };
    if (path === '/discounts') return { data: { items: [
      { id: 'd1', code: 'HEROES15', type: 'percentage', value: 15, enabled: true, usedCount: 128, usageLimit: null, perCustomerUsageLimit: 1, startsAt: null, endsAt: null, freeShipping: false },
      { id: 'd2', code: 'BLADEWORKS', type: 'percentage', value: 10, enabled: true, usedCount: 37, usageLimit: null, perCustomerUsageLimit: null, startsAt: null, endsAt: null, freeShipping: false },
      { id: 'd3', code: 'FALL25', type: 'fixed', value: 2500, enabled: false, usedCount: 4, usageLimit: 100, perCustomerUsageLimit: 1, startsAt: '2026-09-01T00:00:00Z', endsAt: '2026-11-30T23:59:59Z', freeShipping: true },
    ] } };
    if (path.startsWith('/discounts/')) {
      const id = path.split('/').pop();
      const base = id === 'd2'
        ? { id: 'd2', code: 'BLADEWORKS', type: 'percentage', value: 10, enabled: true, usedCount: 37, usageLimit: null, perCustomerUsageLimit: null, conditions: [], priority: 0, exclusionGroup: null, affiliateEmail: 'creator.one@example.com' }
        : { id: 'd1', code: 'HEROES15', type: 'percentage', value: 15, enabled: true, usedCount: 128, usageLimit: null, perCustomerUsageLimit: 1,
            conditions: [{ code: 'verified_customer', args: [{ name: 'categories', value: '["military","first_responder","teacher"]' }] }, { code: 'minimum_order_amount', args: [{ name: 'amount', value: '5000' }] }],
            priority: 20, exclusionGroup: 'verified', affiliateEmail: null };
      return { data: { ...base, startsAt: null, endsAt: null, freeShipping: false, usage: [
        { orderCode: 'DD30341', email: 'jordan@example.com', at: '2026-10-23T10:00:00Z' },
        { orderCode: 'DD30329', email: 'sam.rivera@example.com', at: '2026-10-15T18:22:00Z' },
      ] } };
    }
    if (path === '/collections') return { data: { items: [{ id: 'c1', name: 'Fixed blades' }, { id: 'c2', name: 'Folders' }] } };
    if (path === '/seo/config') return { data: {
      siteUrl: 'https://www.damneddesigns.com', indexNowKey: 'demo-indexnow-key', indexNowConfigured: true,
      organization: { name: 'Damned Designs', logo: 'https://www.damneddesigns.com/logo.png', sameAs: ['https://www.instagram.com/example'],
        image: 'https://www.damneddesigns.com/og.jpg', description: 'Knives and blade tools in M390, S35VN and 14C28N.', telephone: '+1-555-0100',
        founder: { name: 'Founder Name', id: null }, address: { streetAddress: '100 Example St', addressLocality: 'Austin', addressRegion: 'TX', postalCode: '78701', addressCountry: 'US' } },
      searchPath: '/search?q={search_term_string}',
      shipping: { rate: '0', country: 'US', handling: { min: 0, max: 1 }, transit: { min: 2, max: 5 } },
      returns: { days: 30, country: 'US', fees: 'customer' },
    } };
    if (path === '/seo/sitemaps') return { data: { configured: true, siteUrl: 'https://www.damneddesigns.com', indexUrl: 'https://www.damneddesigns.com/sitemap.xml', totalUrls: 214,
      indexNowConfigured: true, cloudflareConfigured: true, files: [
        { name: 'sitemap-products.xml', url: 'https://www.damneddesigns.com/sitemap-products.xml', kind: 'products', count: 180, urls: [], truncated: false },
        { name: 'sitemap-blog.xml', url: 'https://www.damneddesigns.com/sitemap-blog.xml', kind: 'blog', count: 22, urls: [], truncated: false },
      ] } };
    // #381 Order Export page: the count, this admin's saved settings and presets, and the download result.
    if (path === '/order-export/count') return { data: { totalOrders: qs.get('statuses') ? Math.min(qs.get('statuses')!.split(',').length, 5) + 3 : 0 } };
    if (path === '/preferences/order-export.last') return { data: { key: 'order-export.last', value: null } };
    if (path === '/preferences/order-export.presets') return { data: { key: 'order-export.presets', value: [{ name: 'Avid picking list', settings: { statuses: ['Processing', 'Pre-ordered', 'PartiallyShipped'], rows: 'line', format: 'xlsx' } }] } };
    if (path === '/order-export') return { data: { filename: `orders_export_${new Date().toISOString().slice(0, 10)}.${qs.get('format') === 'csv' ? 'csv' : 'xlsx'}`, orders: 8, rows: 11 } };
    if (path === '/import-tracking/recent') return { data: { items: [
      { id: 'r1', at: '2026-10-24T16:10:00Z', actor: 'adrian@example.com', source: 'csv', fileName: 'ProductShipmentDatasheet_1024.csv', total: 14, shipped: 12, skipped: 2, emailsQueued: 12, notify: true },
      { id: 'r2', at: '2026-10-23T15:42:00Z', actor: 'adrian@example.com', source: 'grid', fileName: null, total: 3, shipped: 3, skipped: 0, emailsQueued: 3, notify: true },
    ] } };
    if (path === '/import-tracking/preview' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body ?? '{}')) as { rows?: Array<{ code: string; tracking: string; carrier?: string | null }> };
      if (body.rows?.length) return { data: { summary: { total: body.rows.length, importable: body.rows.length, byStatus: {} }, parse: null,
        rows: body.rows.map((r, index) => ({ index, code: r.code, tracking: r.tracking, carrier: r.carrier ?? null, carrierSource: r.carrier ? 'given' : 'unknown', status: 'ready', message: 'ships the remaining items', items: [], customerEmail: 'x@example.com' })) } };
      return { data: { rows: [], summary: { total: 0, importable: 0, byStatus: {} }, parse: {
        titleSkipped: true, header: ['Owner', 'OrderId'], columns: { order: 'OrderId', tracking: 'shpack_trackingid', carrier: null },
        skipped: { blank: 0, amazon: 1, duplicate: 0 },
        skippedRows: [{ line: 3, code: '111-0237367-7778662', tracking: '9400150106151447202527', reason: 'amazon' }],
      } } };
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
