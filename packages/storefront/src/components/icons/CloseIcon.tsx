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
			class={forcedClass || "w-6 h-6"}
		>
			<path d="M18 6 6 18"/><path d="m6 6 12 12"/>
		</svg>
	);
});
