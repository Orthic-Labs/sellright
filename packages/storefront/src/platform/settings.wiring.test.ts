// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The platform settings decide stock-read TIMING only, and they are read in exactly one L1 module (platform/stock-triggers.ts). This
// keeps the wiring reviewable in one place and out of brand reach (layers.json platformApi.public exposes neither file).
const SRC = fileURLToPath(new URL('..', import.meta.url));
const SCHEMA = path.join(SRC, '..', 'brand-env.schema.json');
const LAYERS = path.join(SRC, '..', 'layers.json');

function sources(dir: string, out: string[] = []): string[] {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) sources(p, out);
		else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
	}
	return out;
}
const rel = (f: string) => path.relative(SRC, f).split(path.sep).join('/');
const all = sources(SRC).map((f) => ({ f: rel(f), text: fs.readFileSync(f, 'utf8') }));

describe('platform settings wiring', () => {
	it('only platform/stock-triggers.ts reads the settings module', () => {
		const readers = all.filter((s) => s.f !== 'platform/settings.ts' && /from ['"](~\/platform\/settings|\.\/settings|\.\.\/settings)['"]/.test(s.text)).map((s) => s.f);
		expect(readers).toEqual(['platform/stock-triggers.ts']);
		expect(all.filter((s) => s.f !== 'platform/settings.ts' && /\b(platformSettings|resolvePlatformSettings|settingsFromEnv)\b/.test(s.text)).map((s) => s.f)).toEqual(['platform/stock-triggers.ts']);
	});

	it('no setting is marked unwired any more, and every setting has its consumer in stock-triggers.ts', () => {
		const schema = JSON.parse(fs.readFileSync(SCHEMA, 'utf8')) as { settings: Record<string, { wired?: boolean }> };
		const triggers = all.find((s) => s.f === 'platform/stock-triggers.ts')!.text;
		for (const [name, spec] of Object.entries(schema.settings)) {
			expect(spec.wired, name).toBeUndefined();
			expect(triggers, name).toContain(`platformSettings['${name}']`);
		}
	});

	it('the trigger hooks are used by the base PDP, the brand configurator and both shop pages', () => {
		const users = all.filter((s) => /from ['"]~\/platform\/stock-triggers['"]/.test(s.text)).map((s) => s.f).sort();
		expect(users).toEqual(['platform/controllers/configurator.ts', 'platform/controllers/shop.tsx', 'routes/products/[...slug]/ProductContent.tsx', 'routes/shop/index.tsx']);
	});

	it('brand code cannot import the settings or the trigger module (not a public platform module)', () => {
		const layers = JSON.parse(fs.readFileSync(LAYERS, 'utf8')) as { platformApi: { public: Record<string, unknown> } };
		expect(Object.keys(layers.platformApi.public)).not.toContain('~/platform/settings');
		expect(Object.keys(layers.platformApi.public)).not.toContain('~/platform/stock-triggers');
	});

	it('the triggers never cache: no storage, no module-level result, no time window', () => {
		const triggers = all.find((s) => s.f === 'platform/stock-triggers.ts')!.text.replace(/^\s*\/\/.*$/gm, '');
		expect(triggers).not.toMatch(/sessionStorage|localStorage|setTimeout|Date\.now|new Map|ttl|debounce/i);
	});
});
