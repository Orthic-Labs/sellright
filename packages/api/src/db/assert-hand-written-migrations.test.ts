import { afterEach, describe, expect, it } from 'vitest';
import { appendFileSync, copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const source = fileURLToPath(new URL('../../drizzle/', import.meta.url));
const script = fileURLToPath(new URL('./assert-hand-written-migrations.ts', import.meta.url));
const fixtures: string[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'sellright-migration-guard-'));
  fixtures.push(dir);
  for (const name of readdirSync(source).filter((name) => name.endsWith('.sql'))) {
    copyFileSync(join(source, name), join(dir, name));
  }
  return dir;
}
function check(dir: string) {
  return spawnSync(process.execPath, ['--import', 'tsx', script], {
    env: { ...process.env, MIGRATIONS_DIR: dir }, encoding: 'utf8', timeout: 10_000,
  });
}
afterEach(() => { for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('hand-written migration guard', () => {
  it('accepts the unchanged, marked migrations (MIGRATIONS_DIR override)', () => {
    expect(check(fixture()).status).toBe(0);
  });
  it('rejects missing markers', () => {
    const dir = fixture();
    const path = join(dir, '0032_cart_ttl.sql');
    writeFileSync(path, readFileSync(path, 'utf8').replace('-- HAND-WRITTEN: see docs/runbooks/migrations.md', '-- removed'));
    const result = check(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('HAND-WRITTEN marker missing');
  });
  it('rejects a missing hand-written file entirely', () => {
    const dir = fixture();
    rmSync(join(dir, '0034_subscriptions.sql'));
    const result = check(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('file missing');
  });
});
