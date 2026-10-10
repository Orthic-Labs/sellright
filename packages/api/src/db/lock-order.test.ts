import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain .mjs CI script (no declarations)
import { analyze, applyAllowlist, listSourceFiles, loadAllowlist, scanFile } from '../../scripts/assert-lock-order.mjs';

const API = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FX = join(API, 'scripts', 'lock-audit.fixtures');
const EXEMPT = (p: string) => /[\\/]src[\\/]db[\\/](locks|client)\.ts$/.test(p);

function check(file: string, allow: unknown[] = []) {
  const text = readFileSync(file, 'utf8');
  const result = analyze([scanFile(file, text)]);
  return [...new Set(applyAllowlist(result, allow).map((v: { rule: string }) => v.rule))].sort();
}

describe('lock-order audit (STOREKIT §5.7)', () => {
  it('source tree passes with the allow-list (no unlisted mixed path, no order violation, no stale entry)', () => {
    const files: string[] = listSourceFiles(join(API, 'src'), EXEMPT);
    const scans = files.map((f: string) => scanFile(relative(API, f).split(sep).join('/'), readFileSync(f, 'utf8')));
    const allow = loadAllowlist(join(API, 'scripts', 'lock-audit.allowlist.json'));
    const vs = applyAllowlist(analyze(scans), allow);
    expect(vs.map((v: { file: string; fn: string; rule: string }) => `${v.rule} ${v.file} ${v.fn}`)).toEqual([]);
  });

  it.each([
    ['f01-mixed-order-then-license', ['M1', 'O2']],
    ['f02-purge-shape', ['M1', 'O2']],
    ['f03-loyalty-advisory-then-order', ['O2']],
    ['f04-refund-then-pay', ['O2']],
    ['f05-raw-sql-order-then-license', ['M1', 'O2']],
    ['f06-cart-before-licence', ['O2']],
    ['f07-sql-for-update-license-after-order', ['M1', 'O2']],
    ['f08-set-after-order', ['O2']],
  ])('negative fixture %s is rejected (%j)', (name, rules) => {
    expect(check(join(FX, 'fail', `${name}.ts`))).toEqual(rules);
  });

  it.each(['p01-order-only', 'p02-set-managed'])('positive fixture %s passes', (name) => {
    expect(check(join(FX, 'pass', `${name}.ts`))).toEqual([]);
  });

  it('licence-then-order is ascending (only the mixed rule applies, no O2)', () => {
    expect(check(join(FX, 'pass', 'p03-license-then-order.ts'))).toEqual(['M1']);
  });

  it('every fixture file is covered by a case above', () => {
    const names = readdirSync(join(FX, 'fail')).length + readdirSync(join(FX, 'pass')).length;
    expect(names).toBe(11);
  });
});
