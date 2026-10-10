// Tree readers for the union inventory: the brand build directory (everything on disk) and the base
// (a package directory, a repo-layout directory, or a pinned git archive). Read only: nothing here writes.
//
// Both readers return Map<composedRelPath, { abs, size, sha256, ... }> keyed the way the composed tree is laid out
// (base `packages/storefront/**` at the root, `packages/storefront-client/**` under `vendor/storefront-client/`).
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { openBase } from '../compose/lib/base.mjs';
import { ComposeError, fileSha, isRuntimeName, realDir } from '../compose/lib/util.mjs';

export const DEFAULT_REPO = '/home/vendure/sites/sellright';
const DUMMY_PIN = '0'.repeat(40);
/** Bytes read for content analysis; larger files are compared by hash only. */
export const MAX_TEXT_BYTES = 2 * 1024 * 1024;

const isEnvName = (name) => name.startsWith('.env');

/**
 * Every path in a brand build directory: tracked and untracked alike, excluding only `node_modules` (any depth) and
 * the top-level `dist*`, `server*` and `.git`. `.env*` files are listed by name and size only and never read. The
 * other top-level runtime names (`tmp`, `.cache`) are listed as one row each and not walked (A25a). Symlinks and special
 * files are rows of their own (never followed, never hashed).
 */
export function walkBrand(root) {
	const files = new Map();
	const visit = (dirAbs, dirRel) => {
		for (const name of readdirSync(dirAbs).sort()) {
			const rel = dirRel ? `${dirRel}/${name}` : name;
			const abs = path.join(dirAbs, name);
			const top = !dirRel;
			if (name === 'node_modules') continue;
			if (top && (name.startsWith('dist') || name.startsWith('server') || name === '.git')) continue;
			const st = lstatSync(abs);
			if (top && isRuntimeName(name)) {
				files.set(rel, { abs, size: st.isFile() ? st.size : null, sha256: null, kind: 'runtime', runtime: true, env: isEnvName(name) });
				continue;
			}
			if (st.isSymbolicLink()) files.set(rel, { abs, size: null, sha256: null, kind: 'symlink', runtime: false, env: false });
			else if (st.isDirectory()) visit(abs, rel);
			else if (st.isFile()) {
				const env = isEnvName(name);
				files.set(rel, { abs, size: st.size, sha256: env ? null : fileSha(abs), kind: 'file', runtime: false, env });
			} else files.set(rel, { abs, size: null, sha256: null, kind: 'special', runtime: false, env: false });
		}
	};
	visit(realDir(root, 'brand dir'), '');
	return files;
}

function packageWalkSkip(rel) {
	const name = rel.split('/').at(-1);
	const top = !rel.includes('/');
	if (name === 'node_modules' || name === '.git' || isEnvName(name)) return true;
	if (top && (name.startsWith('dist') || name.startsWith('server') || name === '.cache' || name === 'test-results' || name === 'tmp')) return true;
	if (rel === 'e2e/.run') return true;
	return rel === 'tools' || rel.startsWith('tools/');
}

function walkPackage(root) {
	const files = new Map();
	const visit = (dirAbs, dirRel) => {
		for (const name of readdirSync(dirAbs).sort()) {
			const rel = dirRel ? `${dirRel}/${name}` : name;
			if (packageWalkSkip(rel)) continue;
			const abs = path.join(dirAbs, name);
			const st = lstatSync(abs);
			if (st.isSymbolicLink()) throw new ComposeError('symlink', `symlink in base tree: ${rel}`);
			if (st.isDirectory()) visit(abs, rel);
			else if (st.isFile()) files.set(rel, { abs, size: st.size, sha256: fileSha(abs) });
		}
	};
	visit(root, '');
	return files;
}

/**
 * The base as a composed-path map. Sources, in order: a pinned git archive (`pin`, optional `repo`), a repo-layout
 * directory (holds `packages/storefront`), or a storefront package directory (holds `package.json`).
 * Returns { files, read(rel), cleanup(), label }.
 */
export function loadBaseTree({ baseDir, repo, pin }) {
	if (pin) {
		const b = openBase({ repo: repo ?? DEFAULT_REPO, pin });
		return wrap(b, `git ${pin.slice(0, 12)}`);
	}
	if (!baseDir) throw new ComposeError('bad-args', '--base <dir> or --pin <sha> is required');
	const root = realDir(baseDir, 'base dir');
	if (existsSync(path.join(root, 'packages/storefront/package.json'))) return wrap(openBase({ baseDir: root, pin: DUMMY_PIN }), root);
	if (!existsSync(path.join(root, 'package.json'))) throw new ComposeError('bad-base', `${root} is neither a repo root with packages/storefront nor a storefront package directory (no package.json)`);
	const files = walkPackage(root);
	return { files, read: (rel) => (files.has(rel) ? readFileSync(files.get(rel).abs) : null), cleanup() {}, label: root };
}

function wrap(b, label) {
	const files = new Map();
	for (const [rel, f] of b.files) files.set(rel, { abs: f.abs, size: lstatSize(f.abs), sha256: b.hash(rel) });
	return { files, read: (rel) => b.read(rel), cleanup: () => b.cleanup(), label };
}

const lstatSize = (abs) => lstatSync(abs).size;

/** Text of a file for analysis; null when it is not a regular file, is too large, or looks binary. */
export function readText(info) {
	if (!info || info.kind === 'symlink' || info.kind === 'special' || info.kind === 'runtime' || info.env) return null;
	if (info.size === null || info.size > MAX_TEXT_BYTES) return null;
	const buf = readFileSync(info.abs);
	if (buf.subarray(0, 8000).includes(0)) return null;
	return buf.toString('utf8');
}

/** git facts about a build directory, read-only (`--no-optional-locks`: `status` never refreshes the index). */
export function gitInfo(dir) {
	const run = (args) =>
		spawnSync('git', ['--no-optional-locks', '-C', dir, ...args], { encoding: 'utf8', maxBuffer: 1 << 28, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
	const inside = run(['rev-parse', '--is-inside-work-tree']);
	if (inside.error || inside.status !== 0 || inside.stdout.trim() !== 'true') return { inside: false, tracked: new Set(), dirty: [] };
	const ls = run(['ls-files', '-z', '--', '.']);
	const st = run(['status', '--porcelain', '--untracked-files=all', '--', '.']);
	return {
		inside: true,
		tracked: new Set(ls.stdout.split('\0').filter(Boolean)),
		dirty: st.stdout.split('\n').filter(Boolean),
	};
}
