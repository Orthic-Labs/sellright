// Edits a SCRATCH copy's package.json (never a repo's): node scratch-edit-package.mjs <package.json> key=value ...
//   dep:<name>=<spec>    set dependencies[<name>] (or devDependencies if it is already there)
// Used by scratch-layout.sh to point the Rotten scratch's @sellright/storefront-client at the built pinned client and to
// add @playwright/test. Refuses to run on anything that is not a scratch path (guard: the path must contain /.work/harness/).
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [file, ...pairs] = process.argv.slice(2);
if (!file || !pairs.length) { console.error('usage: scratch-edit-package.mjs <package.json> dep:<name>=<spec> ...'); process.exit(2); }
const abs = resolve(file);
if (!abs.includes('/.work/harness/')) { console.error(`refusing to edit ${abs}: not under /.work/harness/`); process.exit(1); }

const pkg = JSON.parse(readFileSync(abs, 'utf8'));
for (const pair of pairs) {
  const m = /^dep:([^=]+)=(.+)$/.exec(pair);
  if (!m) { console.error(`bad argument ${pair}`); process.exit(2); }
  const [, name, spec] = m;
  const section = pkg.devDependencies?.[name] !== undefined ? 'devDependencies' : 'dependencies';
  pkg[section] ??= {};
  pkg[section][name] = spec;
}
writeFileSync(abs, JSON.stringify(pkg, null, 2) + '\n');
