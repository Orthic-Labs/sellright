import { component$ } from '@qwik.dev/core';
import SlashIcon from '../icons/SlashIcon';

export default component$<{ items: { name: string; slug: string; id: string }[] }>(({ items }) => {
	const visible = items.filter((item) => item.name !== '__root_collection__');
	const lastIndex = visible.length - 1;
	return (
		<nav class="flex" aria-label="Breadcrumb">
			<ol class="flex items-center space-x-1 md:space-x-4">
				{visible.map((item, i) => (
					<li key={item.name} aria-current={i === lastIndex ? 'page' : undefined}>
						<div class="flex items-center">
							<SlashIcon />
							<span class="ml-2 md:ml-4 text-xs md:text-sm font-medium text-gray-500">
								{item.name}
							</span>
						</div>
					</li>
				))}
			</ol>
		</nav>
	);
});
