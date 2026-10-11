// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { SLOT_NAMES } from './registry';
import { SLOTS_VIRTUAL_ID, SlotValidationError, brandSlotsPlugin, discoverSlots, renderSlotModule } from './vite-plugin';

const goodFile = (name: string) => `import { component$ } from '@qwik.dev/core';
import type { SlotProps } from '~/components/slots/registry';
export default component$<SlotProps<'${name}'>>(() => null);
`;

const dirs: string[] = [];
const tmp = (files: Record<string, string>) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slots-'));
	dirs.push(dir);
	for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
	return dir;
};
afterEach(() => {
	for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('discoverSlots', () => {
	it('returns [] for a missing or empty directory (no brand slots)', () => {
		expect(discoverSlots(path.join(os.tmpdir(), 'slots-does-not-exist'))).toEqual([]);
		expect(discoverSlots(tmp({}))).toEqual([]);
	});

	it('returns valid files sorted by file name', () => {
		const dir = tmp({ 'payment.badges.tsx': goodFile('payment.badges'), 'legal.copy.tsx': goodFile('legal.copy') });
		expect(discoverSlots(dir).map((e) => e.name)).toEqual(['legal.copy', 'payment.badges']);
	});

	it('rejects an unknown slot file, naming it', () => {
		const dir = tmp({ 'pdp.unknown.tsx': goodFile('pdp.unknown') });
		expect(() => discoverSlots(dir)).toThrow(SlotValidationError);
		expect(() => discoverSlots(dir)).toThrow(/pdp\.unknown\.tsx: unknown slot "pdp\.unknown"/);
	});

	it('rejects a non-component$ default export', () => {
		const dir = tmp({ 'legal.copy.tsx': 'export default () => null;\n' });
		expect(() => discoverSlots(dir)).toThrow(/legal\.copy\.tsx: the default export .* must be component\$/);
	});

	it('reports every problem at once', () => {
		const dir = tmp({ 'a.tsx': goodFile('a'), 'legal.copy.tsx': 'export default 1;\n' });
		try {
			discoverSlots(dir);
			throw new Error('expected a throw');
		} catch (e) {
			expect(e).toBeInstanceOf(SlotValidationError);
			expect((e as SlotValidationError).problems).toHaveLength(2);
		}
	});

	it('rejects a subdirectory', () => {
		const dir = tmp({});
		fs.mkdirSync(path.join(dir, 'nested'));
		expect(() => discoverSlots(dir)).toThrow(/only regular slot files/);
	});

	it("the base's own src/brand-slots defaults are valid", () => {
		const entries = discoverSlots(fileURLToPath(new URL('../../brand-slots', import.meta.url)));
		expect(entries.map((e) => e.name).sort()).toEqual(['legal.copy', 'payment.badges', 'pdp.payment-widget']);
	});

	it('the compiled fixture slots (e2e/slots.spec.ts) are valid and omit one slot on purpose', () => {
		const entries = discoverSlots(fileURLToPath(new URL('./__fixtures__/brand-slots', import.meta.url)));
		const names = entries.map((e) => e.name);
		expect(names).not.toContain('pdp.guarantee-modal');
		expect(names.length).toBeGreaterThanOrEqual(5);
	});
});

describe('renderSlotModule', () => {
	it('emits static imports and a map in registry order, deterministically', () => {
		const code = renderSlotModule([
			{ name: 'payment.badges', file: '/x/payment.badges.tsx' },
			{ name: 'cart.free-shipping-progress', file: '/x/cart.free-shipping-progress.tsx' },
		]);
		expect(code).toBe(
			'import slot0 from "/x/cart.free-shipping-progress.tsx";\nimport slot1 from "/x/payment.badges.tsx";\n' +
				'export const brandSlots = {\n  "cart.free-shipping-progress": slot0,\n  "payment.badges": slot1,\n};\n',
		);
		expect(code).not.toMatch(/import\.meta\.glob|import\(/);
	});

	it('is an empty map when there are no slots', () => {
		expect(renderSlotModule([])).toBe('\nexport const brandSlots = {\n\n};\n');
	});

	it('only ever names registry slots', () => {
		const all = SLOT_NAMES.map((name) => ({ name, file: `/x/${name}.tsx` }));
		for (const n of SLOT_NAMES) expect(renderSlotModule(all)).toContain(`"${n}":`);
	});
});

describe('brandSlotsPlugin', () => {
	type Hooks = { configResolved: (c: { root: string }) => void; buildStart: () => void; resolveId: (id: string) => unknown; load: (this: { addWatchFile: (f: string) => void }, id: string) => unknown };
	const make = (slotsDir: string) => {
		const p = brandSlotsPlugin({ slotsDir }) as unknown as Hooks;
		p.configResolved({ root: '/' });
		return p;
	};

	it('resolves only its own virtual id and loads the generated module', () => {
		const dir = tmp({ 'payment.badges.tsx': goodFile('payment.badges') });
		const p = make(dir);
		expect(p.resolveId('something-else')).toBeNull();
		const resolved = p.resolveId(SLOTS_VIRTUAL_ID) as string;
		expect(resolved).toBe(`\0${SLOTS_VIRTUAL_ID}`);
		const watched: string[] = [];
		const code = p.load.call({ addWatchFile: (f) => watched.push(f) }, resolved) as string;
		expect(code).toContain('"payment.badges": slot0');
		expect(watched).toEqual([dir]);
		expect(p.load.call({ addWatchFile: () => {} }, 'other')).toBeNull();
	});

	it('fails buildStart on a bad slot file and passes on none', () => {
		expect(() => make(tmp({ 'nope.tsx': goodFile('nope') })).buildStart()).toThrow(SlotValidationError);
		expect(() => make(tmp({})).buildStart()).not.toThrow();
	});
});
