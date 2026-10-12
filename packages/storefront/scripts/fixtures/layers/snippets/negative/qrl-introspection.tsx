// expect-shape: qrl-introspection
import type { QRL } from '@qwik.dev/core';

export const leak = (props: { onAddToCart$: QRL<() => void> }) => (props.onAddToCart$ as any).getCaptured();
export const sym = (q: any) => q['$symbol$'];
