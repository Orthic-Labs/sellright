// node --test tools/compose/env-check.test.mjs   (cwd: packages/storefront)
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { LEGACY_PROBE_MODE, checkEnv, defaultLoadEnv, effectiveHash, finalEffectiveHash, loadSchema, renderEnvProduction, validateSchema } from './env-check.mjs';
import { ComposeError, Problems } from './lib/util.mjs';
import { miniLoadEnv } from './fixtures/support.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_FILE = path.join(HERE, '..', '..', 'brand-env.schema.json');
const schema = () => structuredClone(loadSchema(SCHEMA_FILE));

/** compose writes every setting into .env.production as its build env name, defaults included. */
const SETTINGS_ENV_DEFAULT = { VITE_SR_PDP_STOCK_TRIGGER: 'qidle', VITE_SR_SHOP_STOCK_ON_LOAD: 'manifest', VITE_SR_PDP_BFCACHE_REFRESH: 'false' };
const withSettings = (o) => ({ ...o, ...SETTINGS_ENV_DEFAULT });

const baseBrand = () => ({
	settings: {},
	publicConfig: { VITE_STORE_NAME: 'Brand Store', VITE_PUBLIC_DOMAIN: 'brand.example' },
	requiredEnv: ['VITE_STORE_NAME'],
});

const dirs = [];
function tmp() {
	const d = mkdtempSync(path.join(tmpdir(), 'env-check-'));
	dirs.push(d);
	return d;
}
after(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function run({ brand = baseBrand(), sch = schema(), files = {}, env = {}, loadEnv = miniLoadEnv } = {}) {
	const dir = tmp();
	for (const [f, text] of Object.entries(files)) writeFileSync(path.join(dir, f), text);
	const saved = {};
	for (const [k, v] of Object.entries(env)) {
		saved[k] = process.env[k];
		process.env[k] = v;
	}
	const problems = new Problems();
	try {
		const r = await checkEnv({ schema: sch, brand, buildDir: dir, loadEnv, problems });
		return { r, problems, dir };
	} finally {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
}

test('the checked-in schema is valid and each name has exactly one owner', () => {
	const p = new Problems();
	validateSchema(schema(), p);
	assert.deepEqual(p.list, []);
	const s = schema();
	for (const k of ['pdp.stockRefreshTrigger', 'shop.stockOnLoad', 'pdp.bfcacheRefresh']) assert.ok(s.settings[k], k);
	assert.equal(s.settings['pdp.stockRefreshTrigger'].default, 'qidle');
	for (const n of ['VITE_STORE_NAME', 'VITE_STORE_LEGAL_NAME', 'VITE_STORE_TAGLINE', 'VITE_PUBLIC_DOMAIN', 'VITE_STORE_SUPPORT_EMAIL', 'VITE_STORE_LOGO_TEXT', 'VITE_STORE_LOGO_URL', 'VITE_STORE_OG_IMAGE']) {
		assert.ok(s.publicBuildConfig[n], n);
	}
});

test('a clean brand passes and reports names and a hash only', async () => {
	const { r, problems } = await run();
	assert.deepEqual(problems.list, []);
	assert.deepEqual(r.names, ['VITE_PUBLIC_DOMAIN', 'VITE_SR_PDP_BFCACHE_REFRESH', 'VITE_SR_PDP_STOCK_TRIGGER', 'VITE_SR_SHOP_STOCK_ON_LOAD', 'VITE_STORE_NAME']);
	assert.equal(r.hash, effectiveHash(withSettings({ VITE_STORE_NAME: 'Brand Store', VITE_PUBLIC_DOMAIN: 'brand.example' })));
	assert.equal(r.settings['pdp.stockRefreshTrigger'], 'qidle');
	assert.equal(r.settings['shop.stockOnLoad'], 'manifest');
	assert.equal(r.settings['pdp.bfcacheRefresh'], false);
	assert.ok(!JSON.stringify({ names: r.names, hash: r.hash, warnings: r.warnings }).includes('Brand Store'));
});

test('(a) a name outside the schema fails, from the legacy .env or from brand.json', async () => {
	let x = await run({ files: { '.env': 'VITE_MYSTERY=1\n' } });
	assert.ok(x.problems.codes().includes('env-unknown-name'));
	assert.ok(x.problems.list.some((p) => p.message.includes('VITE_MYSTERY')));
	const brand = baseBrand();
	brand.publicConfig.VITE_NOT_A_THING = 'x';
	x = await run({ brand });
	assert.ok(x.problems.codes().includes('env-unknown-name'));
});

test('(b) a name owned by two sections fails; brand.json cannot fill a section that does not own the name', async () => {
	const dup = schema();
	dup.privateRuntime.names.push('VITE_STORE_NAME');
	const p = new Problems();
	validateSchema(dup, p);
	assert.ok(p.codes().includes('env-duplicate-owner'));
	const viaCheck = await run({ sch: dup });
	assert.ok(viaCheck.problems.codes().includes('env-duplicate-owner'));

	const brand = baseBrand();
	brand.publicConfig.VITE_TURNSTILE_SITE_KEY = 'x';
	assert.ok((await run({ brand })).problems.codes().includes('env-wrong-owner'));
	const asSetting = baseBrand();
	asSetting.settings.VITE_STORE_NAME = 'x';
	assert.ok((await run({ brand: asSetting })).problems.codes().includes('env-wrong-owner'));
});

test('(c) a missing required name fails; a legacy-provided required name satisfies it', async () => {
	const brand = baseBrand();
	brand.requiredEnv = ['VITE_STORE_NAME', 'VITE_STORE_TAGLINE'];
	let x = await run({ brand });
	assert.deepEqual(x.problems.list.map((p) => p.code), ['env-missing-required']);
	assert.ok(x.problems.list[0].message.includes('VITE_STORE_TAGLINE'));

	const priv = baseBrand();
	priv.requiredEnv = ['VITE_STORE_NAME', 'VITE_TURNSTILE_SITE_KEY'];
	x = await run({ brand: priv });
	assert.ok(x.problems.codes().includes('env-missing-required'));
	x = await run({ brand: priv, files: { '.env': 'VITE_TURNSTILE_SITE_KEY=0xSITEKEY\n' } });
	assert.deepEqual(x.problems.list, []);

	const unknownRequired = baseBrand();
	unknownRequired.requiredEnv = ['VITE_NOT_IN_SCHEMA'];
	assert.ok((await run({ brand: unknownRequired })).problems.codes().includes('env-unknown-name'));
});

test('(c2) a required privateRuntime name is checked against its runtime sources, presence only', async () => {
	const SECRET = 'sk_live_not_a_real_secret_value';
	const brand = baseBrand();
	brand.requiredEnv = ['VITE_STORE_NAME', 'SELLRIGHT_API_URL'];
	assert.ok(schema().privateRuntime.names.includes('SELLRIGHT_API_URL'), 'a privateRuntime name');
	// missing (an empty value counts as missing, which also pins a possibly inherited value down)
	let x = await run({ brand, env: { SELLRIGHT_API_URL: '' } });
	assert.deepEqual(x.problems.list.map((p) => p.code), ['env-missing-required']);
	assert.ok(x.problems.list[0].message.includes('SELLRIGHT_API_URL'));
	// supplied through the process environment
	x = await run({ brand, env: { SELLRIGHT_API_URL: SECRET } });
	assert.deepEqual(x.problems.list, []);
	// supplied through the build directory's .env, and through .env.local
	const viaFile = { '.env': `SELLRIGHT_API_URL=${SECRET}\n` };
	x = await run({ brand, files: viaFile, env: { SELLRIGHT_API_URL: '' } });
	assert.deepEqual(x.problems.list.map((p) => p.code), ['env-missing-required'], 'an empty process value wins over the file, as Vite loads it');
	x = await run({ brand, files: viaFile });
	assert.deepEqual(x.problems.list, []);
	x = await run({ brand, files: { '.env.local': `SELLRIGHT_API_URL=${SECRET}\n` } });
	assert.deepEqual(x.problems.list, []);
	// the value is never reported, stored or hashed: result, problems and the public hash are unchanged by it
	assert.ok(!JSON.stringify({ r: x.r, p: x.problems.list }).includes(SECRET));
	const plain = await run({ files: { '.env': 'UNRELATED=1\n' } });
	assert.equal(x.r.hash, plain.r.hash, 'a private value does not enter the public configuration hash');
	assert.deepEqual(x.r.names, plain.r.names);
	// a required PUBLIC name behaves exactly as before
	const pub = baseBrand();
	pub.requiredEnv = ['VITE_STORE_TAGLINE'];
	assert.deepEqual((await run({ brand: pub, env: { SELLRIGHT_API_URL: SECRET } })).problems.list.map((p) => p.code), ['env-missing-required']);
});

test('(d) a legacy-copied public name that differs from brand.json fails, naming the name and never the value', async () => {
	const x = await run({ files: { '.env': 'VITE_STORE_NAME=Somebody Else\n' } });
	assert.deepEqual(x.problems.codes(), ['env-legacy-conflict']);
	assert.ok(!JSON.stringify(x.problems.list).includes('Somebody Else'));
	assert.ok(!JSON.stringify(x.problems.list).includes('Brand Store'));
	const same = await run({ files: { '.env': 'VITE_STORE_NAME=Brand Store\n' } });
	assert.deepEqual(same.problems.list, []);
	const other = await run({ files: { '.env': 'VITE_TURNSTILE_SITE_KEY=0xabc\n' } });
	assert.deepEqual(other.problems.list, [], 'legacy names that brand.json does not own are left alone');
});

test('precedence: brand.json beats .env and .env.local; the process environment beats both; the hash follows the effective value', async () => {
	const files = { '.env': 'VITE_STORE_NAME=FromEnv\n', '.env.local': 'VITE_STORE_NAME=FromLocal\n' };
	const x = await run({ files });
	assert.ok(x.problems.codes().includes('env-legacy-conflict'));
	assert.equal(x.r.hash, effectiveHash(withSettings({ VITE_STORE_NAME: 'Brand Store', VITE_PUBLIC_DOMAIN: 'brand.example' })), 'brand value wins in production mode');

	const viaProcess = await run({ files, env: { VITE_STORE_NAME: 'FromProcess' } });
	assert.equal(viaProcess.r.hash, effectiveHash(withSettings({ VITE_STORE_NAME: 'FromProcess', VITE_PUBLIC_DOMAIN: 'brand.example' })));
	assert.deepEqual(viaProcess.r.warnings, ['process environment overrides VITE_STORE_NAME']);
	assert.ok(!viaProcess.problems.codes().includes('env-roundtrip'));
	assert.ok(!viaProcess.problems.codes().includes('env-legacy-conflict'));

	const again = await run({ files });
	assert.equal(again.r.hash, x.r.hash, 'deterministic');
});

test('effective hash covers VITE_* names and values only, order independent', () => {
	assert.equal(effectiveHash({ VITE_A: '1', VITE_B: '2' }), effectiveHash({ VITE_B: '2', VITE_A: '1' }));
	assert.notEqual(effectiveHash({ VITE_A: '1' }), effectiveHash({ VITE_A: '2' }));
	assert.equal(effectiveHash({ VITE_A: '1', SECRET: 'x' }), effectiveHash({ VITE_A: '1' }));
});

test('a .env.production.local in the build directory would shadow brand.json and fails', async () => {
	const x = await run({ files: { '.env.production.local': 'VITE_STORE_NAME=Shadow\n' } });
	assert.ok(x.problems.codes().includes('env-shadowing-file'));
});

test('settings: defaults, enum and boolean validation, unknown keys', async () => {
	// a wired setting (schema without `wired: false`) accepts a non-default value
	const wired = schema();
	for (const k of Object.keys(wired.settings)) delete wired.settings[k].wired;
	const brand = baseBrand();
	brand.settings = { 'pdp.stockRefreshTrigger': 'qinit', 'pdp.bfcacheRefresh': true, 'shop.stockOnLoad': 'live' };
	const ok = await run({ brand, sch: wired });
	assert.deepEqual(ok.problems.list, []);
	assert.deepEqual(ok.r.settings, { 'pdp.bfcacheRefresh': true, 'pdp.stockRefreshTrigger': 'qinit', 'shop.stockOnLoad': 'live' });
	const bad = baseBrand();
	bad.settings = { 'pdp.stockRefreshTrigger': 'qvisible', 'pdp.bfcacheRefresh': 'yes', 'pdp.nope': 1 };
	const x = await run({ brand: bad });
	assert.deepEqual(x.problems.codes().sort(), ['env-bad-setting', 'env-unknown-setting']);
	assert.notEqual(ok.r.settingsHash, (await run()).r.settingsHash);
});

test('settings are wired: every value reaches the build as its env name in .env.production (the gate stays for a future unwired setting)', async () => {
	const sch = schema();
	for (const k of ['pdp.stockRefreshTrigger', 'shop.stockOnLoad', 'pdp.bfcacheRefresh']) assert.equal(sch.settings[k].wired, undefined, `${k} is wired`);
	const brand = baseBrand();
	brand.settings = { 'pdp.stockRefreshTrigger': 'qinit', 'shop.stockOnLoad': 'live', 'pdp.bfcacheRefresh': true };
	const x = await run({ brand });
	assert.deepEqual(x.problems.list, []);
	assert.match(x.r.envProduction, /^VITE_SR_PDP_STOCK_TRIGGER="qinit"$/m);
	assert.match(x.r.envProduction, /^VITE_SR_SHOP_STOCK_ON_LOAD="live"$/m);
	assert.match(x.r.envProduction, /^VITE_SR_PDP_BFCACHE_REFRESH="true"$/m);
	assert.match((await run()).r.envProduction, /^VITE_SR_SHOP_STOCK_ON_LOAD="manifest"$/m, 'defaults are written too');
	// a setting a future schema marks unwired is still refused at a non-default value
	const unwired = schema();
	unwired.settings['shop.stockOnLoad'].wired = false;
	const y = await run({ brand, sch: unwired });
	assert.deepEqual(y.problems.codes(), ['env-setting-unwired']);
	assert.match(y.problems.list[0].message, /keep the setting in brand\.json/);
});

test('a setting env name is owned by settings: brand.json publicConfig may not set it, and the process environment may not override it', async () => {
	const brand = baseBrand();
	brand.publicConfig.VITE_SR_SHOP_STOCK_ON_LOAD = 'live';
	assert.ok((await run({ brand })).problems.codes().includes('env-wrong-owner'));
	const x = await run({ env: { VITE_SR_SHOP_STOCK_ON_LOAD: 'live' } });
	assert.ok(x.problems.codes().includes('env-setting-overridden'));
	const sch = schema();
	sch.settings['pdp.bfcacheRefresh'].env = 'VITE_SR_PDP_STOCK_TRIGGER';
	const p = new Problems();
	validateSchema(sch, p);
	assert.ok(p.codes().includes('env-duplicate-owner'));
});

test('renderEnvProduction is sorted, quoted and refuses unrepresentable values', () => {
	const text = renderEnvProduction({ VITE_B: 'two', VITE_A: 'has space # and $5' });
	assert.equal(text.split('\n')[1], 'VITE_A="has space # and \\$5"');
	assert.equal(text.split('\n')[2], 'VITE_B="two"');
	assert.ok(text.endsWith('\n'));
	assert.throws(() => renderEnvProduction({ VITE_A: 'a\nb' }), (e) => e instanceof ComposeError && e.code === 'env-bad-value');
	assert.throws(() => renderEnvProduction({ VITE_A: `"'\`` }), (e) => e instanceof ComposeError && e.code === 'env-bad-value');
	assert.equal(renderEnvProduction({ VITE_A: 'say "hi"' }).split('\n')[1], "VITE_A='say \"hi\"'");
});

test('renderEnvProduction escapes backslashes as well as dollar signs, so a value cannot smuggle an escape', () => {
	assert.equal(renderEnvProduction({ VITE_A: 'a\\b' }).split('\n')[1], 'VITE_A="a\\\\b"');
	assert.equal(renderEnvProduction({ VITE_A: '\\$X' }).split('\n')[1], 'VITE_A="\\\\\\$X"');
});

// ------------------------------------------------ against Vite's own loadEnv (missing coverage when vite cannot be resolved)

let realLoadEnv = null;
try {
	realLoadEnv = await defaultLoadEnv();
} catch {
	realLoadEnv = null;
}
const needVite = { skip: realLoadEnv === null && 'vite is not resolvable from this directory (missing coverage, not a pass)' };

test('Vite loadEnv: file precedence and process override are what the contract assumes', needVite, () => {
	const dir = tmp();
	writeFileSync(path.join(dir, '.env'), 'VITE_X=env\nVITE_ONLY_ENV=1\n');
	writeFileSync(path.join(dir, '.env.local'), 'VITE_X=local\n');
	assert.equal(realLoadEnv('production', dir, 'VITE_').VITE_X, 'local');
	writeFileSync(path.join(dir, '.env.production'), 'VITE_X=production\n');
	const e = realLoadEnv('production', dir, 'VITE_');
	assert.equal(e.VITE_X, 'production');
	assert.equal(e.VITE_ONLY_ENV, '1');
	assert.equal(realLoadEnv(LEGACY_PROBE_MODE, dir, 'VITE_').VITE_X, 'local', 'the probe mode sees only .env and .env.local');
	const savedViteX = process.env.VITE_X;
	process.env.VITE_X = 'process';
	try {
		assert.equal(realLoadEnv('production', dir, 'VITE_').VITE_X, 'process');
	} finally {
		if (savedViteX === undefined) delete process.env.VITE_X;
		else process.env.VITE_X = savedViteX;
	}
});

test('Vite loadEnv: values that need quoting survive .env.production', needVite, async () => {
	const publicConfig = {
		VITE_STORE_NAME: 'Brand Store',
		VITE_STORE_TAGLINE: 'Cost $5, not ${NOPE} # not a comment',
		VITE_STORE_LEGAL_NAME: 'Say "hi" Co',
		VITE_STORE_SUPPORT_EMAIL: "o'brien@example.com",
		VITE_THEME_FONT_BODY: "Inter, 'Helvetica Neue', sans-serif",
	};
	const brand = { settings: {}, publicConfig, requiredEnv: ['VITE_STORE_NAME'] };
	const { r, problems } = await run({ brand, loadEnv: realLoadEnv });
	assert.deepEqual(problems.list, [], JSON.stringify(problems.list));
	assert.equal(r.hash, effectiveHash(withSettings(publicConfig)));
});

test('Vite loadEnv: legacy conflict and precedence end to end', needVite, async () => {
	const x = await run({ loadEnv: realLoadEnv, files: { '.env': 'VITE_STORE_NAME=Somebody Else\nSTRIPE_SECRET_NOT_REAL=nope\n' } });
	assert.deepEqual(x.problems.codes(), ['env-legacy-conflict']);
	assert.equal(x.r.hash, effectiveHash(withSettings({ VITE_STORE_NAME: 'Brand Store', VITE_PUBLIC_DOMAIN: 'brand.example' })));
	assert.ok(!x.r.names.includes('STRIPE_SECRET_NOT_REAL'));
});

test('Vite loadEnv: NODE_ENV from .env stays runtime-only in public maps and hashes', needVite, async () => {
	const savedEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => name === 'NODE_ENV' || name.startsWith('VITE_')));
	for (const name of Object.keys(savedEnv)) delete process.env[name];
	try {
		const brand = baseBrand();
		brand.requiredEnv = ['VITE_STORE_NAME', 'SELLRIGHT_API_URL'];
		const files = {
			'.env': 'NODE_ENV=production\nSELLRIGHT_API_URL=https://private.example\n',
		};
		const { r, problems, dir } = await run({ brand, files, loadEnv: realLoadEnv });
		assert.deepEqual(problems.list, []);
		assert.ok(!r.names.includes('VITE_USER_NODE_ENV'));
		assert.equal(r.hash, effectiveHash(withSettings({ VITE_STORE_NAME: 'Brand Store', VITE_PUBLIC_DOMAIN: 'brand.example' })));
		writeFileSync(path.join(dir, '.env.production'), r.envProduction);
		assert.equal(await finalEffectiveHash({ buildDir: dir, loadEnv: realLoadEnv }), r.hash);

		const mystery = await run({
			brand,
			files: { '.env': 'NODE_ENV=production\nSELLRIGHT_API_URL=https://private.example\nVITE_MYSTERY=1\n' },
			loadEnv: realLoadEnv,
		});
		assert.ok(mystery.problems.codes().includes('env-unknown-name'));
		assert.ok(mystery.problems.list.some((problem) => problem.message.includes('VITE_MYSTERY')));
		assert.ok(!mystery.r.names.includes('VITE_USER_NODE_ENV'));
	} finally {
		for (const name of Object.keys(process.env)) {
			if (name === 'NODE_ENV' || name.startsWith('VITE_')) delete process.env[name];
		}
		Object.assign(process.env, savedEnv);
	}
});
