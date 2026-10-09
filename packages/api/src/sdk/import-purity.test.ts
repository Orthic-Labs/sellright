import { readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { envOrigin } from '../env.js';
import { poolsInitialised } from '../db/client.js';

/**
 * Plan 2.1: env is parsed and the pool is created inside createApp. That only
 * holds if importing engine modules touches neither. This imports every non-script
 * engine module and asserts nothing initialised the env or opened a pool.
 */
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['scripts', 'import']);
const SKIP_FILES = /(\.test\.ts|\.d\.ts)$|(^|\/)index\.ts$|(^|\/)assert-|manifest\/generate\.ts$/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) out.push(...walk(join(dir, e.name))); }
    else if (e.name.endsWith('.ts')) out.push(join(dir, e.name));
  }
  return out;
}

describe('import purity', () => {
  it('importing every engine module neither parses the env nor opens a pool', async () => {
    const files = walk(SRC).filter((f) => !SKIP_FILES.test(relative(SRC, f)) && relative(SRC, f) !== 'sdk/index.ts');
    expect(files.length).toBeGreaterThan(150);
    for (const f of files) await import(f);
    expect(envOrigin()).toBeUndefined();
    expect(poolsInitialised()).toBe(false);
  }, 120_000);
});
