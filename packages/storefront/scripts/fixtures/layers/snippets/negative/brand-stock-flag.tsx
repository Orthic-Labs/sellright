// expect-shape: brand-stock-flag
import { useSignal } from '@qwik.dev/core';

export const useX = () => {
	const stockLoaded = useSignal(false);
	const availabilityChecked = useSignal(false);
	const cacheStock = { a: 1 };
	return { stockLoaded, availabilityChecked, cacheStock };
};
