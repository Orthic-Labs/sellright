#!/usr/bin/env node
// A21 operator CLI. The validator itself lives in tools/compose/env-check.mjs because
// compose.mjs imports it and the cold tool runtime archives only tools/compose.
//   node tools/env/env-check.mjs --schema brand-env.schema.json --brand <brand.json> [--build-dir <dir>]
import { main } from '../compose/env-check.mjs';

main(process.argv.slice(2)).then(
	(code) => process.exit(code),
	(e) => {
		console.error(e.message);
		process.exit(1);
	},
);
