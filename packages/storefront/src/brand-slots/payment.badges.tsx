// Base default for the `payment.badges` slot: the installment-provider badge that used to be inlined in footer.tsx.
// Markup is byte-for-byte the former footer markup; it renders only when the store has a merchant configured.
import { component$ } from '@qwik.dev/core';
import type { SlotProps } from '~/components/slots/registry';

const SEZZLE_CONFIGURED = !!(import.meta.env.VITE_SEZZLE_MERCHANT_UUID as string | undefined);

export default component$<SlotProps<'payment.badges'>>(() => {
	return SEZZLE_CONFIGURED ? (
		<svg width="38" height="24" viewBox="0 0 38 24"><rect width="38" height="24" rx="3" fill="#252525" stroke="#333" stroke-width="0.5"/><text x="19" y="15" text-anchor="middle" fill="#8B62E8" font-family="Inter,sans-serif" font-size="6" font-weight="700">Sezzle</text></svg>
	) : null;
});
