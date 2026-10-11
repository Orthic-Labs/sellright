// node --test tools/deploy/review6.test.mjs   (cwd: packages/storefront)
// Review round 6: the whole stage is durable before the swap intent (6.2); closure validation covers every file reachable
// from the client, symlinks followed (6.3). Recovery from an absent output root (6.1) is in tools/compose/journal.test.mjs.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { activate, build } from './entry.mjs';
import { closureProblem } from './rollback.mjs';
import { fsyncHooks } from '../compose/lib/durable.mjs';
import { makeWorld, sha } from './fixtures/world.mjs';

const NP = { noRestart: true, smokePort: 4555 };
const scratch = (t) => {
	const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'r6-')));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
};
function closureDir(t) {
	const rec = scratch(t);
	const clientRel = 'sellright/packages/storefront-client';
	const files = {};
	const put = (rel, text) => {
		mkdirSync(path.dirname(path.join(rec, rel)), { recursive: true });
		writeFileSync(path.join(rec, rel), text);
		files[rel] = sha(text);
	};
	put(`${clientRel}/package.json`, '{"name":"client"}');
	put(`${clientRel}/dist/index.js`, 'export {};');
	return { rec, recDir: rec, clientRel, clientDir: path.join(rec, clientRel), files, put };
}

test('review 6.3: an internal symlink to an unlisted dependency directory outside the client prefix is refused; listing its files passes', (t) => {
	const c = closureDir(t);
	mkdirSync(path.join(c.rec, 'deps/pkg/lib'), { recursive: true });
	writeFileSync(path.join(c.rec, 'deps/pkg/lib/a.js'), 'dep bytes');
	mkdirSync(path.join(c.clientDir, 'node_modules'));
	symlinkSync(path.join(c.rec, 'deps/pkg'), path.join(c.clientDir, 'node_modules/pkg'));
	assert.match(closureProblem(c), /deps\/pkg\/lib\/a\.js is reachable from the client but not listed/);
	c.files['deps/pkg/lib/a.js'] = sha('dep bytes');
	assert.equal(closureProblem(c), null, 'once listed under its real path (and hashed) it passes');
	writeFileSync(path.join(c.rec, 'deps/pkg/lib/a.js'), 'changed');
	assert.match(closureProblem(c), /does not match closure\.json/);
});

test('review 6.3: a symlink to a single unlisted internal file, and a client directory that is itself an internal symlink, are refused', (t) => {
	let c = closureDir(t);
	writeFileSync(path.join(c.rec, 'loose.js'), 'x');
	symlinkSync(path.join(c.rec, 'loose.js'), path.join(c.clientDir, 'loose-link.js'));
	assert.match(closureProblem(c), /loose\.js is reachable from the client but not listed/);

	c = closureDir(t);
	mkdirSync(path.join(c.rec, 'other/dist'), { recursive: true });
	writeFileSync(path.join(c.rec, 'other/dist/index.js'), 'unverified');
	const linkedClient = path.join(c.rec, 'client-link');
	symlinkSync(path.join(c.rec, 'other'), linkedClient);
	assert.match(closureProblem({ recDir: c.rec, clientDir: linkedClient, files: c.files }), /other\/dist\/index\.js is reachable from the client but not listed/);
});

test('review 6.3: an internal symlink cycle terminates and a fully listed closure with a shared dependency passes', (t) => {
	const c = closureDir(t);
	symlinkSync(c.clientDir, path.join(c.clientDir, 'again'));
	assert.equal(closureProblem(c), null);
});

test('review 6.2: the whole stage, including files a subprocess wrote without fsync, is fsynced before the swap intent is published, and the intent records it', async (t) => {
	const w = makeWorld();
	t.after(w.cleanup);
	const ctx = w.ctx();
	await build(ctx, {});
	const stray = path.join(w.root, 'store.next/generated/deep/chunk.bin');
	mkdirSync(path.dirname(stray), { recursive: true });
	writeFileSync(stray, 'written by a subprocess, never fsynced');
	const events = [];
	fsyncHooks.onOp = (kind, p, extra) => events.push({ op: kind, p, from: extra?.from });
	fsyncHooks.onDir = (d) => events.push({ dir: d });
	t.after(() => {
		fsyncHooks.onOp = null;
		fsyncHooks.onDir = null;
	});
	await activate(ctx, NP);
	const iFile = events.findIndex((e) => e.op === 'fsync-file' && e.p === stray);
	const iDir = events.findIndex((e) => e.dir === path.dirname(stray));
	assert.ok(iFile >= 0, 'the stray file was fsynced');
	assert.ok(iDir >= 0, 'and its directory');
	const swapRenames = events.map((e, i) => ({ ...e, i })).filter((e) => e.op === 'rename' && /store\.(next|prev)/.test(`${e.p} ${e.from}`));
	assert.ok(swapRenames.length > 0);
	assert.ok(iFile < swapRenames[0].i && iDir < swapRenames[0].i, 'durable before the first swap rename');
	const publish = events.findIndex((e, i) => i > iFile && /\.deploy-state/.test(`${e.p ?? ''}${e.dir ?? ''}`));
	assert.ok(publish > iFile, 'and before the next state record is written');
	assert.equal(w.readState().activations.at(-1).stageDurable, true, 'the activation record says the stage was made durable first');
});
