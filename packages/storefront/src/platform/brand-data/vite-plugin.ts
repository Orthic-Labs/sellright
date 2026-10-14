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

/** One open descriptor: O_NOFOLLOW rejects a symlink at open, fstat checks the file kind, and the read uses the same descriptor (no check-then-use gap). */
function readJsonFile(file: string, label: string, problems: BrandDataProblem[]): unknown | null {
	let fd: number;
	try {
		fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
	} catch (e) {
		const code = (e as NodeJS.ErrnoException).code;
		if (code === 'ENOENT') return null;
		if (code === 'ELOOP') { problems.push({ file: label, message: 'must be a regular file (no symlink or directory)' }); return null; }
		throw e;
	}
	try {
		if (!fs.fstatSync(fd).isFile()) { problems.push({ file: label, message: 'must be a regular file (no symlink or directory)' }); return null; }
		return JSON.parse(fs.readFileSync(fd, 'utf8'));
	} catch (e) {
		problems.push({ file: label, message: `is not valid JSON: ${(e as Error).message}` });
		return null;
	} finally {
		fs.closeSync(fd);
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
		problems.push(...validateRoutesData(routes, { routeDirs: listRouteDirs(root), hasContentView: fs.existsSync(path.join(slotsDir, 'route.content.tsx')), hasShopView: fs.existsSync(path.join(slotsDir, 'route.shop.tsx')), hasProductView: fs.existsSync(path.join(slotsDir, 'route.product.tsx')) }));
	}
	for (const spec of mediaImports(head)) {
		const file = path.join(root, 'src', spec.slice(2, spec.indexOf('?')));
		if (!fs.existsSync(file)) problems.push({ file: 'src/brand/head.json', message: `imagePreloads: ${spec} names no file` });
	}
	if (problems.length) throw new BrandDataValidationError(problems);
	return { head, routes };
}

const isMediaImport = (href: unknown): href is string => typeof href === 'string' && href.startsWith('~/brand/media/');

/** The brand media import specifiers of head.json imagePreloads, in order, without duplicates. */
export function mediaImports(head: unknown): string[] {
	const out: string[] = [];
	for (const im of ((head as { imagePreloads?: { srcset?: { href?: unknown }[] }[] } | null)?.imagePreloads ?? [])) {
		for (const s of im.srcset ?? []) if (isMediaImport(s.href) && !out.includes(s.href)) out.push(s.href);
	}
	return out;
}

/**
 * Source of the virtual module. Both values are validated JSON (or null), so JSON.stringify is the whole serialisation, except a
 * brand media import in imagePreloads (`~/brand/media/hero.png?format=avif&w=768&url`): it becomes an import of that asset, so the
 * preload names the same build-hashed URL the brand view's own import of the same specifier renders.
 */
export function renderBrandDataModule(data: BrandDataSources, opts: { srcDir?: string } = {}): string {
	const imports = mediaImports(data.head);
	// The `~` alias is a tsconfig path, which a virtual module does not get: the import names the file under src/ directly.
	const target = (spec: string) => (opts.srcDir ? `${path.join(opts.srcDir, spec.slice(2, spec.indexOf('?')))}${spec.slice(spec.indexOf('?'))}` : spec);
	const head = data.head === null ? null : JSON.parse(JSON.stringify(data.head), (key, value) => (key === 'href' && isMediaImport(value) ? `\u0000media${imports.indexOf(value)}` : value));
	const headSource = JSON.stringify(head).replace(/"\\u0000media(\d+)"/g, (_m, i: string) => `__brandMedia${i}`);
	const lines = imports.map((spec, i) => `import __brandMedia${i} from ${JSON.stringify(target(spec))};`);
	return `${lines.length ? `${lines.join('\n')}\n` : ''}export const brandHead = ${headSource};\nexport const brandRoutes = ${JSON.stringify(data.routes)};\n`;
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
			return renderBrandDataModule(loadBrandData(root, dataDir, slotsDir), { srcDir: path.join(root, 'src') });
		},
	};
}
