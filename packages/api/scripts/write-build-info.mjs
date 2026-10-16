// Writes packages/api/BUILD-INFO.json {sha, dirty, time, node} (same shape as the defork build-info.mjs receipt).
// dirty ignores the output file itself. Not a git checkout (e.g. a source tarball) => no file, exit 0:
// the engine then reports `build: null` rather than a guessed identity.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { relative, resolve } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
// optional argv[2]: explicit output path (the admin bundle writes its own BUILD-INFO.json)
const out = process.argv[2] ? resolve(process.argv[2]) : `${root}BUILD-INFO.json`;
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
try {
  const top = git(['rev-parse', '--show-toplevel'], root).trim();
  const sha = git(['rev-parse', 'HEAD'], root).trim();
  const skip = relative(top, out);
  const entries = git(['status', '--porcelain=v1', '-z', '--untracked-files=normal'], top).split('\0');
  let dirty = 0;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.length < 4) continue;
    if (/[RC]/.test(e.slice(0, 2))) i++;
    if (e.slice(3) !== skip) dirty++;
  }
  writeFileSync(out, JSON.stringify({ sha, dirty: dirty > 0, time: new Date().toISOString(), node: process.version }, null, 2) + '\n');
} catch {
  console.warn('[build-info] not a git checkout; BUILD-INFO.json not written');
}
