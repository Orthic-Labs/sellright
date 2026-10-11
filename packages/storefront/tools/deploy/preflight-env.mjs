#!/usr/bin/env node
// Environment preflight of the guarded build (plan A §4.6a c, finding C5).
//
//   preflight-env.mjs        exit 0, or exit 4 naming every offending variable
//
// A stray build selector would make the production build clean the live output and build somewhere else. Called
// by the entry before anything runs and again by the guarded inner build script. Names only, never values.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Exact names that change what or where the build writes (the selectors of the base configs and `build:demo`). */
export const FORBIDDEN_NAMES = ['SELLRIGHT_BUILD_SUFFIX', 'SELLRIGHT_DISABLE_SSG'];
/** Any name with one of these prefixes. */
export const FORBIDDEN_PREFIXES = ['VITE_', 'E2E_', 'PLAYWRIGHT_'];

/** Returns the offending variable names (sorted); `set` means present with any value, even empty. */
export function offendingNames(env = process.env) {
	const bad = [];
	for (const [k, v] of Object.entries(env)) {
		if (v === undefined) continue;
		if (FORBIDDEN_NAMES.includes(k) || FORBIDDEN_PREFIXES.some((p) => k.startsWith(p))) bad.push(k);
		else if (k === 'NODE_ENV' && v !== '' && v !== 'production') bad.push(k);
	}
	return bad.sort();
}

export function main(env = process.env, out = console) {
	const bad = offendingNames(env);
	if (!bad.length) return 0;
	out.error(`build environment refused: ${bad.join(', ')} must not be set for a deploy build`);
	return 4;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main());
