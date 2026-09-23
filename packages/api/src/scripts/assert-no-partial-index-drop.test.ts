import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../scripts/assert-no-partial-index-drop.mjs', import.meta.url));

describe('assert-no-partial-index-drop (ra-007 guard)', () => {
  it('passes against the real drizzle/ directory (no spurious DROP INDEX on the partial index)', () => {
    const result = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 10_000 });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('ok — no spurious license_activation index drop');
  });
});
