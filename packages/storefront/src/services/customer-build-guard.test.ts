// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const script = resolve('scripts/guard-graphql-customer.sh');
const dirs: string[] = [];
function fixture(source?: string, manifest?: string) {
  const cwd = mkdtempSync(join(tmpdir(), 'customer-guard-'));
  dirs.push(cwd);
  if (source !== undefined) {
    mkdirSync(join(cwd, 'src/providers/shop/customer'), { recursive: true });
    writeFileSync(join(cwd, 'src/providers/shop/customer/customer.ts'), source);
  }
  if (manifest !== undefined) {
    mkdirSync(join(cwd, 'dist'));
    writeFileSync(join(cwd, 'dist/q-manifest.json'), manifest);
  }
  return () => execFileSync('bash', [script], { cwd, encoding: 'utf8', stdio: 'pipe' });
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('legacy customer build guard', () => {
  it('accepts the intentionally removed legacy provider without grep errors', () => {
    expect(fixture()()).toContain('PASS: no legacy customer parser');
  });
  it.each(["import gql from 'graphql-tag'", 'import gql from "graphql-tag"', 'const query = gql`query X { x }`'])('rejects a restored runtime parser: %s', source => {
    expect(fixture(source)).toThrow();
  });
  it('rejects a stale manifest dependency even when the source has been removed', () => {
    expect(fixture(undefined, '{"origin":"src/providers/shop/customer/customer.ts"}')).toThrow();
  });
});
