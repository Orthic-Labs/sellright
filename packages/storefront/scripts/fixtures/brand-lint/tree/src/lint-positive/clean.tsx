// Damned Designs and #B87333 only in a comment: comments are not scanned.
import { component$ } from '@qwik.dev/core';
import Sezzle from '~/components/payment/Sezzle';

type Provider = 'sezzle' | 'nmi';

export const method: { provider: Provider } = { provider: 'sezzle' };
export const style = { color: 'var(--color-accent)', fontFamily: 'var(--font-body)', background: '#ffffff' };
export const fallbackFont = "'Inter', system-ui, sans-serif";
export default component$(() => <Sezzle />);
