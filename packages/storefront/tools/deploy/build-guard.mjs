#!/usr/bin/env node
// Deploy token check for the guarded inner build script (plan A D2 (1), §4.6a g, finding C7).
//
//   build-guard.mjs --script-dir <dir of the build script>
//
// Exit 0 only when SELLRIGHT_DEPLOY_STAGE equals the stageId of a state file in `building` and the script's own
// directory belongs to that stage: <root>/<stage dir>/<scripts dir>, state at <root>/.deploy-state/storefront.json,
// stage directory named `*.next`. Anything else exits 6 and changes nothing, so a plain `pnpm build` in a composed
// tree stops here. It also re-hashes the build exports in its environment against the exportsHash that compose recorded
// in the stage's build-config.json, so a build started with different exports is refused. Node built-ins only: the composed tree has no tools of its own.
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** @returns {{ ok: boolean, reason?: string }} */
export function checkToken({ scriptDir, env = process.env }) {
	const token = env.SELLRIGHT_DEPLOY_STAGE;
	if (!token) return { ok: false, reason: 'SELLRIGHT_DEPLOY_STAGE is not set; this build only runs through the deploy entry' };
	let stage;
	try {
		stage = path.dirname(realpathSync(scriptDir));
	} catch {
		return { ok: false, reason: `script directory ${scriptDir} cannot be resolved` };
	}
	if (!path.basename(stage).endsWith('.next')) return { ok: false, reason: `${stage} is not a stage directory (*.next)` };
	const stateFile = path.join(path.dirname(stage), '.deploy-state', 'storefront.json');
	let state;
	try {
		state = JSON.parse(readFileSync(stateFile, 'utf8'));
	} catch {
		return { ok: false, reason: `no readable state file at ${stateFile}` };
	}
	if (state.state !== 'building') return { ok: false, reason: `state is ${state.state}, not building` };
	if (state.stageId !== token) return { ok: false, reason: 'SELLRIGHT_DEPLOY_STAGE does not match the stage being built' };
	return checkExports({ stage, env });
}

/**
 * The build's own exports (brand.json buildExports, recorded as names plus one hash in build-config.json) must be in
 * the environment this script was started with, with exactly the recorded values. The hash is the one compose wrote:
 * sha256 of the JSON of [[name, value], ...] sorted by name.
 */
function checkExports({ stage, env }) {
	let cfg;
	try {
		cfg = JSON.parse(readFileSync(path.join(stage, 'build-config.json'), 'utf8'));
	} catch {
		return { ok: false, reason: `no readable build-config.json in ${stage}` };
	}
	if (!Array.isArray(cfg.exportNames) || !/^[0-9a-f]{64}$/.test(cfg.exportsHash ?? '')) return { ok: false, reason: 'build-config.json has no exportNames and exportsHash' };
	const got = createHash('sha256').update(JSON.stringify([...cfg.exportNames].sort().map((n) => [n, env[n] ?? null]))).digest('hex');
	if (got !== cfg.exportsHash) return { ok: false, reason: 'the build exports in the environment differ from the ones recorded in build-config.json' };
	return { ok: true };
}

export function main(argv, env = process.env, out = console) {
	const i = argv.indexOf('--script-dir');
	if (i < 0 || !argv[i + 1]) {
		out.error('usage: build-guard.mjs --script-dir <dir>');
		return 2;
	}
	const r = checkToken({ scriptDir: argv[i + 1], env });
	if (r.ok) return 0;
	out.error(`build refused: ${r.reason}. Use the deploy entry (build, activate, purge or deploy); nothing was changed.`);
	return 6;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
