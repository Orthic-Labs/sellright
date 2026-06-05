import { component$ } from '@qwik.dev/core';
import SlashIcon from '../icons/SlashIcon';

export default component$<{ items: { name: string; slug: string; id: string }[] }>(({ items }) => {
	return (
		<nav class="flex">
			<ol class="flex items-center space-x-1 md:space-x-4">
				{items
					.filter((item) => item.name !== '__root_collection__')
					.map((item) => (
						<li key={item.name}>
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
