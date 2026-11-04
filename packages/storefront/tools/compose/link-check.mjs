// #317 link check: a composed store must be self-contained. Every symlink in the tree (node_modules included) has to
// resolve inside the store, except declared externals, so a copy of the store never compiles against the original's files
// and one brand's `pnpm install` never rewrites tool shims another brand (or the SellRight checkout) uses.
//
//   node link-check.mjs <storeDir> [--external <absPrefix>]... [--json]
//
// Fails (exit 1) on:
//   absolute   a link whose target is an absolute path (a copy of the tree still points at the original), even when it
//              currently resolves inside the store;
//   escapes    a link whose resolved target is outside the store and outside every --external prefix.
// The pnpm store (node_modules/.pnpm links into the content-addressed store) is not special-cased: pnpm writes relative
// links inside node_modules, and package files are hard links, not symlinks.
import { lstatSync, readdirSync, readlinkSync } from 'node:fs';
import path from 'node:path';

const isInside = (root, p) => p === root || p.startsWith(root + path.sep);

/** Lists every symlink under root (never following one) with its raw and resolved target and what is wrong with it. */
export function checkLinks(root, { externals = [] } = {}) {
	root = path.resolve(root);
	const ext = externals.map((e) => path.resolve(e));
	const problems = [];
	let links = 0;
	const walk = (dir) => {
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const p = path.join(dir, e.name);
			if (e.isSymbolicLink()) {
				links++;
				const raw = readlinkSync(p);
				const target = path.resolve(path.dirname(p), raw);
				const rel = path.relative(root, p);
				const allowed = ext.some((x) => isInside(x, target));
				if (!isInside(root, target) && !allowed) problems.push({ kind: 'escapes', path: rel, target: raw });
				else if (path.isAbsolute(raw) && !allowed) problems.push({ kind: 'absolute', path: rel, target: raw });
			} else if (e.isDirectory()) {
				walk(p);
			}
		}
	};
	if (lstatSync(root).isSymbolicLink()) throw new Error(`store root ${root} is a symlink`);
	walk(root);
	return { ok: problems.length === 0, root, links, problems };
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const args = process.argv.slice(2);
	const externals = [];
	let root;
	let json = false;
	for (let i = 0; i < args.length; i++) {
		if (args[i] === '--external') externals.push(args[++i]);
		else if (args[i] === '--json') json = true;
		else root = args[i];
	}
	if (!root) {
		console.error('usage: link-check.mjs <storeDir> [--external <absPrefix>]... [--json]');
		process.exit(2);
	}
	const r = checkLinks(root, { externals });
	if (json) console.log(JSON.stringify(r, null, 2));
	else {
		for (const p of r.problems) console.log(`${p.kind}\t${p.path} -> ${p.target}`);
		console.log(`${r.ok ? 'OK' : 'FAIL'}: ${r.links} links, ${r.problems.length} problems in ${r.root}`);
	}
	process.exit(r.ok ? 0 : 1);
}
