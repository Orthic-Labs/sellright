#!/usr/bin/env node
// A16 eject drift tool. Shows, per L2 eject and per patched script key, the old base
// (checked against baseSnapshotHash), the new base and the brand's override with two
// real `git diff --no-index -U3` diffs, and resolves a drifted eject:
//
//   drift.mjs <brand-layer-dir> [--pin <sha>] [--base-dir <dir> | --repo <git repo>] [--layers <layers.json>]
//             [--accept <path|package.json#scripts.key> --resolution <text>]
//             [--readopt <path|package.json#scripts.key> [--resolution <text>]]
//             [--migrate <old-path> <new-path>]
//
// With no action it prints the report and exits 1 while any eject is changed, orphaned
// or has a tampered snapshot. The compose gate itself lives in tools/compose
// (lib/drift-core.mjs, called from compose.mjs step 2); this file is the operator's CLI.
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBase } from '../compose/lib/base.mjs';
import { accept, checkDrift, describeDrift, entryId, formatDriftReport, migrate, readopt } from '../compose/lib/drift-core.mjs';
import { acquireLock } from '../compose/lib/journal.mjs';
import { loadLayer, validateBrand } from '../compose/lib/layer.mjs';
import { loadLayers, parseLayers } from '../compose/lib/layers.mjs';
import { ComposeError, Problems } from '../compose/lib/util.mjs';

function parse(argv) {
	const a = { positional: [], values: {}, migrate: null };
	for (let i = 0; i < argv.length; i++) {
		const x = argv[i];
		if (x === '--migrate') {
			a.migrate = [argv[i + 1], argv[i + 2]];
			i += 2;
		} else if (['--pin', '--base-dir', '--repo', '--layers', '--accept', '--resolution', '--readopt'].includes(x)) {
			if (argv[i + 1] === undefined) throw new ComposeError('bad-args', `${x} needs a value`);
			a.values[x] = argv[++i];
		} else if (x.startsWith('--')) throw new ComposeError('bad-args', `unknown option ${x}`);
		else a.positional.push(x);
	}
	return a;
}

export async function main(argv, { out = (s) => process.stdout.write(s), now = new Date() } = {}) {
	const a = parse(argv);
	const [layerDir] = a.positional;
	if (!layerDir) {
		out('usage: drift.mjs <brand-layer-dir> [--pin sha] [--base-dir d | --repo r] [--layers f] [--accept id --resolution text | --readopt id | --migrate old new]\n');
		return 2;
	}
	const layer = loadLayer(layerDir);
	const problems = new Problems();
	validateBrand(layer.brand, problems);
	problems.throwIfAny();
	const pin = a.values['--pin'] ?? layer.brand.pin;
	const base = openBase({ baseDir: a.values['--base-dir'], repo: a.values['--repo'] ?? '/home/vendure/sites/sellright', pin, baseExclude: layer.brand.baseExclude });
	try {
		let layers = null;
		if (a.values['--layers']) layers = loadLayers(a.values['--layers']);
		else if (base.read('layers.json')) layers = parseLayers(JSON.parse(base.read('layers.json').toString('utf8')));

		// accept, readopt and migrate rewrite the brand layer, which is an input of every compose and build: they take the same locks
		// (deployment lock, then compose lock) as any other writer of the brand repo and are refused (ComposeError locked) while one runs
		const locked = async (fn) => {
			const release = await acquireLock(path.dirname(realpathSync(layer.dir)));
			try {
				return await fn();
			} finally {
				await release();
			}
		};
		if (a.values['--accept'] !== undefined) {
			const r = await locked(() => accept({ layerDir: layer.dir, base, pin, id: a.values['--accept'], text: a.values['--resolution'], now }));
			out(`accepted ${r.id} (new base ${r.baseHash.slice(0, 12)} at pin ${pin.slice(0, 12)})\n`);
			return 0;
		}
		if (a.values['--readopt'] !== undefined) {
			const r = await locked(() => readopt({ layerDir: layer.dir, pin, id: a.values['--readopt'], text: a.values['--resolution'] ?? 'readopted base', now }));
			out(`readopted ${r.id}: the override is removed and the base is used again\n`);
			return 0;
		}
		if (a.migrate) {
			if (!a.migrate[0] || !a.migrate[1]) throw new ComposeError('bad-args', '--migrate needs <old> <new>');
			if (!layers) throw new ComposeError('missing-file', '--migrate needs layers (--layers or a layers.json in the base)');
			const r = await locked(() => migrate({ layerDir: layer.dir, layers, base, pin, from: a.migrate[0], to: a.migrate[1], now }));
			out(`migrated eject to ${r.id}; review the moved override against the new base\n`);
			return 0;
		}

		const gate = new Problems();
		checkDrift({ layer, base, pin, problems: gate });
		const ejects = (layer.manifest.entries ?? []).filter((e) => e.layer === 'L2' || e.kind === 'package-script');
		const details = ejects.map((entry) => describeDrift({ entry, layer, base }));
		out(formatDriftReport(details, pin));
		for (const p of gate.list) out(`[${p.code}] ${p.message}\n`);
		out(`${ejects.length} eject(s), ${gate.list.length} problem(s)\n`);
		return gate.any ? 1 : 0;
	} finally {
		base.cleanup();
	}
}

export { entryId };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main(process.argv.slice(2)).then(
		(c) => process.exit(c),
		(e) => {
			console.error(e instanceof ComposeError ? e.message : e.stack);
			process.exit(1);
		},
	);
}
