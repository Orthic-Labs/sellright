#!/usr/bin/env node
// Origin smoke (plan A §4.6a d): plain GET requests against one origin URL with a chosen Host header. No browser,
// so it runs against any tree. Exit 0 only if every response is 200 (or a listed redirect) and every HTML body
// contains `<html`. Uses node:http(s) directly so the Host header is the one asked for and redirects are never followed.
//
//   origin-smoke.mjs <url> --host <name> [--path /a --path /b ...] [--redirect /from=301]
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_PATHS = ['/'];

/** One GET. Resolves { status, headers, body } or rejects on network, timeout, or body-limit failure. */
export function httpGet(url, { host, timeoutMs = 10000, maxBytes = 2 << 20 } = {}) {
	return new Promise((resolve, reject) => {
		const u = new URL(url);
		const lib = u.protocol === 'https:' ? https : http;
		const headers = { accept: 'text/html,*/*', 'user-agent': 'origin-smoke' };
		if (host) headers.host = host;
		let req;
		let res;
		let deadline;
		let settled = false;
		let size = 0;
		const chunks = [];
		const onTimeout = () => finish(new Error(`timeout after ${timeoutMs} ms`));
		const onError = (error) => finish(error);
		const onAborted = () => finish(new Error('response aborted'));
		const onRequestClose = () => req.removeListener('error', onError);
		const onResponseClose = () => {
			if (!settled) finish(new Error('response closed before end'));
			res.removeListener('error', onError);
		};
		const cleanup = () => {
			clearTimeout(deadline);
			if (req) {
				req.setTimeout(0);
				req.removeListener('timeout', onTimeout);
				req.removeListener('response', onResponse);
			}
			if (res) {
				res.removeListener('data', onData);
				res.removeListener('end', onEnd);
				res.removeListener('aborted', onAborted);
			}
		};
		function finish(error, result) {
			if (settled) return;
			settled = true;
			cleanup();
			if (error) {
				// Do not pass the error to destroy: queued socket errors are
				// absorbed by onError until each stream closes, then detached.
				res?.destroy();
				req?.destroy();
				reject(error);
			} else resolve(result);
		}
		const onData = (chunk) => {
			size += chunk.length;
			if (size > maxBytes) {
				finish(new Error(`body exceeds ${maxBytes} bytes`));
				return;
			}
			chunks.push(chunk);
		};
		const onEnd = () => finish(null, { status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') });
		const onResponse = (response) => {
			res = response;
			res.on('data', onData);
			res.once('end', onEnd);
			res.on('error', onError);
			res.once('aborted', onAborted);
			res.once('close', onResponseClose);
		};
		try {
			req = lib.request(u, { method: 'GET', headers, ...(u.protocol === 'https:' && host ? { servername: host } : {}) }, onResponse);
			req.on('error', onError);
			req.once('close', onRequestClose);
			req.setTimeout(timeoutMs, onTimeout);
			// Independent of socket activity: DNS, headers and the complete
			// body must all finish inside the same wall-clock budget.
			if (timeoutMs > 0) deadline = setTimeout(onTimeout, timeoutMs);
			req.end();
		} catch (error) {
			finish(error);
		}
	});
}

/**
 * @param {string} base origin URL without a trailing path, e.g. http://127.0.0.1:4000
 * @param {{ host?: string, paths?: string[], redirects?: Array<{ path: string, status: number }>, get?: Function }} opts
 * @returns {Promise<{ ok: boolean, results: Array<{ path: string, status?: number, ok: boolean, reason?: string }> }>}
 */
export async function runSmoke(base, { host, paths = DEFAULT_PATHS, redirects = [], get = httpGet } = {}) {
	const redirectOf = new Map(redirects.map((r) => [r.path, r.status]));
	const results = [];
	for (const p of paths) {
		try {
			const res = await get(new URL(p, base).href, { host });
			const wantRedirect = redirectOf.get(p);
			if (wantRedirect !== undefined) {
				const ok = res.status === wantRedirect;
				results.push({ path: p, status: res.status, ok, ...(ok ? {} : { reason: `expected redirect ${wantRedirect}` }) });
				continue;
			}
			if (res.status !== 200) {
				results.push({ path: p, status: res.status, ok: false, reason: 'status is not 200' });
				continue;
			}
			const isHtml = /text\/html/i.test(String(res.headers?.['content-type'] ?? '')) || /^\s*<!doctype html|^\s*<html/i.test(res.body);
			if (isHtml && !/<html/i.test(res.body)) {
				results.push({ path: p, status: 200, ok: false, reason: 'HTML body lacks <html' });
				continue;
			}
			results.push({ path: p, status: 200, ok: true });
		} catch (e) {
			results.push({ path: p, ok: false, reason: e.message });
		}
	}
	return { ok: results.length > 0 && results.every((r) => r.ok), results };
}

export async function main(argv, out = console) {
	const paths = [];
	const redirects = [];
	let url = null;
	let host;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--host') host = argv[++i];
		else if (a === '--path') paths.push(argv[++i]);
		else if (a === '--redirect') {
			const [pth, st] = String(argv[++i]).split('=');
			redirects.push({ path: pth, status: Number(st) });
			if (!paths.includes(pth)) paths.push(pth);
		} else if (!a.startsWith('--') && !url) url = a;
		else {
			out.error(`unknown argument ${a}`);
			return 2;
		}
	}
	if (!url) {
		out.error('usage: origin-smoke.mjs <url> --host <name> [--path /p ...] [--redirect /from=301 ...]');
		return 2;
	}
	const r = await runSmoke(url, { host, paths: paths.length ? paths : DEFAULT_PATHS, redirects });
	for (const x of r.results) out.log(`${x.ok ? 'ok  ' : 'FAIL'} ${x.path} ${x.status ?? '-'}${x.reason ? ` (${x.reason})` : ''}`);
	return r.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).then((c) => process.exit(c));
