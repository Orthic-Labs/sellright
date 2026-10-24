import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { connectionBudget } from './client.js';
import type { Env } from '../env.js';

// #360 N7: the per-process maximum counts every pool plus the tenant resolver, the webhook pass and the listener.
const env = (requests: number) => ({ PGPOOL_MAX: requests, PGJOBS_POOL_MAX: 6, PGLOCKS_POOL_MAX: 4 }) as Env;

describe('connectionBudget', () => {
  it('is 28 per process at the default request pool of 10', () => {
    const b = connectionBudget(env(10));
    expect(b.total).toBe(28);
    expect(b.parts).toEqual({ requests: 10, jobs: 6, locks: 4, advisory: 3, tenantResolution: 2, webhookPass: 2, listener: 1 });
  });

  it('is 39 at a request pool of 20 (the advisory pool caps at 4)', () => {
    expect(connectionBudget(env(20)).total).toBe(39);
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
