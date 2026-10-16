import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
// @ts-expect-error — plain .mjs CI script (no declarations)
import { checkSettlementChokepoint, formatViolations, loadAllowlist, programFromTsconfig } from '../../scripts/assert-settlement-chokepoint.mjs';

type V = { file: string; rule: string; message: string };
const API = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FX = 'scripts/settlement-chokepoint.fixtures';
const cfg = ts.getParsedCommandLineOfConfigFile(join(API, 'tsconfig.json'), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined })!;
const { rootDir: _r, ...options } = cfg.options;

function run(files: string[], allowlist: unknown[] = []): V[] {
  const program = ts.createProgram({ rootNames: files.map((f) => join(API, FX, f)), options: { ...options, noEmit: true } });
  return checkSettlementChokepoint({ program, baseDir: API, include: (p: string) => p.startsWith(FX + '/'), allowlist, fixtureRoot: API });
}
const rules = (vs: V[]) => [...new Set(vs.map((v) => v.rule))].sort();

const EXPECT: Record<string, string[]> = {
  n01: ['S1'], n02: ['S1'], n03: ['S1', 'S2'], n04: ['S3'], n05: ['S3'], n06: ['S3'], n07: ['S3'], n08: ['S3'],
  n09: ['S4'], n10: ['S4'], n11: ['S4'], n12: ['S4'], n13: ['S5'], n14: ['S5'], n15: ['S5'], n16: ['S1'],
  n17: ['S1'], n18: ['S1'], n20: ['S7'], n21: ['S1'], n22: ['S7'],
};

describe('settlement chokepoint AST check — negative fixtures N01-N20 (exact rule ids)', () => {
  for (const [id, want] of Object.entries(EXPECT)) {
    it(`${id} is reported as ${want.join('+')}`, () => {
      const vs = run([`fail/${id}.ts`]);
      expect(rules(vs), formatViolations(vs)).toEqual(want);
    });
  }
  it('n19: an allowlisted file with a third site drifts (S8)', () => {
    const entry = { reasonId: 'A-TEST', file: `${FX}/fail/n19.ts`, count: 2, fixture: `${FX}/pass/p01-literals.ts` };
    expect(rules(run(['fail/n19.ts'], [entry]))).toEqual(['S8']);
    expect(run(['fail/n19.ts'], [{ ...entry, count: 3 }])).toEqual([]);
  });
  it('S8 also fires when the positive fixture is missing', () => {
    const entry = { reasonId: 'A-TEST', file: `${FX}/fail/n19.ts`, count: 3, fixture: `${FX}/pass/missing.ts` };
    expect(rules(run(['fail/n19.ts'], [entry]))).toEqual(['S8']);
  });
});

describe('settlement chokepoint AST check — positive fixtures', () => {
  it('literal / narrowed / unrelated writes pass', () => {
    const vs = run(['pass/p01-literals.ts', 'pass/p02-narrowed.ts', 'pass/p03-raw.ts']);
    expect(formatViolations(vs)).toBe('');
  });
  it('each allowlist entry has a positive fixture that is reported exactly `count`-compatibly when allowlisted', () => {
    const entries = loadAllowlist(join(API, 'scripts/settlement-chokepoint.allowlist.json')) as Array<{ reasonId: string; file: string; count: number; fixture: string }>;
    expect(entries.map((e) => e.reasonId).sort()).toEqual(['A-EFFECT-ENGINE', 'A-IMPORT-ORDERS', 'A-SEED-DEMO']);
    const small = entries.filter((e) => e.reasonId !== 'A-EFFECT-ENGINE');
    for (const e of small) {
      const fx = e.fixture.slice(FX.length + 1);
      const vs = run([fx], [{ ...e, file: e.fixture }]);
      expect(formatViolations(vs), e.reasonId).toBe('');
    }
    const eng = entries.find((e) => e.reasonId === 'A-EFFECT-ENGINE')!;
    expect(formatViolations(run([eng.fixture.slice(FX.length + 1)], [{ ...eng, file: eng.fixture, count: 1 }]))).toBe('');
  });
});

describe('settlement chokepoint AST check — real source tree', () => {
  it('has no protected write outside recordSettlementOperation and the enumerated allowlist', () => {
    const { program, baseDir } = programFromTsconfig(join(API, 'tsconfig.json'));
    const vs = checkSettlementChokepoint({
      program, baseDir, include: (p: string) => p.startsWith('src/'),
      allowlist: loadAllowlist(join(API, 'scripts/settlement-chokepoint.allowlist.json')),
    });
    expect(formatViolations(vs)).toBe('');
  }, 180_000);
});
