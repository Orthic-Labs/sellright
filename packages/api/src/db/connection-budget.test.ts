import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assertConnectionBudget, ConnectionBudgetError, connectionBudget, FIXED_POOL_MAX, poolMax } from './client.js';
import type { Env } from '../env.js';

// #360 N7: the per-process maximum counts every pool plus the tenant resolver, the webhook pass and the listener.
const env = (requests: number) => ({ PGPOOL_MAX: requests, PGJOBS_POOL_MAX: 8, PGLOCKS_POOL_MAX: 4 }) as Env;

describe('connectionBudget', () => {
  it('is 30 per process at the default request pool of 10', () => {
    const b = connectionBudget(env(10));
    expect(b.total).toBe(30);
    expect(b.parts).toEqual({ requests: 10, jobs: 8, locks: 4, advisory: 3, tenantResolution: 2, webhookPass: 2, listener: 1 });
  });

  it('is 41 at a request pool of 20 (the advisory pool caps at 4)', () => {
    expect(connectionBudget(env(20)).total).toBe(41);
  });

  it('counts every Pool and Client the serving process constructs', () => {
    // Runtime constructors and the budget part that counts each one. Operator-only tools run in their own processes
    // (migrations before the server starts, exports, imports) and are listed so a new one has to be classified.
    const RUNTIME: Record<string, string> = {
      'db/client.ts': 'requests, jobs, locks, advisory', 'payments/tenant-resolution.ts': 'tenantResolution',
      'webhooks/emit.ts': 'webhookPass', 'store-context.ts': 'listener',
    };
    const OPERATOR_ONLY = ['sdk/migrations.ts', 'exports/ops.ts', 'import/run.ts', 'import/restore.ts'];
    const src = fileURLToPath(new URL('..', import.meta.url));
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const abs = join(dir, e.name);
        if (e.isDirectory()) walk(abs);
        else if (e.name.endsWith('.ts') && !/\.test\.ts$|testkit/.test(e.name)) files.push(abs);
      }
    };
    walk(src);
    const constructing = files
      .filter((f) => /new (?:pg\.)?(?:Pool|Client)\(|extends Client\b/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(src, f).split(sep).join('/'))
      .filter((f) => !f.startsWith('scripts/'))
      .sort();
    expect(constructing).toEqual([...Object.keys(RUNTIME), ...OPERATOR_ONLY].sort());
  });
});

describe('connection budget enforcement (#360 N7)', () => {
  const e = (over: Partial<Env>) => ({ PGPOOL_MAX: 10, PGJOBS_POOL_MAX: 8, PGLOCKS_POOL_MAX: 4, PG_CONNECTION_BUDGET_ENFORCE: '0', ...over }) as Env;

  it('warn-only by default: an over-budget configuration still starts', () => {
    expect(() => assertConnectionBudget(e({ PG_CONNECTION_BUDGET: 20 }))).not.toThrow();
  });

  it('PG_CONNECTION_BUDGET_ENFORCE=1 refuses pool maxima over the budget, and accepts ones that fit', () => {
    expect(() => assertConnectionBudget(e({ PG_CONNECTION_BUDGET_ENFORCE: '1', PG_CONNECTION_BUDGET: 29 }))).toThrow(ConnectionBudgetError);
    expect(() => assertConnectionBudget(e({ PG_CONNECTION_BUDGET_ENFORCE: '1', PG_CONNECTION_BUDGET: 30 }))).not.toThrow();
    // the plan's example share: API 16 + runner 4 inside a 20-connection service allocation needs smaller pools
    expect(() => assertConnectionBudget(e({ PG_CONNECTION_BUDGET_ENFORCE: '1', PG_CONNECTION_BUDGET: 20, PGPOOL_MAX: 6, PGJOBS_POOL_MAX: 4, PGLOCKS_POOL_MAX: 2 }))).not.toThrow();
  });

  it('PG_CONNECTION_BUDGET_ENFORCE=1 without a budget is a configuration error', () => {
    expect(() => assertConnectionBudget(e({ PG_CONNECTION_BUDGET_ENFORCE: '1' }))).toThrow(/needs PG_CONNECTION_BUDGET/);
  });

  it('poolMax hands each budgeted pool its share, so constructors and the budget cannot drift', () => {
    expect(poolMax('tenantResolution', e({}))).toBe(FIXED_POOL_MAX.tenantResolution);
    expect(poolMax('webhookPass', e({}))).toBe(FIXED_POOL_MAX.webhookPass);
    expect(poolMax('requests', e({ PGPOOL_MAX: 17 }))).toBe(17);
    expect(poolMax('advisory', e({ PGPOOL_MAX: 40 }))).toBe(4);
  });
});
