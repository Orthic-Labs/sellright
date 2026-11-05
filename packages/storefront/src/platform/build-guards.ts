import { spawnSync } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Plugin } from 'vite';

// Build guards that live in the client build itself, so no brand build script (which runs the package scripts one by one, not
// `pnpm build`) can skip them:
//   - brand perf checks (scripts/check-brand-perf.mjs) before anything is bundled;
//   - the CSS gate after the bundle is written: the global stylesheet (dist*/build/style-*.css, src/global.css) must define
//     --brand-font-display, and must carry @font-face when the brand ships src/brand/fonts.css. bedbed29 put @source lines before
//     `@import './brand/tokens.css'`; an @import after another statement is invalid and dropped, so every brand token and font
//     vanished and the build still passed. The license flow has no global stylesheet (noGlobalCssPlugin) and is exempt.

export const GLOBAL_CSS_RE = /^style-[\w-]+\.css$/;
// Built from parts so the token inventory (scripts/token-inventory.mjs) does not read this file as a declaration.
const DISPLAY_TOKEN = ['--brand', 'font', 'display'].join('-');

/** `emitted`: the build/ file names this bundle wrote (a stale stylesheet left in dist/ by an earlier build must not count). */
export async function checkGlobalCss(outDir: string, root: string, emitted?: string[]): Promise<string[]> {
	const buildDir = join(outDir, 'build');
	let names: string[];
	try {
		names = (emitted ?? (await fs.readdir(buildDir))).filter((n) => GLOBAL_CSS_RE.test(n));
	} catch {
		names = [];
	}
	if (names.length === 0) return [`no global stylesheet (build/style-*.css) in ${outDir}: src/global.css was not emitted`];
	const css = (await Promise.all(names.map((n) => fs.readFile(join(buildDir, n), 'utf8')))).join('\n');
	const errors: string[] = [];
	if (!new RegExp(`${DISPLAY_TOKEN}\\s*:`).test(css)) {
		errors.push(`${names.join(', ')} does not define ${DISPLAY_TOKEN}: the brand tokens import (src/brand/tokens.css) was dropped from src/global.css (an @import after any other statement, e.g. @source, is ignored)`);
	}
	if (existsSync(join(root, 'src/brand/fonts.css')) && !/@font-face\b/.test(css)) {
		errors.push(`${names.join(', ')} has no @font-face although src/brand/fonts.css exists: the brand font faces were dropped from the global stylesheet`);
	}
	return errors;
}

export function buildGuardsPlugin(options: { commerceFlow: string }): Plugin {
	let root = '';
	let outDir = '';
	let ssr = false;
	let written: string[] | null = null;
	return {
		name: 'sellright:build-guards',
		apply: 'build',
		enforce: 'post',
		configResolved(c) {
			root = c.root;
			// resolve, not join: Qwik sets an absolute build.outDir (see precompress.ts).
			outDir = resolve(c.root, c.build.outDir);
			ssr = !!c.build.ssr;
		},
		buildStart() {
			written = null;
			if (ssr) return;
			const script = join(root, 'scripts/check-brand-perf.mjs');
			if (!existsSync(script)) {
				this.warn(`brand perf checks skipped: ${script} is missing`);
				return;
			}
			const r = spawnSync(process.execPath, [script, '--root', root], { encoding: 'utf8' });
			const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
			if (r.status !== 0) this.error(`brand perf checks failed (scripts/check-brand-perf.mjs):\n${out || r.error?.message || `exit ${r.status}`}`);
			if (out) console.info(out);
		},
		writeBundle(_options, bundle) {
			written = Object.keys(bundle).filter((f) => f.startsWith('build/')).map((f) => f.slice('build/'.length));
		},
		async closeBundle() {
			// closeBundle also runs after a failed build: only a bundle that was written is checked (no masking the real error).
			if (ssr || options.commerceFlow === 'license' || written === null) return;
			const errors = await checkGlobalCss(outDir, root, written);
			if (errors.length > 0) throw new Error(`[css-gate] ${errors.join('\n[css-gate] ')}`);
			console.info(`[css-gate] ${outDir}: global stylesheet carries the brand tokens${existsSync(join(root, 'src/brand/fonts.css')) ? ' and font faces' : ''}`);
		},
	};
}
