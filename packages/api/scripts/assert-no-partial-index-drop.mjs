#!/usr/bin/env node
// ra-007 guard: drizzle-kit does NOT model the license_activation partial unique
// index (license_activation_token_hash_unique, WHERE activation_token_hash IS NOT
// NULL), so `db:generate` can emit a spurious DROP INDEX for it. Dropping it would
// let duplicate activation tokens through. Fail if any migration tries to drop it.
// Wired to run automatically after `db:generate`.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = fileURLToPath(new URL('../drizzle/', import.meta.url));
const BAD = /drop\s+index[^;]*license_activation_token_hash/i;

const offenders = [];
for (const f of readdirSync(DIR)) {
  if (!f.endsWith('.sql')) continue;
  if (BAD.test(readFileSync(join(DIR, f), 'utf8'))) offenders.push(f);
}

if (offenders.length) {
  console.error(`[assert-no-partial-index-drop] spurious DROP INDEX on license_activation_token_hash in: ${offenders.join(', ')}`);
  console.error('Remove that line — drizzle-kit does not model the partial index (ra-007).');
  process.exit(1);
}
console.log('[assert-no-partial-index-drop] ok — no spurious license_activation index drop');
