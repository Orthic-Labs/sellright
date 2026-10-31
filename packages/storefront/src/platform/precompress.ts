import { constants, brotliCompress, gzip } from 'node:zlib';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Plugin } from 'vite';

// Build-time precompression. Replaces two vite-plugin-compression instances: that plugin keeps a module-level
// mtime cache keyed by file path, so the second instance (brotli) saw every file as "already compressed" by the first
// (gzip) and wrote no .br at all. One pass here writes both siblings, brotli at quality 11 via the `params` form node
// requires (a bare `level` is ignored by zlib.brotliCompress).
export const PRECOMPRESS_FILTER = /\.(js|mjs|json|css|svg)$/i;
export const PRECOMPRESS_THRESHOLD = 1024;

export const GZIP_OPTIONS = { level: 9 } as const;
export const BROTLI_OPTIONS = {
	params: {
		[constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
		[constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
	},
} as const;

const gzipAsync = promisify(gzip);
const brotliAsync = promisify(brotliCompress);

async function* walk(dir: string): AsyncGenerator<string> {
	for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
		const p = join(dir, entry.name);
		if (entry.isDirectory()) yield* walk(p);
		else if (entry.isFile()) yield p;
	}
}

export async function precompressDir(dir: string, concurrency = 4): Promise<{ files: number }> {
	const queue: string[] = [];
	try {
		for await (const f of walk(dir)) if (PRECOMPRESS_FILTER.test(f)) queue.push(f);
	} catch {
		return { files: 0 };
	}
	let files = 0;
	const worker = async () => {
		for (let f = queue.pop(); f !== undefined; f = queue.pop()) {
			const content = await fs.readFile(f);
			if (content.byteLength < PRECOMPRESS_THRESHOLD) continue;
			const [gz, br] = await Promise.all([gzipAsync(content, GZIP_OPTIONS), brotliAsync(content, BROTLI_OPTIONS)]);
			await Promise.all([fs.writeFile(`${f}.gz`, gz), fs.writeFile(`${f}.br`, br)]);
			files++;
		}
	};
	await Promise.all(Array.from({ length: concurrency }, worker));
	return { files };
}

export function precompressPlugin(): Plugin {
	let outDir = '';
	return {
		name: 'sellright:precompress',
		apply: 'build',
		enforce: 'post',
		configResolved(c) {
			outDir = join(c.root, c.build.outDir);
		},
		async closeBundle() {
			const { files } = await precompressDir(outDir);
			if (files) console.info(`[precompress] ${files} files -> .gz (level 9) + .br (q11)`);
		},
	};
}
