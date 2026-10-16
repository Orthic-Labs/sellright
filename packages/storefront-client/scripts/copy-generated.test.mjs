import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), 'copy-generated.mjs');
const roots = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function pkg({ withSchema = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sr-copygen-'));
  roots.push(root);
  mkdirSync(join(root, 'src', 'generated'), { recursive: true });
  if (withSchema) writeFileSync(join(root, 'src', 'generated', 'schema.d.ts'), 'export interface paths {}\n');
  return root;
}

test('copies src/generated/schema.d.ts to dist/generated/schema.d.ts, creating the directory', () => {
  const root = pkg();
  const r = spawnSync(process.execPath, [script, root], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(root, 'dist', 'generated', 'schema.d.ts'), 'utf8'), 'export interface paths {}\n');
});

test('overwrites an existing copy and leaves other dist files alone', () => {
  const root = pkg();
  mkdirSync(join(root, 'dist', 'generated'), { recursive: true });
  writeFileSync(join(root, 'dist', 'generated', 'schema.d.ts'), 'old');
  writeFileSync(join(root, 'dist', 'index.js'), 'keep');
  assert.equal(spawnSync(process.execPath, [script, root]).status, 0);
  assert.equal(readFileSync(join(root, 'dist', 'generated', 'schema.d.ts'), 'utf8'), 'export interface paths {}\n');
  assert.equal(readFileSync(join(root, 'dist', 'index.js'), 'utf8'), 'keep');
});

test('fails non-zero when the generated schema is missing (the build must not pass without it)', () => {
  const root = pkg({ withSchema: false });
  const r = spawnSync(process.execPath, [script, root], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.equal(existsSync(join(root, 'dist', 'generated', 'schema.d.ts')), false);
});

test('with no argument it uses the parent of its own scripts/ directory, whatever the cwd', () => {
  const root = pkg();
  mkdirSync(join(root, 'scripts'));
  copyFileSync(script, join(root, 'scripts', 'copy-generated.mjs'));
  const elsewhere = mkdtempSync(join(tmpdir(), 'sr-copygen-cwd-'));
  roots.push(elsewhere);
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'copy-generated.mjs')], { cwd: elsewhere, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(join(root, 'dist', 'generated', 'schema.d.ts')), true);
});
