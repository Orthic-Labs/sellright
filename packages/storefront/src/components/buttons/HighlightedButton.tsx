import { $, component$, QRL, Slot } from '@qwik.dev/core';

type Props = {
	extraClass?: string;
	onClick$?: QRL<() => void>;
	disabled?: boolean;
};

export const HighlightedButton = component$<Props>(({ extraClass = '', onClick$, disabled = false }) => {
	return (		<button
			type="button"
			disabled={disabled}
			class={`flex items-center justify-around bg-[#965341] border border-transparent rounded-md py-2 px-4 text-base font-medium text-white hover:bg-black focus:outline-hidden focus:ring-2 focus:ring-offset-0 focus:ring-gray-800 cursor-pointer ${extraClass} ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
			style="font-family: var(--font-heading)"onClick$={$(async () => {
				if (onClick$ && !disabled) {
					await onClick$();
				}
			})}
		>
			<Slot />
		</button>
	);
});
