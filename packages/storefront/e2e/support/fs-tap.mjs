// Preload for the STOREFRONT server process only (E2E_FS_TAP=1 -> NODE_OPTIONS=--import=<this file>, see
// playwright.config.ts). Records every fs.promises.readFile of a catalog marker or shop catalog so a spec can prove
// that each document request really re-read marker.json and shop-catalog.json from disk (no reader memo/cache):
//   E2E_FS_LOG (default <cwd>/fs-reads.jsonl) gets { time, path } per read.
// Observation only: the original readFile is called unchanged and its result returned untouched.
// UNVERIFIED: whether this reaches the Qwik server's dynamic `import('node:fs/promises')` (src/services/
// catalog-snapshot.ts). syncBuiltinESMExports() republishes the patched property to the ESM named exports; a spec that
// depends on it must first assert at least one record exists and otherwise report the gap (never pass silently).
import fsp from 'node:fs/promises';
import { appendFileSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const LOG = process.env.E2E_FS_LOG ?? 'fs-reads.jsonl';
writeFileSync(LOG, ''); // each server start begins with an empty log
const WATCHED = /(^|\/)(marker\.json|shop-catalog[^/]*\.json)$/;

const realReadFile = fsp.readFile;
fsp.readFile = function tappedReadFile(file, ...rest) {
  try {
    const path = typeof file === 'string' ? file : file instanceof URL ? file.pathname : undefined;
    if (path && WATCHED.test(path)) appendFileSync(LOG, JSON.stringify({ time: Date.now(), path }) + '\n');
  } catch { /* observation must never break a read */ }
  return realReadFile.call(this, file, ...rest);
};
syncBuiltinESMExports();
