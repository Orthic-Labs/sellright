// CI-only filesystem regressions for exact self-contained CLI helper. No Docker,
// credentials, API or database access; real PG/crypto roundtrip is recovery drill.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const source = fs.readFileSync(path.join(repo, 'deploy/sellright.sh'), 'utf8');
const embedded = source.split("  cat <<'JS'\n")[1].split('\nJS\n}')[0];
const appManifest = path.join(repo, 'packages/api/package.json');
const appRequire = createRequire(appManifest);
const excelRequire = createRequire(appRequire.resolve('exceljs'));
const tar = createRequire(excelRequire.resolve('archiver'))('tar-stream');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sellright-restore-fixtures-'));
let serial = 0;
async function archive(root, entries = [{ name: `${root}/`, type: 'directory' }, { name: `${root}/sentinel`, data: 'restored' }]) {
  const pack = tar.pack(), chunks = [];
  const done = (async () => { for await (const chunk of pack) chunks.push(chunk); })();
  for (const { data, ...header } of entries) pack.entry(header, data ?? '');
  pack.finalize(); await done;
  return gzipSync(Buffer.concat(chunks));
}
function fixture(injectCopyFailure = false) {
  const dir = path.join(temporary, String(++serial));
  const stage = path.join(dir, 'stage'), live = path.join(dir, 'live');
  fs.mkdirSync(dir);
  for (const root of ['assets', 'downloads']) {
    fs.mkdirSync(path.join(live, root), { recursive: true });
    fs.writeFileSync(path.join(live, root, 'sentinel'), 'original');
  }
  let helper = embedded.replace("'/tmp/sellright-restore'", JSON.stringify(stage))
    .replace("'/app/package.json'", JSON.stringify(appManifest))
    .replaceAll('/app/var/', `${live}/`);
  if (injectCopyFailure) {
    // Inject failure after first tree changed. No test hook ships in CLI.
    helper = helper.replace('function copyContents(from, to) {', `function copyContents(from, to) {
      if (from === ${JSON.stringify(path.join(stage, 'next/downloads'))}) throw Error('injected copy failure');`);
  }
  const script = path.join(dir, 'helper.cjs'); fs.writeFileSync(script, helper);
  function run(op, part, input) {
    return spawnSync(process.execPath, [script, op, ...(part ? [part] : [])], { input, encoding: 'utf8' });
  }
  function success(op, part, input) {
    const result = run(op, part, input); assert.equal(result.status, 0, `${op}: ${result.stderr}`);
  }
  function original() {
    for (const root of ['assets', 'downloads']) {
      assert.deepEqual(fs.readdirSync(path.join(live, root)), ['sentinel']);
      assert.equal(fs.readFileSync(path.join(live, root, 'sentinel'), 'utf8'), 'original');
    }
  }
  async function receive(parts = {}, manifest) {
    const data = { 'database.dump': Buffer.from('fixture-db'), 'assets.tar.gz': await archive('assets'), 'downloads.tar.gz': await archive('downloads'), ...parts };
    for (const [name, bytes] of Object.entries(data)) success('receive', name, bytes);
    if (manifest) {
      const hashes = Object.fromEntries(Object.entries(data).map(([name, bytes]) => [name, 'sha256:' + createHash('sha256').update(bytes).digest('hex')]));
      success('receive', 'manifest.json', JSON.stringify(manifest === true ? { parts: hashes } : manifest));
    }
    return data;
  }
  return { stage, live, run, success, original, receive };
}
try {
  for (const manifest of [false, true]) {
    const f = fixture(); await f.receive({}, manifest); f.success('stage'); f.original();
    f.success('snapshot'); f.success('promote');
    for (const root of ['assets', 'downloads']) assert.equal(fs.readFileSync(path.join(f.live, root, 'sentinel'), 'utf8'), 'restored');
    f.success('rollback'); f.original();
  }
  for (const part of ['database.dump', 'assets.tar.gz', 'downloads.tar.gz']) {
    const f = fixture(); const data = await f.receive({}, true);
    fs.appendFileSync(path.join(f.stage, part), 'corrupt');
    assert.notEqual(f.run('stage').status, 0, `hash accepted corrupt ${part}`); f.original();
    assert.ok(data[part]);
  }
  for (const root of ['assets', 'downloads']) {
    for (const kind of ['corrupt', 'truncated', 'traversal', 'absolute', 'symlink', 'hardlink', 'fifo', 'device', 'collision', 'parent-file', 'wrong-root', 'chained-link']) {
      const f = fixture(); let bytes;
      const regular = { name: `${root}/file`, data: 'x' };
      if (kind === 'corrupt') bytes = Buffer.from('invalid gzip');
      else if (kind === 'truncated') { bytes = await archive(root); bytes = bytes.subarray(0, bytes.length - 8); }
      else {
        const entries = {
          traversal: [{ name: `${root}/../escape`, data: 'x' }],
          absolute: [{ name: '/tmp/escape', data: 'x' }],
          symlink: [{ name: `${root}/link`, type: 'symlink', linkname: '/tmp' }],
          hardlink: [{ name: `${root}/link`, type: 'link', linkname: `${root}/file` }],
          fifo: [{ name: `${root}/fifo`, type: 'fifo' }],
          device: [{ name: `${root}/device`, type: 'character-device', devmajor: 1, devminor: 3 }],
          collision: [regular, regular],
          'parent-file': [regular, { name: `${root}/file/nested`, data: 'x' }],
          'wrong-root': [{ name: 'other/file', data: 'x' }],
          'chained-link': [{ name: `${root}/a`, type: 'symlink', linkname: '../downloads' }, { name: `${root}/a/escape`, data: 'x' }],
        }[kind];
        bytes = await archive(root, entries);
      }
      await f.receive({ [`${root}.tar.gz`]: bytes });
      const result = f.run('stage'); assert.notEqual(result.status, 0, `${root}: accepted ${kind}`); f.original();
    }
  }
  const f = fixture(true); await f.receive(); f.success('stage'); f.success('snapshot');
  assert.notEqual(f.run('promote').status, 0, 'copy failure not injected');
  f.success('rollback'); f.original();
  console.log('ok - real archive/hash validation, safe staging, promotion & file rollback fixtures');
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
