// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// brand-env.schema.json marks a platform setting `wired: false` while no storefront code reads it, and compose then refuses a
// non-default value (env-setting-unwired). This test ties that flag to the code: the moment a reader appears, the flag is stale.
const SRC = fileURLToPath(new URL('..', import.meta.url));
const SCHEMA = path.join(SRC, '..', 'brand-env.schema.json');

function sources(dir: string, out: string[] = []): string[] {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) sources(p, out);
		else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
	}
	return out;
}

describe('platform settings wiring flag', () => {
	const schema = JSON.parse(fs.readFileSync(SCHEMA, 'utf8')) as { settings: Record<string, { wired?: boolean }> };
	const readers = sources(SRC)
		.filter((f) => !f.endsWith(path.join('platform', 'settings.ts')))
		.filter((f) => /\b(platformSettings|resolvePlatformSettings|PLATFORM_SETTING_DEFAULTS)\b/.test(fs.readFileSync(f, 'utf8')))
		.map((f) => path.relative(SRC, f));

	it('every setting is marked unwired while nothing outside platform/settings.ts reads the settings module', () => {
		expect(readers).toEqual([]);
		for (const [name, spec] of Object.entries(schema.settings)) expect(spec.wired, name).toBe(false);
	});
});
