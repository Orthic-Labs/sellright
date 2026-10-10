// A15 closure check: every script path the composed build calls must exist in the
// composed tree or be an external declared in brand.json "externals"; no script
// string may use `node -e|--eval|-p|--print`.
//
// Scanned: every `scripts` entry of the composed root package.json (after the
// packageScripts patches) and of vendor/storefront-client/package.json, plus the
// brand's build script (brand.json "buildScript"). Not resolved: binaries on the
// package path (vite, tsc, eslint, ...), and tokens containing shell variables;
// those are listed under `unresolved`.
import path from 'node:path';
import { Problems } from './lib/util.mjs';

const EVAL_FLAGS = /^(-e|--eval|-p|--print|-pe|-ep|--eval=.*|--print=.*)$/;
const FILE_EXT = /\.(mjs|cjs|js|sh|mts|cts|ts|tsx)$/;
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;

function pieces(text, isShellFile) {
	const out = [];
	for (let line of String(text).split('\n')) {
		if (isShellFile) line = line.replace(/(^|\s)#.*$/, '');
		for (const p of line.split(/&&|\|\||;|\|/)) {
			const t = p.trim();
			if (t) out.push(t);
		}
	}
	return out;
}

function tokenize(piece) {
	return piece
		.replace(/\$\(|\)|`/g, ' ')
		.replace(/["']/g, '')
		.split(/\s+/)
		.filter(Boolean);
}

/**
 * @param {{ files: Map<string, Buffer|string>, brand: object, externalExists?: (p:string)=>boolean, problems?: Problems }} opts
 *   files: composed tree, path -> content (only package.json files and the build script are read)
 */
export function checkClosure({ files, brand, externalExists, problems = new Problems() }) {
	const externals = new Set((brand.externals ?? []).map((x) => (x.startsWith('/') ? x : path.posix.normalize(x))));
	const usedExternals = new Set();
	const unresolved = [];
	const scanned = [];
	const text = (rel) => (files.has(rel) ? String(files.get(rel)) : null);

	const pkgScripts = (dir) => {
		const t = text(dir ? `${dir}/package.json` : 'package.json');
		if (t === null) return null;
		try {
			return JSON.parse(t).scripts ?? {};
		} catch {
			return null;
		}
	};
	const dirExists = (dir) => [...files.keys()].some((k) => k.startsWith(`${dir}/`));

	function checkPath(tok, cwd, source) {
		if (/[$`*?[]/.test(tok)) {
			unresolved.push({ source, token: tok });
			return;
		}
		if (tok.startsWith('/')) {
			const n = path.posix.normalize(tok);
			if (!externals.has(n)) problems.add('closure-external-undeclared', `${source} calls ${tok}, which is not declared in brand.json externals`, source);
			else usedExternals.add(n);
			return;
		}
		const joined = path.posix.normalize(path.posix.join(cwd || '.', tok));
		if (joined === '..' || joined.startsWith('../')) {
			const declared = externals.has(path.posix.normalize(tok)) || externals.has(joined);
			if (!declared) problems.add('closure-external-undeclared', `${source} calls ${tok}, outside the build directory and not declared in brand.json externals`, source);
			else usedExternals.add(externals.has(joined) ? joined : path.posix.normalize(tok));
			return;
		}
		if (!files.has(joined)) problems.add('closure-missing-script', `${source} calls ${tok} but ${joined} is not in the composed tree`, source);
	}

	function analysePiece(piece, cwd, source) {
		const t = tokenize(piece);
		let i = 0;
		while (i < t.length && (t[i] === 'export' || t[i] === 'exec' || t[i] === 'env' || ASSIGN.test(t[i]))) i++;
		if (i >= t.length) return;
		const cmd = t[i++];
		if (cmd === 'node' || cmd === 'nodejs') {
			while (i < t.length && t[i].startsWith('-')) {
				if (EVAL_FLAGS.test(t[i])) problems.add('node-eval', `${source} uses node ${t[i]}: ${piece.slice(0, 120)}`, source);
				if (['-r', '--require', '--import', '--loader'].includes(t[i])) i++;
				i++;
			}
			if (i < t.length) checkPath(t[i], cwd, source);
			return;
		}
		if (cmd === 'bash' || cmd === 'sh') {
			while (i < t.length && t[i].startsWith('-')) i++;
			if (i < t.length) checkPath(t[i], cwd, source);
			return;
		}
		if (cmd === 'pnpm') {
			let dir = null;
			while (i < t.length && t[i].startsWith('-')) {
				if (t[i] === '--dir' || t[i] === '-C' || t[i] === '--filter') {
					if (t[i] !== '--filter') dir = t[i + 1];
					i += 2;
				} else i++;
			}
			if (dir !== null) {
				const d = path.posix.normalize(path.posix.join(cwd || '.', dir));
				if (/[$`]/.test(dir)) unresolved.push({ source, token: dir });
				else if (!dirExists(d)) problems.add('closure-missing-dir', `${source} runs pnpm in ${dir} but ${d} is not in the composed tree`, source);
				else if ((t[i] === 'run' || t[i] === 'run-script') && t[i + 1]) {
					const sc = pkgScripts(d === '.' ? '' : d);
					if (sc && !(t[i + 1] in sc)) problems.add('closure-missing-pnpm-script', `${source} runs script ${t[i + 1]} that ${d}/package.json does not define`, source);
				}
				return;
			}
			if ((t[i] === 'run' || t[i] === 'run-script') && t[i + 1]) {
				const sc = pkgScripts(cwd && cwd !== '.' ? cwd : '');
				if (sc && !(t[i + 1] in sc)) problems.add('closure-missing-pnpm-script', `${source} runs script ${t[i + 1]} that package.json does not define`, source);
			}
			return;
		}
		if (cmd.startsWith('./') || cmd.startsWith('../') || cmd.startsWith('/')) checkPath(cmd, cwd, source);
		for (; i < t.length; i++) {
			if (!t[i].startsWith('-') && FILE_EXT.test(t[i]) && !/[$`*?[]/.test(t[i])) checkPath(t[i], cwd, source);
		}
	}

	const scan = (source, str, cwd, isShell) => {
		scanned.push(source);
		for (const p of pieces(str, isShell)) analysePiece(p, cwd, source);
	};

	for (const [dir, label] of [['', 'package.json'], ['vendor/storefront-client', 'vendor/storefront-client/package.json']]) {
		const sc = pkgScripts(dir);
		if (sc === null) {
			if (dir === '') problems.add('closure-no-package', 'composed tree has no readable package.json', label);
			continue;
		}
		for (const [name, cmd] of Object.entries(sc)) scan(`${label}#scripts.${name}`, cmd, dir, false);
	}
	if (brand.buildScript) {
		const t = text(brand.buildScript);
		if (t === null) problems.add('closure-missing-script', `brand.json buildScript ${brand.buildScript} is not in the composed tree`, brand.buildScript);
		else scan(brand.buildScript, t, '', true);
	}

	const externalsMissing = [];
	if (externalExists) for (const x of usedExternals) if (!externalExists(x)) externalsMissing.push(x);
	return { scanned, usedExternals: [...usedExternals].sort(), externalsMissing: externalsMissing.sort(), unresolved };
}
