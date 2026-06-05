// Fetches free US ZIP data from millbj92/US-Zip-Codes-JSON and writes a compact
// {zip: [city, stateAbbr]} JSON for server-side in-memory lookup.
// Run yearly: pnpm tsx scripts/build-us-zip-data.ts

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

const SRC_URL = 'https://raw.githubusercontent.com/millbj92/US-Zip-Codes-JSON/master/USCities.json';
const OUT_PATH = resolve(process.cwd(), 'src/data/us-postal-codes.json');

interface RawEntry {
  zip_code?: number | string;
  city?: string;
  state?: string;
}

const main = async () => {
  console.log('Fetching', SRC_URL);
  const res = await fetch(SRC_URL);
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
  const raw = (await res.json()) as RawEntry[];

  const compact: Record<string, [string, string]> = {};
  let skipped = 0;
  for (const row of raw) {
    if (!row.zip_code || !row.city || !row.state) { skipped++; continue; }
    const zip = String(row.zip_code).padStart(5, '0');
    compact[zip] = [row.city, row.state];
  }

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(compact));
  console.log(`Wrote ${Object.keys(compact).length} entries (${skipped} skipped) to ${OUT_PATH}`);
};

main().catch(err => { console.error(err); process.exit(1); });
