import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Plan 2.2: the exports contract. `exports/contract.json` records, per engine
 * module imported by moved (fork) code, public | moved | replaced. This test pins:
 *  - every `public` symbol is exported from its surface barrel (`src/exports/<surface>.ts`);
 *  - no `moved` / `replaced` symbol is exported from ANY barrel (incl. pool/unsafeUnscopedDb/env/registry);
 *  - barrels export nothing beyond the contract's public set;
 *  - package.json `exports` maps exactly the SDK entry + surfaces + contract, to files the build emits;
 *  - consumer packages in this workspace import only exported `@sellright/api` subpaths (deep-import gate).
 */
const API = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pkg = JSON.parse(readFileSync(join(API, 'package.json'), 'utf8')) as { exports: Record<string, unknown>; files: string[] };
interface Sym { module: string; symbol: string; kind: string; disposition: 'public' | 'moved' | 'replaced'; surface: string | null }
const contract = JSON.parse(readFileSync(join(API, 'exports/contract.json'), 'utf8')) as { symbols: Sym[] };

const SURFACES = ['db', 'schema', 'auth', 'http', 'log', 'licensing', 'storekit', 'payments'];

function barrelExports(surface: string): string[] {
  const file = join(API, 'src/exports', `${surface}.ts`);
  const program = ts.createProgram([file], { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, target: ts.ScriptTarget.ES2022, skipLibCheck: true, noEmit: true, strict: true });
  const checker = program.getTypeChecker();
  const sf = program.getSourceFile(file)!;
  const sym = checker.getSymbolAtLocation(sf)!;
  return checker.getExportsOfModule(sym).map((s) => s.getName());
}

const exported = new Map(SURFACES.map((s) => [s, barrelExports(s)]));

describe('exports contract', () => {
  it('matches the pinned totals (0.1 graph 86 symbols + policy-registrar exports + StoreKit policy helpers + payment hook contract types + checkout policy hook types (X-57): 179 = 161 public / 3 moved / 15 replaced)', () => {
    const by = (d: string) => contract.symbols.filter((s) => s.disposition === d).length;
    expect([contract.symbols.length, by('public'), by('moved'), by('replaced')]).toEqual([179, 161, 3, 15]);
  });

  it('exports every public symbol from its surface', () => {
    const missing = contract.symbols
      .filter((s) => s.disposition === 'public')
      .filter((s) => !exported.get(s.surface!)?.includes(s.symbol))
      .map((s) => `${s.surface}:${s.symbol} (${s.module})`);
    expect(missing).toEqual([]);
  });

  it('exports nothing marked moved or replaced, from any barrel', () => {
    const all = new Set([...exported.values()].flat());
    const leaked = contract.symbols.filter((s) => s.disposition !== 'public' && all.has(s.symbol)).map((s) => s.symbol);
    // `schema` (the namespace) is public; names like `env`/`pool`/`registerApiPlugin` must never appear.
    expect(leaked).toEqual([]);
  });

  it('barrels export nothing beyond the contract', () => {
    const extras: string[] = [];
    for (const [surface, names] of exported) {
      const allowed = new Set(contract.symbols.filter((s) => s.disposition === 'public' && s.surface === surface).map((s) => s.symbol));
      for (const n of names) if (!allowed.has(n)) extras.push(`${surface}:${n}`);
    }
    expect(extras).toEqual([]);
  });

  it('package.json exports map: entry + surfaces + ops + contract, targets under the shipped files', () => {
    expect(Object.keys(pkg.exports).sort()).toEqual(['.', ...[...SURFACES, 'ops'].map((s) => `./${s}`), './exports/contract.json', './package.json'].sort());
    for (const [k, v] of Object.entries(pkg.exports)) {
      const targets = typeof v === 'string' ? [v] : Object.values(v as Record<string, string>);
      for (const t of targets) expect(t, k).toMatch(/^\.\/(dist|exports)\/|^\.\/package\.json$/);
    }
    expect(pkg.files).toEqual(expect.arrayContaining(['dist', 'drizzle', 'exports', 'BUILD-INFO.json']));
  });
});

// ── deep-import gate ────────────────────────────────────────────────────────
const SPEC = /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)['"](@sellright\/api(?:\/[^'"]*)?)['"]/g;

/** Returns the `@sellright/api…` specifiers in `source` that the exports map does not expose. */
export function findDeepImports(source: string, exportsMap: Record<string, unknown>): string[] {
  const bad: string[] = [];
  for (const m of source.matchAll(SPEC)) {
    const spec = m[1]!;
    const sub = spec === '@sellright/api' ? '.' : `.${spec.slice('@sellright/api'.length)}`;
    if (!(sub in exportsMap)) bad.push(spec);
  }
  return bad;
}

function sources(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === 'dist') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (/\.(ts|tsx|mts|mjs|js)$/.test(e)) out.push(p);
  }
  return out;
}

describe('deep-import gate', () => {
  it('detects a non-exported path (negative fixtures)', () => {
    expect(findDeepImports(`import x from '@sellright/api/dist/db/client.js';`, pkg.exports)).toEqual(['@sellright/api/dist/db/client.js']);
    expect(findDeepImports(`const m = await import('@sellright/api/src/env');`, pkg.exports)).toEqual(['@sellright/api/src/env']);
    expect(findDeepImports(`import { pool } from "@sellright/api/db/client";`, pkg.exports)).toEqual(['@sellright/api/db/client']);
    expect(findDeepImports(`import { withStore } from '@sellright/api/db'; import { createApp } from '@sellright/api';`, pkg.exports)).toEqual([]);
  });

  it('no workspace consumer imports a non-exported @sellright/api path', () => {
    const packagesDir = join(API, '..');
    const offenders: string[] = [];
    for (const name of readdirSync(packagesDir)) {
      if (name === 'api') continue;
      for (const f of sources(join(packagesDir, name))) {
        for (const bad of findDeepImports(readFileSync(f, 'utf8'), pkg.exports)) offenders.push(`${name}: ${f.slice(packagesDir.length + 1)} -> ${bad}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
