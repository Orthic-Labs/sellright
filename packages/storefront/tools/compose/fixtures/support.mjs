// Shared helpers for the compose, drift and env tests. Not a test file.
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../lib/util.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BASE_FIXTURE = path.join(HERE, 'base-fixture');
export const BRAND_FIXTURE = path.join(HERE, 'brand-fixture');
export const PIN = '0123456789abcdef0123456789abcdef01234567';
export const PIN2 = 'fedcba9876543210fedcba9876543210fedcba98';

/** Same layering as Vite's loadEnv for the cases the tests need: .env < .env.local < .env.<mode> < .env.<mode>.local < process.env; no variable expansion. */
export function miniLoadEnv(mode, dir, prefix) {
	const out = {};
	for (const f of ['.env', '.env.local', `.env.${mode}`, `.env.${mode}.local`]) {
		const p = path.join(dir, f);
		if (!existsSync(p)) continue;
		for (const line of readFileSync(p, 'utf8').split('\n')) {
			const m = /^\s*(?:export\s+)?([A-Za-z_][\w.-]*)\s*=\s*(.*)$/.exec(line);
			if (!m || !m[1].startsWith(prefix)) continue;
			let v = m[2].trim();
			const q = /^(["'`])([\s\S]*)\1$/.exec(v);
			if (q) v = q[2].replace(/\\\$/g, '$');
			out[m[1]] = v;
		}
	}
	for (const [k, v] of Object.entries(process.env)) if (k.startsWith(prefix) && v !== undefined) out[k] = v;
	return out;
}

export function allFiles(dir) {
	const out = [];
	const visit = (d, rel) => {
		for (const n of readdirSync(d).sort()) {
			const abs = path.join(d, n);
			const r = rel ? `${rel}/${n}` : n;
			const st = lstatSync(abs);
			if (st.isDirectory()) visit(abs, r);
			else out.push(r);
		}
	};
	if (existsSync(dir)) visit(dir, '');
	return out;
}

/** path -> sha256 (or 'link' for symlinks), for byte-for-byte before/after comparisons. */
export function snapshot(dir) {
	const m = new Map();
	if (!existsSync(dir)) return m;
	const visit = (d, rel) => {
		for (const n of readdirSync(d).sort()) {
			const abs = path.join(d, n);
			const r = rel ? `${rel}/${n}` : n;
			const st = lstatSync(abs);
			if (st.isSymbolicLink()) m.set(r, 'link');
			else if (st.isDirectory()) visit(abs, r);
			else m.set(r, sha256(readFileSync(abs)));
		}
	};
	visit(dir, '');
	return m;
}

export const equalSnapshots = (a, b) => JSON.stringify([...a]) === JSON.stringify([...b]);

function makeWritable(dir) {
	if (!existsSync(dir)) return;
	const st = lstatSync(dir);
	if (st.isSymbolicLink()) return;
	chmodSync(dir, 0o755);
	if (st.isDirectory()) for (const n of readdirSync(dir)) makeWritable(path.join(dir, n));
	else chmodSync(dir, st.mode | 0o200);
}

/**
 * A scratch world:  <root>/base (read-only copy of base-fixture), <root>/brand/storefront (layer),
 * <root>/brand/store (build dir, not created), <root>/brand/.compose-history.
 */
export function makeWorld({ readOnlyBase = true } = {}) {
	const root = mkdtempSync(path.join(tmpdir(), 'compose-test-'));
	const base = path.join(root, 'base');
	const repo = path.join(root, 'brand');
	const layer = path.join(repo, 'storefront');
	const out = path.join(repo, 'store');
	cpSync(BASE_FIXTURE, base, { recursive: true });
	mkdirSync(repo);
	cpSync(BRAND_FIXTURE, layer, { recursive: true });
	const w = {
		root,
		base,
		repo,
		layer,
		out,
		opts: () => ({ layerDir: layer, outDir: out, baseDir: base, loadEnv: miniLoadEnv }),
		basePath: (rel) => path.join(base, 'packages/storefront', rel),
		layerPath: (rel) => path.join(layer, rel),
		outPath: (rel) => path.join(out, rel),
		write: (abs, text) => {
			mkdirSync(path.dirname(abs), { recursive: true });
			writeFileSync(abs, text);
		},
		readOnly: () => {
			const lock = (d) => {
				for (const n of readdirSync(d)) {
					const abs = path.join(d, n);
					const st = lstatSync(abs);
					if (st.isDirectory()) lock(abs);
					else chmodSync(abs, 0o444);
				}
				chmodSync(d, 0o555);
			};
			lock(base);
		},
		writable: () => makeWritable(base),
		cleanup: () => {
			makeWritable(root);
			rmSync(root, { recursive: true, force: true });
		},
	};
	if (readOnlyBase) w.readOnly();
	return w;
}

/** Plain edit of a (possibly read-only) base file. */
export function editBase(w, rel, fn) {
	w.writable();
	const f = w.basePath(rel);
	writeFileSync(f, fn(readFileSync(f, 'utf8')));
}
