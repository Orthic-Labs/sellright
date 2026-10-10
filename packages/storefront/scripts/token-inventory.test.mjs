import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { BRAND_NAMED, inventory, renderReport } from './token-inventory.mjs';

const script = join(dirname(fileURLToPath(import.meta.url)), 'token-inventory.mjs');
const roots = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function write(root, rel, text) {
  const f = join(root, rel);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, text);
}

const CSS = [
  '/* var(--commented) and --ghost: 1 */',
  "@import 'tailwindcss';",
  '@theme {',
  '  --color-ink: #111;',
  '  --color-tint: #eee;',
  '}',
  ':root {',
  '  --color-accent: red;',
  '}',
  '.card {',
  '  --card-pad: 4px;',
  '  padding: var(--card-pad);',
  '  color: var(--color-ink);',
  '}',
  '.x {',
  '  color: var(--color-accent);',
  '  border-color: var(--color-missing);',
  '  background: var(--color-opt, blue);',
  '  outline: 1px solid var(--tw-ring-color);',
  '  fill: var(--color-red-500);',
  '}',
  '',
].join('\n');

const TSX = [
  'export const A = () => {',
  '  const s = useStyles$(`:root { --brand-x: 1; } .a { color: var(--brand-x); }`);',
  "  if (typeof document !== 'undefined') document.documentElement.style.setProperty('--runtime', '1');",
  "  return <div style={{ '--row-gap': '1px' }} class=\"gap-(--row-gap) bg-[var(--color-tint)] text-(--color-missing-2)\">x</div>;",
  '};',
  '',
].join('\n');

function tree({ clean = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sr-tokens-'));
  roots.push(root);
  write(root, 'src/global.css', CSS);
  write(root, 'src/routes/a.tsx', TSX);
  write(root, 'public/x.svg', '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="var(--color-accent)"/></svg>\n');
  if (clean) {
    write(root, 'src/global.css', CSS.replace('border-color: var(--color-missing);', 'border-color: var(--color-ink);'));
    write(root, 'src/routes/a.tsx', TSX.replace(' text-(--color-missing-2)', ''));
  }
  return root;
}
const run = (root, args = []) => spawnSync(process.execPath, [script, '--root', root, ...args], { encoding: 'utf8' });

test('classifies global, scoped-local, tailwind-builtin, optional and undeclared names', () => {
  const inv = inventory({ root: tree() });
  const cls = (n) => inv.tokens[n]?.class;
  assert.equal(cls('--color-ink'), 'global');
  assert.equal(cls('--color-tint'), 'global');
  assert.equal(cls('--color-accent'), 'global');
  assert.equal(cls('--brand-x'), 'global', 'a :root rule inside a template string is global');
  assert.equal(cls('--runtime'), 'global', 'setProperty on documentElement is global');
  assert.equal(cls('--card-pad'), 'scoped-local');
  assert.equal(cls('--row-gap'), 'scoped-local', 'an inline style key is local');
  assert.equal(cls('--color-opt'), 'optional-undeclared');
  assert.equal(cls('--tw-ring-color'), 'tailwind-builtin');
  assert.equal(cls('--color-red-500'), 'tailwind-builtin');
  assert.equal(cls('--color-missing'), 'undeclared');
  assert.equal(cls('--color-missing-2'), 'undeclared');
  assert.deepEqual(inv.undeclared, ['--color-missing', '--color-missing-2']);
  assert.equal(inv.tokens['--commented'], undefined, 'names in CSS comments are ignored');
  assert.equal(inv.tokens['--ghost'], undefined);
  assert.equal(inv.summary.undeclared, 2);
});

test('records declaration and consumer locations, including Tailwind shorthand and svg in public/', () => {
  const inv = inventory({ root: tree() });
  assert.deepEqual(inv.tokens['--card-pad'].declarations.map((d) => [d.file, d.line]), [['src/global.css', 11]]);
  assert.deepEqual(inv.tokens['--card-pad'].consumers.map((c) => [c.file, c.line]), [['src/global.css', 12]]);
  assert.deepEqual(inv.tokens['--color-accent'].consumers.map((c) => c.file), ['public/x.svg', 'src/global.css']);
  assert.equal(inv.tokens['--row-gap'].consumers.length, 1);
  assert.equal(inv.tokens['--color-tint'].consumers.length, 1);
  assert.equal(inv.tokens['--runtime'].unused, true);
  assert.equal(inv.tokens['--color-opt'].consumers[0].fallback, true);
});

test('reports the brand-named globals from the plan', () => {
  const inv = inventory({ root: tree() });
  assert.deepEqual(Object.keys(inv.brandNamed), [...BRAND_NAMED].sort());
  assert.equal(inv.brandNamed['--color-accent'], 'global');
  assert.equal(inv.brandNamed['--color-parchment'], 'absent');
});

test('CLI: undeclared names exit 1; a clean tree exits 0; json and report are deterministic', () => {
  const dirty = tree();
  const r = run(dirty);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /2 undeclared/);
  assert.match(r.stdout, /undeclared: --color-missing \(src\/global\.css:17\)/);

  const clean = tree({ clean: true });
  const j1 = join(clean, 'inv1.json');
  const j2 = join(clean, 'inv2.json');
  const md = join(clean, 'report.md');
  assert.equal(run(clean, ['--json', j1, '--report', md]).status, 0);
  assert.equal(run(clean, ['--json', j2]).status, 0);
  assert.equal(readFileSync(j1, 'utf8'), readFileSync(j2, 'utf8'));
  const report = readFileSync(md, 'utf8');
  assert.ok(report.includes('## Undeclared\n\nNone.'));
  assert.ok(report.includes('| `--color-ink` |'));
  assert.equal(report, renderReport(JSON.parse(readFileSync(j1, 'utf8'))));
});

test('--known marks names declared outside the tree as global and external', () => {
  const root = tree();
  const known = join(root, 'known.json');
  writeFileSync(known, JSON.stringify(['--color-missing', '--color-missing-2']));
  const json = join(root, 'out.json');
  assert.equal(run(root, ['--known', known, '--json', json]).status, 0);
  const inv = JSON.parse(readFileSync(json, 'utf8'));
  assert.equal(inv.tokens['--color-missing'].class, 'global');
  assert.equal(inv.tokens['--color-missing'].external, true);
});

test('symlinks and build output directories are not scanned; bad arguments exit 2', () => {
  const root = tree({ clean: true });
  const outside = mkdtempSync(join(tmpdir(), 'sr-tokens-out-'));
  roots.push(outside);
  write(outside, 'o.css', '.o { color: var(--from-outside); }\n');
  symlinkSync(outside, join(root, 'src', 'linked'));
  write(root, 'src/dist/built.css', '.b { color: var(--from-dist); }\n');
  const j = join(root, 'o.json');
  assert.equal(run(root, ['--json', j]).status, 0);
  const inv = JSON.parse(readFileSync(j, 'utf8'));
  assert.equal(inv.tokens['--from-outside'], undefined);
  assert.equal(inv.tokens['--from-dist'], undefined);
  assert.equal(existsSync(j), true);
  assert.equal(spawnSync(process.execPath, [script, '--nope'], { encoding: 'utf8' }).status, 2);
});
