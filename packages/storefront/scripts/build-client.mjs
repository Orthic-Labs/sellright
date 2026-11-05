// #427: client build in two passes. Pass 1 builds; its manifest gives each symbol's hash and source, chunk-groups.mjs maps them
// to page areas, and pass 2 builds with that map (vite.config.ts reads it as entryStrategy.manual). When the stored map already
// matches pass 1's output, pass 1 was the final build and nothing reruns.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { chunkGroups } from './chunk-groups.mjs';

const suffix = process.env.SELLRIGHT_BUILD_SUFFIX ? `-${process.env.SELLRIGHT_BUILD_SUFFIX}` : '';
const mapFile = `chunk-groups${suffix}.json`;
const manifest = `dist${suffix}/q-manifest.json`;
const build = () => execFileSync('npx', ['vite', 'build', '--logLevel', 'warn'], { stdio: 'inherit' });

build();
const next = JSON.stringify(chunkGroups(JSON.parse(readFileSync(manifest, 'utf8'))), null, 1) + '\n';
const prev = existsSync(mapFile) ? readFileSync(mapFile, 'utf8') : '';
if (next !== prev) {
	writeFileSync(mapFile, next);
	console.log(`chunk groups: ${Object.keys(JSON.parse(next)).length} symbols mapped; rebuilding with them`);
	build();
} else {
	console.log('chunk groups unchanged; single pass');
}
