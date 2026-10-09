import { component$, useContext, useSignal, useVisibleTask$ } from '@qwik.dev/core';
import { useNavigate } from '@qwik.dev/router';
import AddressCard from '~/components/account/AddressCard';
import { HighlightedButton } from '~/components/buttons/HighlightedButton';
import PlusIcon from '~/components/icons/PlusIcon';
import { APP_STATE } from '~/constants';
import {
	deleteAddress,
	getAddresses,
} from '~/services/customer';
import { toShippingAddress } from '~/utils/address-book';
import { createSEOHead } from '~/utils/seo';

export default component$(() => {
	const navigate = useNavigate();
	const appState = useContext(APP_STATE);

	// Always read the book from the API when the page opens: what another page (add / edit / delete, another tab) did a
	// moment ago must show up, and state left in the account layout would not.
	const loaded = useSignal(false);
	const loadError = useSignal(false);
	useVisibleTask$(async () => {
		try {
			appState.addressBook = (await getAddresses()).map(toShippingAddress);
			loaded.value = true;
		} catch {
			loadError.value = true;
		}
	});

	return (
		<div class="space-y-6">
			<div class="mb-6">
				<h1 class="text-2xl font-heading font-medium text-gray-900">Address Book</h1>
				<p class="mt-1 text-sm text-gray-600">Manage your shipping and billing addresses</p>
			</div>
			{loadError.value ? (
				<p class="text-sm text-red-700" role="alert">We could not load your addresses. Please refresh the page.</p>
			) : !loaded.value ? (
				<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
					{[0, 1, 2].map((i) => (
						<div key={i} class="border border-gray-200 rounded-lg p-4 space-y-3">
							<div class="h-5 w-36 bg-gray-200 rounded animate-pulse" />
							<div class="h-4 w-48 bg-gray-200 rounded animate-pulse" />
							<div class="h-4 w-44 bg-gray-200 rounded animate-pulse" />
							<div class="h-4 w-32 bg-gray-200 rounded animate-pulse" />
							<div class="flex gap-2 pt-2">
								<div class="h-8 w-16 bg-gray-200 rounded animate-pulse" />
								<div class="h-8 w-16 bg-gray-200 rounded animate-pulse" />
							</div>
						</div>
					))}
				</div>
			) : appState.addressBook.length === 0 ? (
				<p class="text-sm text-gray-600">No saved addresses yet. Add one below.</p>
			) : (
				<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
					{[...appState.addressBook].map((address) => (
						<AddressCard
							key={address.id}
							address={address}
							onDelete$={async (id) => {
								try {
									await deleteAddress(id);
									// Optimistically update state without full page reload
									appState.addressBook = appState.addressBook.filter((a) => a.id !== id);
								} catch (error) {
									console.error('Failed to delete address:', error);
								}
							}}
						/>
					))}
				</div>
			)}
			<div class="flex justify-center">
				<HighlightedButton
					onClick$={() => {
						navigate('/account/address-book/add/');
					}}
				>
					<PlusIcon /> &nbsp; New Address
				</HighlightedButton>
			</div>
		</div>
	);
});

export const head = () => {
	return createSEOHead({
		title: 'Address Book',
		description: 'Manage your shipping and billing addresses.',
		noindex: true,
	});
};
