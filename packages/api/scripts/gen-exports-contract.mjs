// Regenerates exports/contract.json from the 0.1 symbol graph's disposition table.
// Usage: node scripts/gen-exports-contract.mjs <IMPORT-DISPOSITION.md> [import-graph.json]
// The contract records, per engine module imported by moved (fork) code, the decision
// public | moved | replaced and the surface (subpath) a public symbol is exported from.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SURFACE = {
  'auth/cookies': 'auth', 'auth/email': 'auth', 'auth/rate-limit': 'auth', 'auth/session': 'auth',
  'db/client': 'db', 'db/schema': 'schema', 'db/schema-core': 'schema', 'db/schema-orders': 'schema',
  'lib/logger': 'log',
  'routes/admin-helpers': 'http', 'routes/apps': 'http', 'routes/apps.limit': 'http', 'routes/store-context': 'http', 'store-context': 'http',
  'licensing/storekit-config': 'storekit', 'licensing/storekit-license': 'storekit', 'licensing/storekit-verify': 'storekit',
};
const md = readFileSync(process.argv[2], 'utf8');
const rows = md.split('\n').filter((l) => l.startsWith('| `') && l.split('|').length >= 7);
const symbols = [];
for (const l of rows) {
  const c = l.split('|').map((x) => x.trim());
  const [, mod, sym, kind, , disp] = c;
  if (!['public', 'moved', 'replaced'].includes(disp)) continue; // module table rows
  const module = mod.replaceAll('`', '');
  const name = sym.replaceAll('`', '').replace(/^\* as /, '').replace(/ \(19 tables\)$/, '');
  const surface = disp === 'public' ? (SURFACE[module] ?? (module.startsWith('licensing/') ? 'licensing' : null)) : null;
  symbols.push({ module, symbol: name, kind, disposition: disp, surface });
}
if (symbols.some((s) => s.disposition === 'public' && !s.surface)) throw new Error('public symbol without a surface');
const out = { schema: 'sellright-exports-contract/1', source: 'IMPORT-DISPOSITION.md (draft, plan 2.2) + import-graph.json', symbols };
writeFileSync(fileURLToPath(new URL('../exports/contract.json', import.meta.url)), JSON.stringify(out, null, 2) + '\n');
console.log(`${symbols.length} symbols`);
