// A17: the typed slot registry. A slot is a named, optional mount point in a base component. A brand fills it by dropping
// `src/brand-slots/<slot-name>.tsx` whose default export is `component$<SlotProps<'<slot-name>'>>(...)`; the Vite plugin
// (vite-plugin.ts) rejects unknown file names, a default export that is not `component$`, and props not typed from this
// map. Slots receive data and QRLs; they never fetch (check-code-shape rejects fetch/server$ in L3 files).
import type { Component, QRL, Signal } from '@qwik.dev/core';
import type { AccountOrderSummary } from '~/sellright/types/account';

export interface SlotPropsMap {
	/** Cart drawer / checkout summary lines: a progress hint under the line list. No base fallback (renders nothing). */
	'cart.free-shipping-progress': {
		currencyCode: string;
		/** Cart subtotal in minor units (cents). */
		subtotalCents: number;
		lineCount: number;
		isCheckoutView: boolean;
	};
	/** Checkout order summary: the points-redemption control. Fallback: the base LoyaltyRedeem. */
	'checkout.loyalty-redemption': {
		redeemPoints: Signal<number>;
		discountableCents: number;
		currencyCode?: string;
	};
	/** Footer payment-icon row: extra badges after the card icons. The base ships a default file for its own provider badge. */
	'payment.badges': {
		placement: 'footer';
	};
	/** PDP price block: payment-plan widget under the price. The base ships a default file for its own provider widget. */
	'pdp.payment-widget': {
		/** The live unit price in minor units (cents) the shopper currently sees. */
		priceCents: number;
	};
	/** PDP: a guarantee / warranty trigger plus its modal. The slot owns its own open state. No base fallback. */
	'pdp.guarantee-modal': {
		productId: string;
		productName: string;
	};
	/** PDP: a back-in-stock / waitlist block. Data only: a brand with a waitlist service passes a link, not a fetch. No base fallback. */
	'pdp.waitlist': {
		productId: string;
		productName: string;
		soldOut: boolean;
		/** Optional hook the platform can supply once a waitlist endpoint exists; the slot never fetches itself. */
		onJoin$?: QRL<(email: string) => void>;
	};
	/** Account order history: one order card. Fallback: the base card markup. */
	'account.order-card': {
		order: AccountOrderSummary;
		href: string;
	};
	/** Account overview: a badge next to the loyalty balance. No base fallback. */
	'account.sustainability-badge': {
		orderCount: number;
		statsLoaded: boolean;
	};
	/** Legal pages: brand-owned copy for a named section. Fallback: neutral copy in the page. */
	'legal.copy': {
		section: LegalCopySection;
	};
}

export type LegalCopySection = 'privacy.payment-processors';

export type SlotName = keyof SlotPropsMap;
export type SlotProps<K extends SlotName> = SlotPropsMap[K];
export type SlotComponent<K extends SlotName> = Component<SlotPropsMap[K]>;
export type SlotMap = { [K in SlotName]?: SlotComponent<K> };

/** Every slot name, in declaration order. Keep in step with SlotPropsMap (registry.test.ts checks the two agree). */
export const SLOT_NAMES = [
	'cart.free-shipping-progress',
	'checkout.loyalty-redemption',
	'payment.badges',
	'pdp.payment-widget',
	'pdp.guarantee-modal',
	'pdp.waitlist',
	'account.order-card',
	'account.sustainability-badge',
	'legal.copy',
] as const satisfies readonly SlotName[];

/** The only extension a slot file may have: a slot is a Qwik component, so it needs JSX. */
export const SLOT_FILE_EXTENSION = '.tsx';

export const isSlotName = (value: string): value is SlotName => (SLOT_NAMES as readonly string[]).includes(value);

/** `payment.badges.tsx` -> `payment.badges`; null when the file is not `<something>.tsx`. */
export function slotNameFromFile(fileName: string): string | null {
	return fileName.endsWith(SLOT_FILE_EXTENSION) ? fileName.slice(0, -SLOT_FILE_EXTENSION.length) : null;
}

/** The brand's component for a slot, or undefined when the brand supplied none (the mount renders its fallback). */
export function pickSlot<K extends SlotName>(map: SlotMap, name: K): SlotComponent<K> | undefined {
	return map[name] as SlotComponent<K> | undefined;
}
