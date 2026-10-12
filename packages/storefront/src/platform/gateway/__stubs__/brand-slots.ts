// Test stand-in for `virtual:sellright-brand-slots` (vitest.render.config.ts): the slot implementations the product ships in
// src/brand-slots (what a default build resolves), so the render tests compare the defaults, not an empty registry.
import type { SlotMap } from '~/components/slots/registry';
import legalCopy from '~/brand-slots/legal.copy';
import paymentBadges from '~/brand-slots/payment.badges';
import paymentWidget from '~/brand-slots/pdp.payment-widget';

export const brandSlots: SlotMap = {
	'legal.copy': legalCopy,
	'payment.badges': paymentBadges,
	'pdp.payment-widget': paymentWidget,
};
