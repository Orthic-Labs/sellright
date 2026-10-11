// First-adoption inventory (A25a) and the adoption guard (§4.3 step 3).
//
// Inventory file (adoption-inventory.json):
//   { version: 1, status: 'ok'|'blocked-dirty', legacyTag, legacyCommit,
//     legacyTreePaths: [paths of the legacy tag's build-directory tree],
//     preservedNames: [extra runtime-preserved names, beyond the built-in list],
//     rows: [{ path, size, sha256, class, disposition?, reason? }],
//     retire: [paths] }
// Row classes: identical, superseded, dropped, brand-l3, runtime-preserved, unexplained.
// Runtime-preserved top-level names are listed by name only (never walked, never
// followed). Any `.env*` file is listed by name and size only and is never read.
import { lstatSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { ComposeError, fileSha, isRuntimeName, walkFiles } from './util.mjs';

export const INVENTORY_CLASSES = ['identical', 'superseded', 'dropped', 'brand-l3', 'runtime-preserved', 'unexplained'];

const isEnvFile = (rel) => rel.split('/').at(-1).startsWith('.env');

/** path -> { size, sha256 | null, preserved } for the build directory, without following symlinks. */
export function scanBuildDir(outDir, extraPreserved = []) {
	const extra = new Set(extraPreserved);
	const rows = new Map();
	let names;
	try {
		names = readdirSync(outDir).sort();
	} catch {
		return rows;
	}
	for (const name of names) {
		const abs = path.join(outDir, name);
		const st = lstatSync(abs);
		if (isRuntimeName(name) || extra.has(name)) {
			rows.set(name, { size: st.isFile() ? st.size : null, sha256: null, preserved: true });
			continue;
		}
		if (st.isSymbolicLink()) throw new ComposeError('symlink', `symlink in build directory: ${name}`);
		if (st.isFile()) {
			rows.set(name, { size: st.size, sha256: isEnvFile(name) ? null : fileSha(abs), preserved: false });
		} else if (st.isDirectory()) {
			for (const f of walkFiles(abs)) {
				const rel = `${name}/${f.rel}`;
				rows.set(rel, { size: f.size, sha256: isEnvFile(rel) ? null : fileSha(f.abs), preserved: false });
			}
		} else throw new ComposeError('special-file', `non-regular file in build directory: ${name}`);
	}
	return rows;
}

/** True when the directory holds anything beyond the runtime-preserved names (a legacy or foreign tree). */
export function hasNonRuntimeContent(outDir) {
	let names;
	try {
		names = readdirSync(outDir);
	} catch {
		return false;
	}
	return names.some((n) => !isRuntimeName(n));
}

/**
 * @param {{ outDir: string, composed: Map<string,string>, dispositions?: object, preserved?: string[],
 *           tracked?: Set<string>|null, legacyTreePaths?: string[], legacyTag?: string, legacyCommit?: string, dirty?: boolean }} o
 * dispositions: { "<path>": { class: 'superseded'|'dropped'|'brand-l3', reason: string } }
 */
export function buildInventory(o) {
	const scan = scanBuildDir(o.outDir, o.preserved ?? []);
	const dispositions = o.dispositions ?? {};
	const rows = [];
	const retire = [];
	for (const [p, info] of [...scan].sort(([a], [b]) => (a < b ? -1 : 1))) {
		const row = { path: p, size: info.size, sha256: info.sha256 };
		if (info.preserved) {
			row.class = 'runtime-preserved';
		} else if (info.sha256 !== null && o.composed.get(p) === info.sha256) {
			row.class = 'identical';
		} else {
			const d = dispositions[p];
			if (d && ['superseded', 'dropped', 'brand-l3'].includes(d.class) && typeof d.reason === 'string' && d.reason) {
				row.class = d.class;
				row.disposition = d.class;
				row.reason = d.reason;
				if (d.class !== 'brand-l3' && !o.composed.has(p) && o.tracked?.has(p) && !isEnvFile(p)) retire.push(p);
				else if (d.class !== 'brand-l3' && !o.composed.has(p)) row.reason += ' (not retired: not a tracked legacy file)';
			} else {
				row.class = 'unexplained';
			}
		}
		rows.push(row);
	}
	return {
		version: 1,
		status: o.dirty ? 'blocked-dirty' : 'ok',
		legacyTag: o.legacyTag ?? null,
		legacyCommit: o.legacyCommit ?? null,
		legacyTreePaths: [...(o.legacyTreePaths ?? [])].sort(),
		preservedNames: [...(o.preserved ?? [])].sort(),
		rows,
		retire: retire.sort(),
	};
}

export function validateInventoryShape(inv, problems) {
	if (!inv || inv.version !== 1 || !Array.isArray(inv.rows) || !Array.isArray(inv.retire) || !Array.isArray(inv.legacyTreePaths)) {
		problems.add('bad-inventory', 'inventory must be { version: 1, rows, retire, legacyTreePaths, ... }', 'adoption-inventory.json');
		return false;
	}
	for (const r of inv.rows) {
		if (!INVENTORY_CLASSES.includes(r.class)) problems.add('bad-inventory', `row ${r.path} has unknown class ${r.class}`, 'adoption-inventory.json');
	}
	return !problems.any;
}

/**
 * The adoption guard: the inventory must still match the directory exactly
 * (every path, size and sha256), carry no unexplained row, and its retire list may
 * only name tracked legacy files that are not runtime state and not in the composed set.
 */
export function checkAdoption({ inventory, outDir, composed, problems }) {
	if (!validateInventoryShape(inventory, problems)) return;
	if (inventory.status !== 'ok') problems.add('inventory-blocked', `inventory status is ${inventory.status}`, 'adoption-inventory.json');
	for (const r of inventory.rows) {
		if (r.class === 'unexplained') problems.add('inventory-unexplained', `unexplained path ${r.path}`, r.path);
	}
	const now = scanBuildDir(outDir, inventory.preservedNames ?? []);
	const rowByPath = new Map(inventory.rows.map((r) => [r.path, r]));
	for (const [p, info] of now) {
		const r = rowByPath.get(p);
		if (!r) {
			problems.add('inventory-stale', `path ${p} is not in the inventory`, p);
			continue;
		}
		if (info.preserved) continue;
		if (r.size !== info.size || r.sha256 !== info.sha256) problems.add('inventory-stale', `path ${p} differs from the inventory (size or sha256)`, p);
	}
	for (const r of inventory.rows) if (!now.has(r.path)) problems.add('inventory-stale', `inventory path ${r.path} no longer exists`, r.path);
	const legacy = new Set(inventory.legacyTreePaths);
	for (const p of inventory.retire) {
		const row = rowByPath.get(p);
		if (!row || !['superseded', 'dropped'].includes(row.class)) problems.add('retire-invalid', `${p} is on the retire list but is not a superseded or dropped row`, p);
		else if (!legacy.has(p)) problems.add('retire-invalid', `${p} is not a tracked legacy file, so the tag cannot restore it`, p);
		if (isRuntimeName(p.split('/')[0]) || isEnvFile(p)) problems.add('retire-invalid', `${p} is runtime state`, p);
		if (composed.has(p)) problems.add('retire-invalid', `${p} is in the composed set`, p);
	}
}
