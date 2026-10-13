// A21: environment and configuration contract.
//
// Three schemas live in brand-env.schema.json, each name owned by exactly one:
//   settings           platform behaviour, filled from brand.json "settings"
//   publicBuildConfig  VITE_* identity/public values, filled from brand.json "publicConfig"
//   privateRuntime     secrets and deployment values, owned by the brand's generator or pm2 env
//
// Precedence (deterministic): compose writes publicConfig to <build dir>/.env.production,
// which Vite loads after .env / .env.local in mode `production`; the process
// environment wins over every file. The check computes the effective VITE_* set with
// Vite's own loadEnv and fails on: (a) a name outside the schema, (b) a name owned by two
// sections (or supplied by brand.json for a section that does not own it), (c) a required
// name that is missing, (d) a legacy-copied public name that differs from brand.json.
// A required privateRuntime name is checked against its runtime sources (the process environment
// and the build directory's .env / .env.local), for presence only: its value is never printed,
// never stored and never part of the public configuration hash.
// A brand.json setting whose schema entry says `wired: false` (validated, but read by no code) may only carry its default
// (env-setting-unwired: a migration gate. The setting stays in the brand's files and the brand stays on its current base pin until the wiring lands). Output is names and hashes only; a value is never printed.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFile, makeTempDir, removeTree } from './lib/durable.mjs';
import { ComposeError, Problems, hashJson, readJson } from './lib/util.mjs';

/** Mode name no .env.<mode> file uses: loadEnv then reads only .env and .env.local, i.e. the legacy values. */
export const LEGACY_PROBE_MODE = 'compose-legacy-probe';
export const BUILD_MODE = 'production';
const NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const SECTIONS = ['settings', 'publicBuildConfig', 'privateRuntime'];

export function loadSchema(file) {
	return readJson(file, 'brand-env.schema.json');
}

/** names of every section, for ownership checks */
export function sectionNames(schema) {
	return {
		settings: Object.keys(schema.settings ?? {}),
		/** The build env name each setting is delivered as (compose writes it; nothing else may). */
		settingsEnv: Object.values(schema.settings ?? {}).map((spec) => spec?.env).filter((n) => typeof n === 'string'),
		publicBuildConfig: Object.keys(schema.publicBuildConfig ?? {}),
		privateRuntime: [...(schema.privateRuntime?.names ?? [])],
	};
}

export function validateSchema(schema, problems = new Problems()) {
	if (!schema || schema.version !== 1) {
		problems.add('env-bad-schema', 'brand-env.schema.json must have "version": 1', 'brand-env.schema.json');
		return problems;
	}
	for (const s of SECTIONS) {
		if (schema[s] === undefined || typeof schema[s] !== 'object' || schema[s] === null) {
			problems.add('env-bad-schema', `section ${s} is missing`, 'brand-env.schema.json');
		}
	}
	if (!Array.isArray(schema.privateRuntime?.names)) problems.add('env-bad-schema', 'privateRuntime.names must be a list', 'brand-env.schema.json');
	const names = sectionNames(schema);
	const owners = new Map();
	for (const s of SECTIONS) {
		for (const n of names[s]) {
			if (s !== 'settings' && !NAME_RE.test(n)) problems.add('env-bad-schema', `name ${JSON.stringify(n)} in ${s} is not UPPER_SNAKE_CASE`, 'brand-env.schema.json');
			if (!owners.has(n)) owners.set(n, []);
			owners.get(n).push(s);
		}
	}
	for (const [n, secs] of owners) {
		if (secs.length > 1) problems.add('env-duplicate-owner', `${n} is owned by more than one section (${secs.join(', ')})`, 'brand-env.schema.json');
	}
	const settingEnvSeen = new Set();
	for (const [k, spec] of Object.entries(schema.settings ?? {})) {
		const env = spec?.env;
		if (typeof env !== 'string' || !/^VITE_SR_[A-Z0-9_]+$/.test(env)) problems.add('env-bad-schema', `setting ${k}: env must be a VITE_SR_* name`, 'brand-env.schema.json');
		else if (settingEnvSeen.has(env) || names.publicBuildConfig.includes(env) || names.privateRuntime.includes(env)) problems.add('env-duplicate-owner', `${env} is owned by more than one setting or section`, 'brand-env.schema.json');
		else settingEnvSeen.add(env);
		if (spec?.type === 'enum') {
			if (!Array.isArray(spec.values) || !spec.values.includes(spec.default)) problems.add('env-bad-schema', `setting ${k}: default must be one of its values`, 'brand-env.schema.json');
		} else if (spec?.type === 'boolean') {
			if (typeof spec.default !== 'boolean') problems.add('env-bad-schema', `setting ${k}: default must be a boolean`, 'brand-env.schema.json');
		} else problems.add('env-bad-schema', `setting ${k}: type must be enum or boolean`, 'brand-env.schema.json');
	}
	return problems;
}

/** brand.json settings and publicConfig against the schema; returns the settings with defaults applied. */
export function validateBrandConfig({ schema, brand, problems = new Problems() }) {
	const names = sectionNames(schema);
	const settings = {};
	for (const [k, spec] of Object.entries(schema.settings ?? {})) settings[k] = spec.default;
	for (const [k, v] of Object.entries(brand.settings ?? {})) {
		const spec = schema.settings?.[k];
		if (!spec) {
			problems.add(names.publicBuildConfig.includes(k) || names.privateRuntime.includes(k) ? 'env-wrong-owner' : 'env-unknown-setting', `settings.${k} is not a platform setting`, 'brand.json');
			continue;
		}
		const ok = spec.type === 'enum' ? spec.values.includes(v) : typeof v === 'boolean';
		if (!ok) problems.add('env-bad-setting', `settings.${k} has an invalid value (allowed: ${spec.type === 'enum' ? spec.values.join(' | ') : 'true | false'})`, 'brand.json');
		else {
			settings[k] = v;
			// A setting the schema marks `wired: false` is validated and hashed but no storefront code reads it yet
			// (src/platform/settings.ts): a non-default value would change nothing while looking configured.
			if (spec.wired === false && v !== spec.default) {
				problems.add('env-setting-unwired', `settings.${k} = ${JSON.stringify(v)} is not honoured by this base: no storefront code reads this setting yet (default ${JSON.stringify(spec.default)}). This is a migration gate, not a request to change the brand: keep the setting in brand.json (it is approved brand configuration) and keep the brand on its current base pin until the platform wiring for it lands`, 'brand.json');
			}
		}
	}
	for (const [n, v] of Object.entries(brand.publicConfig ?? {})) {
		if (!names.publicBuildConfig.includes(n)) {
			const owned = names.privateRuntime.includes(n) ? 'privateRuntime' : names.settings.includes(n) || names.settingsEnv.includes(n) ? 'settings' : null;
			problems.add(owned ? 'env-wrong-owner' : 'env-unknown-name', owned ? `${n} is owned by ${owned}, not by publicBuildConfig` : `${n} is not in the schema`, 'brand.json');
		}
		if (typeof v !== 'string') problems.add('env-bad-value', `publicConfig.${n} must be a string`, 'brand.json');
	}
	const all = new Set([...names.settings, ...names.publicBuildConfig, ...names.privateRuntime]);
	for (const n of brand.requiredEnv ?? []) {
		if (!all.has(n)) problems.add('env-unknown-name', `requiredEnv ${n} is not in the schema`, 'brand.json');
	}
	return { settings, problems };
}

function quoteValue(name, v) {
	if (/[\r\n\0]/.test(v)) throw new ComposeError('env-bad-value', `publicConfig.${name} contains a line break or NUL`);
	const e = v.replace(/[\\$]/g, '\\$&');
	if (!e.includes('"')) return `"${e}"`;
	if (!e.includes("'")) return `'${e}'`;
	if (!e.includes('`')) return `\`${e}\``;
	throw new ComposeError('env-bad-value', `publicConfig.${name} contains all three quote characters`);
}

/** Text of <build dir>/.env.production: sorted, deterministic, no timestamp. */
export function renderEnvProduction(publicConfig, settingsEnv = {}) {
	const lines = ['# Generated by compose from brand.json publicConfig and settings. Do not edit; Vite loads this after .env in production mode.'];
	const all = { ...publicConfig, ...settingsEnv };
	for (const n of Object.keys(all).sort()) lines.push(`${n}=${quoteValue(n, all[n])}`);
	return `${lines.join('\n')}\n`;
}

/** The validated settings as their build env names (every setting, defaults included, so the build never guesses). */
export function settingsEnvOf(schema, settings) {
	const out = {};
	for (const [k, spec] of Object.entries(schema.settings ?? {})) if (typeof spec?.env === 'string') out[spec.env] = String(settings[k]);
	return out;
}

/** Hash of the effective public configuration: sorted names and values of VITE_* only. */
export function effectiveHash(effective) {
	const rows = Object.keys(effective)
		.filter((k) => k.startsWith('VITE_'))
		.sort()
		.map((k) => [k, effective[k]]);
	return hashJson(rows);
}

export async function defaultLoadEnv() {
	const vite = await import('vite');
	return vite.loadEnv;
}

/**
 * Runs the whole contract. `buildDir` may not exist yet (empty target); nothing is
 * written there. A scratch directory holds the would-be .env.production.
 * @returns {{ names: string[], hash: string, settings: object, settingsHash: string, warnings: string[], envProduction: string }}
 */
export async function checkEnv({ schema, brand, buildDir, loadEnv, problems = new Problems() }) {
	validateSchema(schema, problems);
	const { settings } = validateBrandConfig({ schema, brand, problems });
	const names = sectionNames(schema);
	const known = new Set([...names.publicBuildConfig, ...names.privateRuntime, ...names.settingsEnv]);
	const publicConfig = brand.publicConfig ?? {};
	const warnings = [];
	const load = loadEnv ?? (await defaultLoadEnv());

	let envProduction = '';
	try {
		envProduction = renderEnvProduction(publicConfig, settingsEnvOf(schema, settings));
	} catch (e) {
		if (e instanceof ComposeError) problems.add(e.code, e.message, 'brand.json');
		else throw e;
	}

	if (buildDir && existsSync(path.join(buildDir, '.env.production.local'))) {
		problems.add('env-shadowing-file', '.env.production.local exists in the build directory and would override brand.json public config', '.env.production.local');
	}

	const scratch = makeTempDir('compose-env-');
	let legacy = {};
	let fromBrand = {};
	try {
		createFile(path.join(scratch, '.env.production'), envProduction, 0o600);
		fromBrand = load(BUILD_MODE, scratch, 'VITE_');
		legacy = buildDir && existsSync(buildDir) ? load(LEGACY_PROBE_MODE, buildDir, 'VITE_') : {};
	} finally {
		removeTree(scratch);
	}
	const effective = { ...legacy, ...fromBrand };

	for (const n of Object.keys(effective)) {
		if (!known.has(n)) problems.add('env-unknown-name', `effective name ${n} is not in the schema`, 'env');
	}
	const privateNames = new Set(names.privateRuntime);
	const requiredPrivate = (brand.requiredEnv ?? []).filter((n) => privateNames.has(n));
	// Unprefixed read of .env / .env.local and the process environment. Only "is it set" is taken from
	// this object; it never reaches `effective`, the hash, the report or any message.
	let privateSources = {};
	if (requiredPrivate.length) {
		const dir = buildDir && existsSync(buildDir) ? buildDir : makeTempDir('compose-env-');
		try {
			privateSources = load(LEGACY_PROBE_MODE, dir, '');
		} finally {
			if (dir !== buildDir) removeTree(dir);
		}
	}
	for (const n of brand.requiredEnv ?? []) {
		const value = privateNames.has(n) ? privateSources[n] : effective[n];
		if (value === undefined || value === '') problems.add('env-missing-required', `required name ${n} is missing or empty`, 'env');
	}
	// A setting reaches the build only as compose wrote it: a process environment value would silently replace brand.json.
	for (const [n, v] of Object.entries(settingsEnvOf(schema, settings))) {
		if (n in process.env && process.env[n] !== v) problems.add('env-setting-overridden', `${n} is set in the process environment and would override brand.json settings`, 'env');
	}
	for (const [n, v] of Object.entries(publicConfig)) {
		if (typeof v !== 'string') continue;
		if (legacy[n] !== undefined && legacy[n] !== v && !(n in process.env)) {
			problems.add('env-legacy-conflict', `${n}: the legacy .env value differs from brand.json (names only; brand.json wins in .env.production)`, 'env');
		}
		if (!(n in process.env) && fromBrand[n] !== v) {
			problems.add('env-roundtrip', `${n}: value does not survive .env.production parsing (check quotes, backslashes, $)`, 'env');
		}
		if (n in process.env && process.env[n] !== v) warnings.push(`process environment overrides ${n}`);
	}

	return {
		names: Object.keys(effective).filter((k) => k.startsWith('VITE_')).sort(),
		hash: effectiveHash(effective),
		settings,
		settingsHash: hashJson(settings),
		warnings,
		envProduction,
	};
}

/** Re-reads the real build directory after compose wrote .env.production. */
export async function finalEffectiveHash({ buildDir, loadEnv }) {
	const load = loadEnv ?? (await defaultLoadEnv());
	return effectiveHash(load(BUILD_MODE, buildDir, 'VITE_'));
}

// -------------------------------------------------------------------- CLI
// node env-check.mjs --schema <file> --brand <brand.json> [--build-dir <dir>]
export async function main(argv) {
	const args = new Map();
	for (let i = 0; i < argv.length; i += 2) args.set(argv[i], argv[i + 1]);
	const schemaPath = args.get('--schema');
	const brandPath = args.get('--brand');
	if (!schemaPath || !brandPath) {
		console.error('usage: env-check.mjs --schema <brand-env.schema.json> --brand <brand.json> [--build-dir <dir>]');
		return 2;
	}
	const problems = new Problems();
	const r = await checkEnv({ schema: loadSchema(schemaPath), brand: readJson(brandPath, 'brand.json'), buildDir: args.get('--build-dir'), problems });
	console.log(`effective VITE_ names (${r.names.length}): ${r.names.join(' ')}`);
	console.log(`effective public config hash: ${r.hash}`);
	console.log(`settings hash: ${r.settingsHash}`);
	for (const w of r.warnings) console.log(`warning: ${w}`);
	for (const p of problems.list) console.error(`[${p.code}] ${p.message}`);
	return problems.any ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main(process.argv.slice(2)).then(
		(c) => process.exit(c),
		(e) => {
			console.error(e.message);
			process.exit(1);
		},
	);
}
