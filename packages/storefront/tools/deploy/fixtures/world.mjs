// Scratch worlds for the deploy tool tests. Not a test file. Nothing here starts a real process: every external
// command goes through a fake runner that records the call and does what the real command would do to the files.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { checkToken } from '../build-guard.mjs';
import { makeContext } from '../entry.mjs';
import { InjectedCrash, normaliseConfig } from '../lib.mjs';
import { hashJson } from '../../compose/lib/util.mjs';

export const sha = (b) => createHash('sha256').update(b).digest('hex');
export { snapshot, equalSnapshots } from '../../compose/fixtures/support.mjs';

const w = (file, text, mode) => {
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, text);
	if (mode) chmodSync(file, mode);
};

/** A complete built tree: what a successful build leaves behind. */
export function writeBuilt(tree, tag, { server = {} } = {}) {
	w(path.join(tree, 'dist/q-manifest.json'), `{"v":"${tag}"}`);
	w(path.join(tree, 'dist/build/chunk.js'), `chunk-${tag}`);
	w(path.join(tree, 'server/entry.express.js'), `entry-${tag}`);
	for (const [name, body] of Object.entries(server)) w(path.join(tree, 'server', name), body);
}

/** What compose --check-build-env records for a brand's build exports: the file of values and the hash in build-config.json. */
export const exportsHashOf = (map) => hashJson(Object.entries(map).sort(([a], [b]) => (a < b ? -1 : 1)));

/** The development-tree link the archived legacy manifest carries; nothing at that target exists in a test world. */
export const CLIENT_NAME = '@sellright/storefront-client';
export const DEV_LINK = 'link:../../sellright/packages/storefront-client';

export const HISTORY_ID = (n) => `20261011T0000${String(n).padStart(2, '0')}Z-0123456789ab`;
export const HASHES = { pin: 'p'.repeat(40), overlayTree: 'o'.repeat(64), manifest: 'm'.repeat(64), lock: 'l'.repeat(64), publicConfig: 'c'.repeat(64) };

/**
 * @param {{ production?: boolean, adopted?: boolean }} o
 * `world.fail[label] = status` makes that fake command fail; `world.crash[label] = true` throws InjectedCrash from it.
 */
export function makeWorld({ production = false, adopted = true } = {}) {
	const base = mkdtempSync(path.join(tmpdir(), 'deploy-test-'));
	const root = path.join(base, 'root');
	mkdirSync(root);
	const world = {
		base,
		root,
		calls: [],
		fail: {},
		crash: {},
		historyN: 0,
		buildConfigHash: 'b'.repeat(64),
		reportHashes: { ...HASHES },
		smokeOk: true,
		restartOk: true,
		smokeCalls: [],
		started: [],
		stopped: 0,
		gitDirty: false,
		tagTreeDiffers: false,
		tagCommit: 'c'.repeat(40),
		branch: 'main',
		versions: { node: 'v24.0.0', pnpm: '11.0.0' },
		legacyFiles: { 'package.json': `${JSON.stringify({ name: 'legacy', dependencies: { [CLIENT_NAME]: DEV_LINK } })}\n`, 'pnpm-lock.yaml': `importers:\n  .:\n    dependencies:\n      ${CLIENT_NAME}:\n        specifier: ${DEV_LINK}\n        version: ${DEV_LINK}\n`, 'pnpm-workspace.yaml': 'packages: []\n', 'scripts/build-production.sh': '#!/bin/bash\n' },
		serverCollision: false,
		skipArtifact: null,
		storeTracked: false,
		childDead: false,
		installedLinks: [],
		pulled: 0,
		incoming: {},
		incomingSha: 'f'.repeat(40),
		merged: [],
		order: [],
		exports: {},
		exportsTamper: false,
		candidateSmokeOk: true,
		candidateSmokeCalls: [],
		candidateStarted: [],
		candidateStopped: 0,
		candidatePort: 4777,
		checks: [],
		crashAfter: {},
		retainSaw: [],
		retainRestoreWritesMarker: false,
		buildChangesMarker: false,
	};
	world.live = path.join(root, 'store');
	world.next = path.join(root, 'store.next');
	world.prev = path.join(root, 'store.prev');
	world.failedTree = path.join(root, 'store.failed');
	world.layer = path.join(root, 'storefront');
	world.state = path.join(root, '.deploy-state', 'storefront.json');
	world.cleanup = () => rmSync(base, { recursive: true, force: true });

	// the live tree, as the previous release left it
	writeBuilt(world.live, 'v1', { server: { 'old-chunk.js': 'old', 'shared.js': 'v1' } });
	w(path.join(world.live, 'package.json'), '{"name":"live"}\n');
	w(path.join(world.live, 'scripts/retain-build-assets.mjs'), '// helper\n');
	w(path.join(world.live, '.env'), 'PLACEHOLDER=1\n', 0o600);
	if (adopted) w(path.join(world.live, '.compose-managed.json'), '{"version":1,"files":[]}\n');
	w(path.join(world.layer, 'brand.json'), '{}\n');
	w(path.join(root, '.deploy-backups/store-assets-active.json'), '{"active":["a"]}\n');

	const cfgRaw = {
		root,
		productionRoot: production ? root : path.join(base, 'not-the-production-root'),
		compose: ['fake-compose'],
		envGenerator: ['fake-env'],
		retain: { script: 'scripts/retain-build-assets.mjs', archiveDir: '.deploy-backups', marker: 'store-assets-active.json' },
		pm2: { ecosystem: 'ecosystem.config.cjs', name: 'app', readyUrl: 'http://127.0.0.1:4999/', listenTimeoutMs: 10 },
		smoke: { host: 'example.invalid', paths: ['/'] },
		purge: ['fake-purge'],
		envAllow: ['PNPM_HOME'],
		legacy: {},
	};
	world.cfgRaw = cfgRaw;

	const label = (argv) => {
		const [c, ...a] = argv;
		if (c === 'fake-compose') return a.includes('--apply') ? 'compose-apply' : a.includes('--check-build-env') ? 'compose-check' : a.includes('--mark-built') ? 'compose-mark' : a.includes('--restore-inputs') ? 'compose-restore' : 'compose-other';
		if (c === 'fake-env') return 'env';
		if (c === 'pnpm') return a[0] === '--version' ? 'pnpm-version' : 'install';
		if (c === 'bash') return a.includes('--no-restart') ? 'legacy-build' : 'build';
		if (c === 'node') return a[0] === '--version' ? 'node-version' : /retain/.test(a[0]) ? `retain-${a[1]}` : 'node';
		if (c === 'git') return `git:${a.find((x) => !['-C', world.root].includes(x))}`;
		return c;
	};

	const marker = () => path.join(root, '.deploy-backups/store-assets-active.json');
	const readMarker = () => (existsSync(marker()) ? readFileSync(marker(), 'utf8') : null);
	world.marker = readMarker;
	// `crashAfter[label]`: the command did its work and the process was killed right after it
	const run = (args) => {
		const r = exec(args);
		const l = label(args.argv);
		if (world.crashAfter[l]) throw new InjectedCrash(`${l}:after`);
		return r;
	};
	const exec = ({ argv, cwd, env }) => {
		const l = label(argv);
		world.calls.push({ label: l, argv, cwd, env });
		world.onCall?.[l]?.();
		if (world.crash[l]) throw new InjectedCrash(l);
		const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
		const bad = (status) => ({ status, stdout: '', stderr: `${l} failed` });
		if (world.fail[l]) return bad(world.fail[l]);
		switch (l) {
			case 'env':
				w(argv[argv.indexOf('--out') + 1], 'GENERATED=1\n', 0o600);
				return ok();
			case 'compose-apply': {
				const stage = argv[argv.indexOf('--out') + 1];
				world.historyN += 1;
				w(path.join(stage, '.compose-managed.json'), '{"version":1,"files":[]}\n');
				w(path.join(stage, 'compose-report.json'), JSON.stringify({ hashes: world.reportHashes }));
				w(path.join(stage, 'package.json'), '{"name":"composed"}\n');
				w(path.join(stage, 'scripts/build-production.sh'), '#!/bin/bash\n');
				w(path.join(stage, 'scripts/retain-build-assets.mjs'), '// helper\n');
				return ok(`history entry ${HISTORY_ID(world.historyN)} (status applied); run --mark-built after the build succeeds\n`);
			}
			case 'compose-check': {
				const stage = argv[argv.indexOf('--out') + 1];
				const names = Object.keys(world.exports).sort();
				w(path.join(stage, 'build-config.json'), JSON.stringify({ version: 1, buildConfigHash: world.buildConfigHash, exportNames: names, exportsHash: exportsHashOf(world.exports) }));
				w(path.join(stage, 'build-exports.json'), JSON.stringify({ version: 1, exports: world.exportsTamper ? { ...world.exports, TAMPERED: 'x' } : world.exports }));
				return ok();
			}
			case 'compose-restore':
				return ok(`brand layer restored from ${argv[argv.indexOf('--restore-inputs') + 1]}; hashes verified.${world.restoreNote ?? ''}\n`);
			case 'install':
				// what pnpm does with a link: dependency: resolve it against the project directory; a missing target fails the install
				mkdirSync(path.join(cwd, 'node_modules'), { recursive: true });
				const pkg = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8'));
				for (const [name, spec] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
					if (!spec.startsWith('link:')) continue;
					const target = path.resolve(cwd, spec.slice(5));
					if (!existsSync(target)) return { status: 1, stdout: '', stderr: `ERR_PNPM_LINKED_PKG_DIR_NOT_FOUND ${name}: ${target}` };
					world.installedLinks.push({ name, target });
					mkdirSync(path.dirname(path.join(cwd, 'node_modules', name)), { recursive: true });
					symlinkSync(target, path.join(cwd, 'node_modules', name));
				}
				return ok();
			case 'build': {
				const token = checkToken({ scriptDir: path.dirname(argv[1]), env });
				if (!token.ok) return { status: 6, stdout: '', stderr: token.reason };
				const tag = path.basename(path.dirname(path.dirname(argv[1])));
				writeBuilt(cwd, `v2-${tag}`, { server: { 'shared.js': world.serverCollision ? 'DIFFERENT' : 'v1', 'new-chunk.js': 'new' } });
				if (world.skipArtifact) rmSync(path.join(cwd, world.skipArtifact), { recursive: true, force: true });
				// a build script that runs the retention helper rewrites the shared marker as a side effect
				if (world.buildChangesMarker) w(marker(), `{"active":["changed-by-build-${tag}"]}\n`);
				return ok();
			}
			case 'legacy-build':
				writeBuilt(cwd, 'legacy-rebuilt');
				// the real legacy script restores the shared retention marker as a side effect
				w(path.join(root, '.deploy-backups/store-assets-active.json'), '{"active":["changed-by-legacy-build"]}\n');
				return ok();
			case 'retain-save':
				// the real helper keeps only what the marker names: what it sees here decides which live assets survive
				world.retainSaw.push(readMarker());
				return ok();
			case 'retain-restore':
				if (world.retainRestoreWritesMarker) w(marker(), '{"active":["written-by-stage-restore"]}\n');
				return ok();
			case 'git:status':
				return ok(world.gitDirty ? ' M store/file\n' : '');
			case 'git:rev-parse': {
				const spec = argv.at(-1);
				if (argv.includes('--abbrev-ref')) return ok(`${world.branch}\n`);
				if (spec === 'HEAD') return ok('h'.repeat(40) + '\n');
				if (spec === '@{u}') return ok(`${world.incomingSha}\n`);
				if (argv.includes('--verify')) return ok(`${world.tagCommit}\n`);
				return ok(spec.startsWith('HEAD:') ? 'tree-a\n' : world.tagTreeDiffers ? 'tree-b\n' : 'tree-a\n');
			}
			case 'git:ls-files':
				return ok(world.storeTracked ? 'store/package.json\n' : '');
			case 'git:fetch':
				return ok();
			case 'git:merge-base':
				return ok();
			case 'git:diff':
				// the paths the incoming commit adds or changes (relative to the checkout root)
				return ok(Object.keys(world.incoming).map((f) => `${f}\0`).join(''));
			case 'git:merge': {
				// what a fast-forward does: write the incoming tree into the checkout, ignored live files included
				const sha = argv.at(-1);
				world.merged.push(sha);
				for (const [rel, body] of Object.entries(world.incoming)) w(path.join(root, rel), body);
				return ok();
			}
			case 'git:archive': {
				const out = argv[argv.indexOf('-o') + 1];
				w(out, 'tar');
				return ok();
			}
			case 'tar': {
				const dir = argv[argv.indexOf('-C') + 1];
				const strip = argv.includes('--strip-components=1');
				for (const [rel, body] of Object.entries(world.legacyFiles)) w(path.join(dir, strip ? '' : 'store', rel), body);
				return ok();
			}
			case 'fake-purge':
				world.smokesBeforePurge = world.smokeCalls.length;
				return ok();
			case 'node-version':
				return ok(`${world.versions.node}\n`);
			case 'pnpm-version':
				return ok(`${world.versions.pnpm}\n`);
			default:
				return ok();
		}
	};

	const isCandidate = (cwdOrPort) => cwdOrPort === world.next || cwdOrPort === world.candidatePort;
	const deps = {
		run,
		env: { PATH: '/usr/bin' },
		now: () => new Date('2026-10-11T00:00:00Z'),
		sleep: async () => {},
		freePort: async () => world.candidatePort,
		waitReady: async () => true,
		smoke: async (base, opts) => {
			if (isCandidate(Number(new URL(base).port))) {
				world.candidateSmokeCalls.push({ base, opts, entry: readFileSync(path.join(world.next, 'server/entry.express.js'), 'utf8'), liveEntry: readFileSync(path.join(world.live, 'server/entry.express.js'), 'utf8') });
				return world.candidateSmokeOk ? { ok: true, results: [{ path: '/', ok: true, status: 200 }] } : { ok: false, results: [{ path: '/', ok: false, status: 500, reason: 'candidate is broken' }] };
			}
			world.smokeCalls.push({ base, opts, liveEntry: readFileSync(path.join(world.live, 'server/entry.express.js'), 'utf8') });
			return world.smokeOk ? { ok: true, results: [{ path: '/', ok: true, status: 200 }] } : { ok: false, results: [{ path: '/', ok: false, status: 500, reason: 'status is not 200' }] };
		},
		startLocal: (o) => {
			if (isCandidate(o.cwd)) {
				world.candidateStarted.push(o);
				return { alive: () => !world.childDead, stop: () => (world.candidateStopped += 1) };
			}
			world.started.push(o);
			if (world.crashOnStart) throw new InjectedCrash('start');
			return { alive: () => !world.childDead, stop: () => (world.stopped += 1) };
		},
		restartProd: async (ctx) => {
			world.started.push({ prod: true, cwd: ctx.paths.live });
			return world.restartOk;
		},
		afterSeedCopy: (rel, n) => world.afterSeedCopy?.(rel, n),
		checkpoint: async (name) => {
			world.checks.push(name);
			await world.onCheckpoint?.(name);
		},
	};
	world.deps = deps;
	world.ctx = (over = {}) => {
		const cfg = normaliseConfig({ ...cfgRaw, ...over }, {});
		return makeContext(cfg, deps);
	};
	world.config = (over = {}) => {
		const f = path.join(base, 'config.json');
		writeFileSync(f, JSON.stringify({ ...cfgRaw, ...over }));
		return f;
	};
	world.labels = () => world.calls.map((c) => c.label);
	world.called = (l) => world.calls.some((c) => c.label === l);
	world.readState = () => JSON.parse(readFileSync(world.state, 'utf8'));
	world.writeLive = (rel, body) => w(path.join(world.live, rel), body);
	world.readText = (p) => readFileSync(p, 'utf8');
	world.exists = existsSync;
	world.ls = (p) => readdirSync(p).sort();
	world.mode = (p) => statSync(p).mode & 0o777;
	world.write = w;
	return world;
}
