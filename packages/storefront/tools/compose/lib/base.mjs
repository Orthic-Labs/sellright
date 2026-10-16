// Base provider: the pinned SellRight sources, mapped onto composed-tree paths.
//
//   packages/storefront/**        -> <composed>/**
//   packages/storefront-client/** -> <composed>/vendor/storefront-client/**
//   tsconfig.base.json            -> <composed>/tsconfig.base.json
// `pnpm-workspace.yaml` and `pnpm-lock.yaml` of the pin's repo root are read as
// inputs (workspace hardening settings, lock equivalence) but never copied.
//
// Two sources: `baseDir` (an already extracted tree, read only, used by the
// tests and by `--base-dir`) or `repo` + `pin` (git archive of the pin into a
// temp directory outside every repo). Nothing under baseDir or repo is written.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { makeTempDir, removeTree } from './durable.mjs';
import { ComposeError, PIN_RE, realDir, sha256, treeHash, walkFiles } from './util.mjs';

export const STOREFRONT_SRC = 'packages/storefront';
export const CLIENT_SRC = 'packages/storefront-client';
export const CLIENT_DEST = 'vendor/storefront-client';
const ARCHIVE_PATHS = [STOREFRONT_SRC, CLIENT_SRC, 'tsconfig.base.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml'];
export const DEFAULT_BASE_EXCLUDE = ['tools'];

function rootLevelSkip(name) {
	return name.startsWith('dist') || name.startsWith('server') || name === '.cache' || name === 'test-results' || name === 'tmp';
}

function makeSkip(prefix, baseExclude) {
	return (rel) => {
		const name = rel.split('/').at(-1);
		const top = !rel.includes('/');
		if (name === 'node_modules' || name.startsWith('.env')) return true;
		if (top && rootLevelSkip(name)) return true;
		if (rel === 'e2e/.run') return true;
		const composed = prefix + rel;
		return baseExclude.some((x) => composed === x || composed.startsWith(`${x}/`));
	};
}

function git(args, opts = {}) {
	const r = spawnSync('git', args, { maxBuffer: 1 << 30, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, ...opts });
	if (r.error) throw new ComposeError('git', `git ${args[0]} failed to start: ${r.error.message}`);
	return r;
}

export function assertPinExists(repo, pin) {
	if (!PIN_RE.test(pin ?? '')) throw new ComposeError('bad-pin', `pin must be a full 40-character lowercase SHA, got ${JSON.stringify(pin)}`);
	const r = git(['-C', repo, 'cat-file', '-e', `${pin}^{commit}`]);
	if (r.status !== 0) throw new ComposeError('bad-pin', `pin ${pin} does not exist in ${repo}`);
}

/**
 * @param {{ baseDir?: string, repo?: string, pin: string, baseExclude?: string[] }} opts
 */
export function openBase(opts) {
	const { baseDir, repo, pin } = opts;
	const baseExclude = opts.baseExclude ?? DEFAULT_BASE_EXCLUDE;
	if (!PIN_RE.test(pin ?? '')) throw new ComposeError('bad-pin', `pin must be a full 40-character lowercase SHA, got ${JSON.stringify(pin)}`);
	let root;
	let temp = null;
	if (baseDir) {
		root = realDir(baseDir, 'base dir');
	} else {
		if (!repo) throw new ComposeError('bad-args', 'either baseDir or repo is required');
		assertPinExists(repo, pin);
		temp = makeTempDir('compose-base-');
		const arc = git(['-C', repo, 'archive', '--format=tar', pin, ...ARCHIVE_PATHS]);
		if (arc.status !== 0) {
			removeTree(temp);
			throw new ComposeError('git-archive', `git archive ${pin} failed: ${String(arc.stderr).trim()}`);
		}
		const tar = spawnSync('tar', ['-x', '-C', temp], { input: arc.stdout, maxBuffer: 1 << 26 });
		if (tar.status !== 0) {
			removeTree(temp);
			throw new ComposeError('git-archive', `tar extract failed: ${String(tar.stderr).trim()}`);
		}
		root = realDir(temp, 'base temp dir');
	}

	/** composed path -> { abs, mode } */
	const files = new Map();
	const add = (composedRel, abs, mode) => files.set(composedRel, { abs, mode });
	try {
		const sf = realDir(path.join(root, STOREFRONT_SRC), 'base packages/storefront');
		for (const f of walkFiles(sf, makeSkip('', baseExclude))) add(f.rel, f.abs, f.mode);
		const cl = realDir(path.join(root, CLIENT_SRC), 'base packages/storefront-client');
		for (const f of walkFiles(cl, makeSkip(`${CLIENT_DEST}/`, baseExclude))) add(`${CLIENT_DEST}/${f.rel}`, f.abs, f.mode);
		const tsb = walkFiles(root, (rel) => rel !== 'tsconfig.base.json').filter((f) => f.rel === 'tsconfig.base.json');
		for (const f of tsb) add('tsconfig.base.json', f.abs, f.mode);
	} catch (e) {
		if (temp) removeTree(temp);
		throw e;
	}
	if (!files.has('package.json') || !files.has('tsconfig.base.json')) {
		if (temp) removeTree(temp);
		throw new ComposeError('bad-base', 'base lacks packages/storefront/package.json or tsconfig.base.json');
	}

	const shaCache = new Map();
	const read = (rel) => {
		const f = files.get(rel);
		return f ? readFileSync(f.abs) : null;
	};
	const hash = (rel) => {
		if (!shaCache.has(rel)) {
			const b = read(rel);
			shaCache.set(rel, b === null ? null : sha256(b));
		}
		return shaCache.get(rel);
	};
	const readRoot = (name) => {
		try {
			return readFileSync(path.join(root, name));
		} catch {
			return null;
		}
	};
	let tree = null;
	return {
		pin,
		root,
		files,
		read,
		hash,
		has: (rel) => files.has(rel),
		readRoot,
		get treeHash() {
			tree ??= treeHash([...files.keys()].map((k) => [k, hash(k)]));
			return tree;
		},
		cleanup() {
			if (temp) removeTree(temp);
		},
	};
}
