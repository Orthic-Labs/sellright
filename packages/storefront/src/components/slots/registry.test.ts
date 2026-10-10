import { describe, expect, it } from 'vitest';
import { SLOT_NAMES, isSlotName, pickSlot, slotNameFromFile, type SlotMap, type SlotProps } from './registry';

const EXPECTED = [
	'cart.free-shipping-progress',
	'checkout.loyalty-redemption',
	'payment.badges',
	'pdp.payment-widget',
	'pdp.guarantee-modal',
	'pdp.waitlist',
	'account.order-card',
	'account.sustainability-badge',
	'legal.copy',
];

describe('slot registry', () => {
	it('lists exactly the nine plan A17 slots, once each', () => {
		expect([...SLOT_NAMES]).toEqual(EXPECTED);
		expect(new Set(SLOT_NAMES).size).toBe(SLOT_NAMES.length);
	});

	it('isSlotName accepts registry names only', () => {
		for (const n of EXPECTED) expect(isSlotName(n)).toBe(true);
		expect(isSlotName('pdp.unknown')).toBe(false);
		expect(isSlotName('')).toBe(false);
		expect(isSlotName('constructor')).toBe(false);
	});

	it('slotNameFromFile strips .tsx and rejects other extensions', () => {
		expect(slotNameFromFile('payment.badges.tsx')).toBe('payment.badges');
		expect(slotNameFromFile('payment.badges.ts')).toBeNull();
		expect(slotNameFromFile('payment.badges')).toBeNull();
	});

	it('pickSlot returns the supplied component and undefined for an absent slot', () => {
		const fake = (() => null) as unknown as NonNullable<SlotMap['legal.copy']>;
		expect(pickSlot({ 'legal.copy': fake }, 'legal.copy')).toBe(fake);
		expect(pickSlot({}, 'legal.copy')).toBeUndefined();
		expect(pickSlot({ 'legal.copy': fake }, 'payment.badges')).toBeUndefined();
	});

	it('props are typed per slot (checked by tsc: the @ts-expect-error lines must be errors)', () => {
		const ok: SlotProps<'pdp.payment-widget'> = { priceCents: 1999 };
		const legal: SlotProps<'legal.copy'> = { section: 'privacy.payment-processors' };
		// @ts-expect-error unknown prop on a typed slot
		const extra: SlotProps<'pdp.payment-widget'> = { priceCents: 1, nope: true };
		// @ts-expect-error required prop missing
		const missing: SlotProps<'pdp.payment-widget'> = {};
		// @ts-expect-error not a legal-copy section
		const badSection: SlotProps<'legal.copy'> = { section: 'terms.anything' };
		// @ts-expect-error not a slot name
		type Unknown = SlotProps<'not.a.slot'>;
		expect([ok, legal, extra, missing, badSection]).toHaveLength(5);
		const _unused: Unknown | undefined = undefined;
		expect(_unused).toBeUndefined();
	});
});
