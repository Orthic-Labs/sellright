// node --test tools/env/env-check.test.mjs   (cwd: packages/storefront)
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'env-check.mjs');
const SCHEMA = path.join(HERE, '..', '..', 'brand-env.schema.json');
const dirs = [];
after(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

let viteOk = true;
try {
	await import('vite');
} catch {
	viteOk = false;
}
const opts = { skip: !viteOk && 'vite is not resolvable from this directory (missing coverage, not a pass)' };

function setup(brand, env = '') {
	const dir = mkdtempSync(path.join(tmpdir(), 'env-cli-'));
	dirs.push(dir);
	writeFileSync(path.join(dir, 'brand.json'), JSON.stringify(brand));
	if (env) writeFileSync(path.join(dir, '.env'), env);
	return dir;
}
const run = (dir, extra = []) => spawnSync(process.execPath, [CLI, '--schema', SCHEMA, '--brand', path.join(dir, 'brand.json'), ...extra], { encoding: 'utf8', env: { ...process.env } });

test('CLI: a valid brand exits 0 and prints names and a hash, never a value', opts, () => {
	const dir = setup({ publicConfig: { VITE_STORE_NAME: 'Secretly Named Store' }, requiredEnv: ['VITE_STORE_NAME'] }, 'STRIPE_SECRET_NOT_REAL=sk_nope\n');
	const r = run(dir, ['--build-dir', dir]);
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /effective VITE_ names \(4\): VITE_SR_PDP_BFCACHE_REFRESH VITE_SR_PDP_STOCK_TRIGGER VITE_SR_SHOP_STOCK_ON_LOAD VITE_STORE_NAME/);
	assert.match(r.stdout, /effective public config hash: [0-9a-f]{64}/);
	assert.ok(!r.stdout.includes('Secretly Named Store') && !r.stdout.includes('sk_nope') && !r.stderr.includes('sk_nope'));
});

test('CLI: an unknown name and a missing required name exit 1', opts, () => {
	const dir = setup({ publicConfig: { VITE_NOT_A_THING: 'x' }, requiredEnv: ['VITE_STORE_NAME'] });
	const r = run(dir);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /\[env-unknown-name\]/);
	assert.match(r.stderr, /\[env-missing-required\]/);
});

test('CLI: missing arguments exit 2', () => {
	const r = spawnSync(process.execPath, [CLI], { encoding: 'utf8' });
	assert.equal(r.status, 2);
});
