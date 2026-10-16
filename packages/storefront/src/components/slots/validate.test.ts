import { describe, expect, it } from 'vitest';
import { validateSlotFile } from './validate';

const good = (name: string) => `import { component$ } from '@qwik.dev/core';
import type { SlotProps } from '~/components/slots/registry';
export default component$<SlotProps<'${name}'>>(() => null);
`;

const messages = (file: string, text: string) => validateSlotFile(file, text).map((p) => p.message);

describe('validateSlotFile', () => {
	it('accepts a component$ default export typed from the registry', () => {
		expect(validateSlotFile('payment.badges.tsx', good('payment.badges'))).toEqual([]);
	});

	it('accepts an aliased import and a default export through a top-level const', () => {
		const text = `import { component$ as c$ } from '@qwik.dev/core';
import type { SlotProps } from '~/components/slots/registry';
const Badge = c$<SlotProps<'payment.badges'>>(() => null);
export default Badge;
`;
		expect(validateSlotFile('payment.badges.tsx', text)).toEqual([]);
	});

	it('rejects an unknown slot file name', () => {
		const [m] = messages('pdp.unknown.tsx', good('pdp.unknown'));
		expect(m).toMatch(/unknown slot "pdp\.unknown"/);
	});

	it('rejects a file that is not .tsx', () => {
		expect(messages('payment.badges.ts', good('payment.badges'))[0]).toMatch(/must end in \.tsx/);
		expect(messages('README.md', '# notes')[0]).toMatch(/must end in \.tsx/);
	});

	it('rejects a default export that is not component$', () => {
		const arrow = `export default () => null;\n`;
		const fn = `export default function Badge() { return null; }\n`;
		const plainCall = `import { component$ } from '@qwik.dev/core';\nconst X = () => null;\nexport default X;\n`;
		for (const text of [arrow, fn, plainCall, '']) {
			expect(messages('payment.badges.tsx', text)[0]).toMatch(/default export of payment\.badges\.tsx must be component\$/);
		}
	});

	it('rejects a component$ that is not the @qwik.dev/core one', () => {
		const text = `const component$ = (f: unknown) => f;\nexport default component$(() => null);\n`;
		expect(messages('payment.badges.tsx', text)[0]).toMatch(/must be component\$/);
		const wrongModule = `import { component$ } from 'other-lib';\nexport default component$(() => null);\n`;
		expect(messages('payment.badges.tsx', wrongModule)[0]).toMatch(/must be component\$/);
	});

	it('rejects props that are not typed SlotProps<its own slot name>', () => {
		const untyped = `import { component$ } from '@qwik.dev/core';\nexport default component$(() => null);\n`;
		const wrongSlot = good('legal.copy');
		const adHoc = `import { component$ } from '@qwik.dev/core';\nexport default component$<{ x: number }>(() => null);\n`;
		for (const text of [untyped, wrongSlot, adHoc]) {
			expect(messages('payment.badges.tsx', text)[0]).toMatch(/must be typed component\$<SlotProps<'payment\.badges'>>/);
		}
	});
});
