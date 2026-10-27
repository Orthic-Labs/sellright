import { component$ } from '@qwik.dev/core';
import XCircleIcon from '../icons/XCircleIcon';

export default component$<{ message: string }>(({ message }) => {
	return (
		<div class="rounded-md bg-red-50 p-4" role="alert">
			<div class="flex">
				<div class="shrink-0">
					<XCircleIcon />
				</div>
				<div class="ml-3">
					<p class="text-sm font-medium text-red-800">{message}</p>
				</div>
			</div>
		</div>
	);
});
