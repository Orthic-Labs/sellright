/**
 * Perf plan P6 (lane L5) unit coverage: due filtering before limits (D7),
 * stable/rotating reservation sweep (D8), retry backoff (D9), lock-free
 * auto-deliver dry run (D10), per-batch birthday transactions (D6).
 * No database: withStore is mocked and SQL is rendered with PgDialect.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const dialect = new PgDialect();
const h = vi.hoisted(() => ({
  sql: [] as Array<{ text: string; params: unknown[] }>,
  rows: [] as unknown[][],
  transactions: 0,
  birthdayBatches: [] as Array<string | null>,
}));
const render = (q: SQL) => { const r = dialect.sqlToQuery(q); h.sql.push({ text: r.sql, params: r.params }); return r; };

vi.mock('../db/client.js', () => {
  // A drizzle-ish builder: records where/orderBy/limit SQL and resolves to the next queued rows.
  const builder = (): unknown => {
    const parts: string[] = [];
    const params: unknown[] = [];
    const add = (frag: unknown) => {
      if (frag && typeof frag === 'object' && 'getSQL' in (frag as object)) {
        const r = dialect.sqlToQuery((frag as { getSQL(): SQL }).getSQL()); parts.push(r.sql); params.push(...r.params);
      } else if (typeof frag === 'number') parts.push(`limit ${frag}`);
    };
    const proxy: unknown = new Proxy({}, {
      get(_t, prop) {
        if (prop === 'then') {
          h.sql.push({ text: parts.join(' | '), params });
          const rows = h.rows.shift() ?? [];
          return (res: (v: unknown) => void) => res(rows);
        }
        return (...args: unknown[]) => { for (const a of args) add(a); return proxy; };
      },
    });
    return proxy;
  };
  const tx = {
    select: () => builder(), update: () => builder(), insert: () => builder(),
    execute: async (q: SQL) => { render(q); return { rows: h.rows.shift() ?? [] }; },
  };
  return {
    pool: { query: async () => ({ rows: [{ id: 'store-1', slug: 's', config: null }] }) },
    withStore: async (_id: string, fn: (t: unknown) => unknown) => { h.transactions++; return fn(tx); },
    withAdvisoryLock: async (_k: string, fn: () => unknown) => fn(),
    currentLeaseSignal: () => undefined,
  };
});
vi.mock('../db/locks.js', async (original) => ({ ...await original<typeof import('../db/locks.js')>(), withLockedSet: async () => ({ released: 0, deferred: 0 }) }));
vi.mock('../payments/reservation.js', () => ({ releaseOnFullRefundOrDefer: vi.fn(), settleRelease: vi.fn() }));
vi.mock('../payments/stripe-reconcile.js', () => ({ stripeDiscoverable: async () => false }));
vi.mock('../payments/gateway-payment.js', () => ({ verifyGatewayAttempt: vi.fn(), finishAttempt: vi.fn(), verifySezzleAttempt: vi.fn() }));
vi.mock('../payments/sezzle-reconcile.js', () => ({ resolveSezzleSessionAttempt: vi.fn(), reconcileSezzleRefunds: vi.fn(), observeImportedSezzlePayment: vi.fn() }));
vi.mock('../loyalty/bonus.js', () => ({
  grantBirthdayBonusBatch: async (_tx: unknown, _s: string, _now: Date, after: string | null) => {
    h.birthdayBatches.push(after);
    const next = after === null ? 'c-100' : after === 'c-100' ? 'c-200' : null;
    return { granted: 1, next };
  },
}));

import { recoverGatewayAttempts, RECOVERY_BATCH_LIMIT } from './gateway-recovery.js';
import { reservationReleaseSweep, resetReservationSweepCursor } from './reservation-release-sweep.js';
import { gatewayEventRetryDelayMs, reconcileGatewayEvents, MANUAL_AFTER_ATTEMPTS } from './reconcile-gateway-events.js';
import { listmonkRetryDelayMs } from './listmonk-sync.js';
import { autoDeliverStore } from './auto-deliver.js';
import { birthdayBonusSweep } from './birthday-bonus.js';

beforeEach(() => { h.sql = []; h.rows = []; h.transactions = 0; h.birthdayBatches = []; });

describe('D7 gateway recovery: due filter before the limit', () => {
  it('filters backing-off attempts in SQL, orders by due time/age/id, then limits', async () => {
    const now = new Date('2026-10-30T12:00:00.000Z');
    await recoverGatewayAttempts({ apply: false, ageMin: 15, sezzleSessionExpiryMin: 180, maxAttempts: 10, backoffBaseMin: 5, now });
    const q = h.sql[0]!;
    expect(q.text).toMatch(/coalesce\("payment_attempt"\."context"->'recovery'->>'nextAt', ''\) <= \$\d+/);
    expect(q.params).toContain(now.toISOString());
    expect(q.text).toMatch(/"payment_attempt"\."(created_at|createdAt)" asc.*"payment_attempt"\."id" asc/);
    expect(q.text).toContain(`limit ${RECOVERY_BATCH_LIMIT}`);
  });
});

describe('D8 reservation sweep: stable order + rotation', () => {
  beforeEach(() => resetReservationSweepCursor());
  it('orders by order_id, skips non-actionable rows in SQL and resumes after the last examined order', async () => {
    h.rows = [[{ id: 'a' }, { id: 'b' }]];
    await reservationReleaseSweep({ batchLimit: 2 });
    expect(h.sql[0]!.text).toMatch(/ORDER BY r\.order_id/);
    expect(h.sql[0]!.text).toMatch(/r\.state = 'consumed' AND o\.state = 'Refunded'/);
    expect(h.sql[0]!.text).toMatch(/financialReconciliationV1/);
    expect(h.sql[0]!.params).toContain(null); // first pass starts from the beginning
    h.sql = [];
    h.rows = [[{ id: 'c' }], [{ id: 'a' }, { id: 'b' }]];
    await reservationReleaseSweep({ batchLimit: 2 });
    expect(h.sql[0]!.params).toContain('b'); // resumes after the cursor
    expect(h.sql[1]!.params).toContain(null); // wraps around to fill the window
  });
});

describe('D9 retry fairness', () => {
  it('gateway events: due filter in SQL, stable order, 30th failed attempt goes manual', async () => {
    await reconcileGatewayEvents();
    expect(h.sql[0]!.text).toMatch(/"(updated_at|updatedAt)" <= now\(\) - least\(/);
    expect(h.sql[0]!.text).toMatch(/"gateway_event"\."(updated_at|updatedAt)" asc.*"gateway_event"\."id" asc/);
    expect(MANUAL_AFTER_ATTEMPTS).toBe(30);
    expect([0, 1, 2, 3, 4, 5, 20].map(gatewayEventRetryDelayMs)).toEqual([0, 60_000, 120_000, 240_000, 480_000, 900_000, 900_000]);
  });
  it('listmonk: exponential per-row backoff capped at 6h', () => {
    expect([1, 2, 3].map(listmonkRetryDelayMs)).toEqual([300_000, 600_000, 1_200_000]);
    expect(listmonkRetryDelayMs(50)).toBe(6 * 3_600_000);
  });
});

describe('D10 auto-deliver dry run takes no row locks', () => {
  it('omits FOR UPDATE in dry-run and keeps SKIP LOCKED for apply', async () => {
    await autoDeliverStore('store-1', { apply: false, days: 10 });
    expect(h.sql[0]!.text).not.toMatch(/FOR UPDATE/);
    expect(h.sql[0]!.text).toMatch(/ORDER BY shipped_at, o\.id/);
    h.sql = [];
    await autoDeliverStore('store-1', { apply: true, days: 10 });
    expect(h.sql[0]!.text).toMatch(/FOR UPDATE OF o SKIP LOCKED/);
  });
});

describe('D6 birthday sweep: one transaction per batch', () => {
  it('commits each batch separately and follows the keyset cursor', async () => {
    expect(await birthdayBonusSweep({ now: new Date('2026-10-30T00:00:00Z') })).toEqual({ granted: 3 });
    expect(h.birthdayBatches).toEqual([null, 'c-100', 'c-200']);
    expect(h.transactions).toBe(3);
  });
});
