// A17: Vite plugin behind `virtual:sellright-brand-slots`. At build start it reads the slot directory (default
// src/brand-slots, override with SELLRIGHT_BRAND_SLOTS_DIR, relative to the package root), validates every file with
// validateSlotFile and throws on the first problem list (the build fails). The virtual module statically imports each
// valid file, so there is no import.meta.glob and no dynamic import. A missing or empty directory yields `{}`.
// Node only; loaded from vite.config.ts, never bundled into the app.
import fs from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';
import { SLOT_NAMES, slotNameFromFile, type SlotName } from './registry';
import { validateSlotFile, type SlotProblem } from './validate';

export const SLOTS_VIRTUAL_ID = 'virtual:sellright-brand-slots';
export const DEFAULT_SLOTS_DIR = 'src/brand-slots';

export interface SlotEntry {
	name: SlotName;
	file: string;
}

export class SlotValidationError extends Error {
	constructor(public readonly problems: SlotProblem[]) {
		super(`brand slots rejected:\n${problems.map((p) => `  ${p.file}: ${p.message}`).join('\n')}`);
		this.name = 'SlotValidationError';
	}
}

/** Reads and validates `dir`. Throws SlotValidationError listing every problem; returns the entries sorted by slot name. */
export function discoverSlots(dir: string): SlotEntry[] {
	if (!fs.existsSync(dir)) return [];
	const problems: SlotProblem[] = [];
	const entries: SlotEntry[] = [];
	for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
		if (!ent.isFile() || ent.isSymbolicLink()) {
			problems.push({ file: ent.name, message: 'only regular slot files are allowed here (no directories or symlinks)' });
			continue;
		}
		const found = validateSlotFile(ent.name, fs.readFileSync(path.join(dir, ent.name), 'utf8'));
		if (found.length) problems.push(...found);
		else entries.push({ name: slotNameFromFile(ent.name) as SlotName, file: path.join(dir, ent.name) });
	}
	if (problems.length) throw new SlotValidationError(problems);
	return entries;
}

/** Source of the virtual module for the given entries. Order follows SLOT_NAMES so output is deterministic. */
export function renderSlotModule(entries: readonly SlotEntry[]): string {
	const byName = new Map(entries.map((e) => [e.name, e.file]));
	const ordered = SLOT_NAMES.filter((n) => byName.has(n));
	const imports = ordered.map((n, i) => `import slot${i} from ${JSON.stringify(byName.get(n))};`);
	const fields = ordered.map((n, i) => `  ${JSON.stringify(n)}: slot${i},`);
	return `${imports.join('\n')}\nexport const brandSlots = {\n${fields.join('\n')}\n};\n`;
}

export function brandSlotsPlugin(options: { slotsDir?: string } = {}): Plugin {
	const resolved = `\0${SLOTS_VIRTUAL_ID}`;
	let dir = '';
	return {
		name: 'sellright-brand-slots',
		enforce: 'pre',
		configResolved(config) {
			const rel = options.slotsDir ?? process.env.SELLRIGHT_BRAND_SLOTS_DIR ?? DEFAULT_SLOTS_DIR;
			dir = path.resolve(config.root, rel);
		},
		buildStart() {
			discoverSlots(dir);
		},
		resolveId(id) {
			return id === SLOTS_VIRTUAL_ID ? resolved : null;
		},
		load(id) {
			if (id !== resolved) return null;
			if (fs.existsSync(dir)) this.addWatchFile(dir);
			return renderSlotModule(discoverSlots(dir));
		},
	};
}
