import { $, component$, useOnDocument, useSignal } from '@qwik.dev/core';
import { useLocation } from '@qwik.dev/router';
import XCircleIcon from '~/components/icons/XCircleIcon';
import { updateCustomerEmailAddressMutation } from '~/providers/shop/account/account';
import { createSEOHead } from '~/utils/seo';

export const head = createSEOHead({
	title: 'Verify Email Change',
	description: 'Verify your email address change.',
	noindex: true,
});

export default component$(() => {
	const error = useSignal('');
	const location = useLocation();

	// T37: Verify email change on qinit
	useOnDocument('qinit', $(async () => {
		const updateCustomerEmailAddress = await updateCustomerEmailAddressMutation(
			location.url.href.split('=')[1]
		);

		if (updateCustomerEmailAddress.__typename === 'Success') {
			window.location.href = '/account';
		} else {
			error.value = updateCustomerEmailAddress.message;
		}
	}));

	return (
		<div class="flex flex-col justify-center py-12 sm:px-6 lg:px-8">
			<div class="mt-8 sm:mx-auto sm:w-full sm:max-w-md">
				<div class="bg-white py-8 px-4 shadow-sm sm:rounded-lg sm:px-10">
					{error.value !== '' && (
						<div class="rounded-md bg-red-50 p-4">
							<div class="flex">
								<div class="shrink-0">
									<XCircleIcon />
								</div>
								<div class="ml-3">
									<h3 class="text-sm font-medium text-red-800">
										We ran into a problem verifying your email address change!
									</h3>
									<p class="text-sm text-red-700 mt-2">{error.value}</p>
								</div>
							</div>
						</div>
					)}
				</div>
			</div>
		</div>
	);
});
