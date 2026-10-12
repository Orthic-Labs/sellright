// Vite plugin behind `virtual:sellright-brand-data` (plan §1). At build start it reads src/brand/head.json and
// src/brand/routes.json (override the directory with SELLRIGHT_BRAND_DATA_DIR, relative to the package root), validates them
// and throws on any problem (the build fails). A missing file means today's defaults. Node only; loaded from vite.config.ts.
import fs from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';
import { validateHeadData, validateRoutesData, type BrandDataProblem } from './validate';

export const BRAND_DATA_VIRTUAL_ID = 'virtual:sellright-brand-data';
export const DEFAULT_BRAND_DATA_DIR = 'src/brand';

export class BrandDataValidationError extends Error {
	constructor(public readonly problems: BrandDataProblem[]) {
		super(`brand data rejected:\n${problems.map((p) => `  ${p.file}: ${p.message}`).join('\n')}`);
		this.name = 'BrandDataValidationError';
	}
}

export interface BrandDataSources {
	head: unknown | null;
	routes: unknown | null;
}

function readJsonFile(file: string, label: string, problems: BrandDataProblem[]): unknown | null {
	if (!fs.existsSync(file)) return null;
	const st = fs.lstatSync(file);
	if (!st.isFile()) { problems.push({ file: label, message: 'must be a regular file (no symlink or directory)' }); return null; }
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch (e) {
		problems.push({ file: label, message: `is not valid JSON: ${(e as Error).message}` });
		return null;
	}
}

/** Top-level directory names of `<root>/src/routes`. */
export function listRouteDirs(root: string): string[] {
	const dir = path.join(root, 'src/routes');
	if (!fs.existsSync(dir)) return [];
	return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
}

/** Reads and validates the brand data of a package root. Throws BrandDataValidationError listing every problem. */
export function loadBrandData(root: string, dataDir: string, slotsDir: string): BrandDataSources {
	const problems: BrandDataProblem[] = [];
	const head = readJsonFile(path.join(dataDir, 'head.json'), 'src/brand/head.json', problems);
	const routes = readJsonFile(path.join(dataDir, 'routes.json'), 'src/brand/routes.json', problems);
	if (head !== null && problems.length === 0) problems.push(...validateHeadData(head));
	if (routes !== null && problems.every((p) => p.file !== 'src/brand/routes.json')) {
		problems.push(...validateRoutesData(routes, { routeDirs: listRouteDirs(root), hasContentView: fs.existsSync(path.join(slotsDir, 'route.content.tsx')) }));
	}
	if (problems.length) throw new BrandDataValidationError(problems);
	return { head, routes };
}

/** Source of the virtual module. Both values are validated JSON (or null), so JSON.stringify is the whole serialisation. */
export function renderBrandDataModule(data: BrandDataSources): string {
	return `export const brandHead = ${JSON.stringify(data.head)};\nexport const brandRoutes = ${JSON.stringify(data.routes)};\n`;
}

export function brandDataPlugin(options: { dataDir?: string; slotsDir?: string } = {}): Plugin {
	const resolved = `\0${BRAND_DATA_VIRTUAL_ID}`;
	let root = '';
	let dataDir = '';
	let slotsDir = '';
	return {
		name: 'sellright-brand-data',
		enforce: 'pre',
		configResolved(config) {
			root = config.root;
			dataDir = path.resolve(root, options.dataDir ?? process.env.SELLRIGHT_BRAND_DATA_DIR ?? DEFAULT_BRAND_DATA_DIR);
			slotsDir = path.resolve(root, options.slotsDir ?? process.env.SELLRIGHT_BRAND_SLOTS_DIR ?? 'src/brand-slots');
		},
		buildStart() {
			loadBrandData(root, dataDir, slotsDir);
		},
		resolveId(id) {
			return id === BRAND_DATA_VIRTUAL_ID ? resolved : null;
		},
		load(id) {
			if (id !== resolved) return null;
			for (const f of ['head.json', 'routes.json']) if (fs.existsSync(path.join(dataDir, f))) this.addWatchFile(path.join(dataDir, f));
			return renderBrandDataModule(loadBrandData(root, dataDir, slotsDir));
		},
	};
}
