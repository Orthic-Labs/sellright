import { Component, component$ } from '@qwik.dev/core';
import { Link } from '@qwik.dev/router';

interface IProps {
	Icon: Component<{ class: string }>;
	text: string;
	href: string;
	isActive: boolean;
}

export const Tab = component$(({ Icon, text, href, isActive }: IProps) => {
	return (
		<li>
			<Link
				href={href}
				class={`group w-full gap-x-2 max-w-48 inline-flex items-center justify-around p-4 rounded-t-lg border-b-2 ${
					isActive
						? 'bg-black text-white border-black'
						: 'border-transparent hover:text-gray-600 hover:border-gray-300'
				}`}
			>
				<Icon
					class={`w-5 h-5 ${
						isActive ? 'text-white' : 'text-gray-400 group-hover:text-gray-500'
					}`}
				/>
				<p class="flex-1">{text}</p>
			</Link>
		</li>
	);
});
