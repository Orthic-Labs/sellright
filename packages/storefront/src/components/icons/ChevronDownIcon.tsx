import { component$ } from '@qwik.dev/core';

export default component$<{ forcedClass?: string }>(({ forcedClass }) => {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			width="24"
			height="24"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="1.5"
			stroke-linecap="round"
			stroke-linejoin="round"
			class={forcedClass || "w-5 h-5"}
		>
			<path d="m6 9 6 6 6-6"/>
		</svg>
	);
});
