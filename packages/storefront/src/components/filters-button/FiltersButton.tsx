import { $, component$, QRL } from '@qwik.dev/core';
import FilterIcon from '../icons/FilterIcon';

export default component$<{ onToggleMenu$: QRL<() => void> }>(({ onToggleMenu$ }) => {
	return (
		<button
			type="button"
			class="flex space-x-2 items-center border border-gray-300 px-4 py-2 text-gray-600 hover:text-black hover:border-black transition-colors lg:hidden cursor-pointer"
			onClick$={$(async () => {
				onToggleMenu$();
			})}
		>
			<span>Filters</span>
			<FilterIcon />
		</button>
	);
});
