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
			<rect width="20" height="14" x="2" y="5" rx="2"/><line x1="2" x2="22" y1="10" y2="10"/>
		</svg>
	);
});
