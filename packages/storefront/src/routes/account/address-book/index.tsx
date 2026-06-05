import { component$, useContext, useSignal } from '@qwik.dev/core';
import { useNavigate } from '@qwik.dev/router';
import AddressCard from '~/components/account/AddressCard';
import { HighlightedButton } from '~/components/buttons/HighlightedButton';
import PlusIcon from '~/components/icons/PlusIcon';
import { APP_STATE } from '~/constants';
import {
	deleteCustomerAddressMutation,
} from '~/providers/shop/customer/customer';
import { ShippingAddress } from '~/types';
import { createSEOHead } from '~/utils/seo';

export default component$(() => {
	const navigate = useNavigate();
	const appState = useContext(APP_STATE);

	// Use addresses from SSR data (loaded in layout) - already converted to ShippingAddress format
	const shippingAddresses: ShippingAddress[] = appState.addressBook;

	const activeCustomerAddresses = useSignal<{ id: string; addresses: ShippingAddress[] }>({
		id: appState.customer.id,
		addresses: shippingAddresses
	});

	const loaded = activeCustomerAddresses.value;

	return (
		<div class="space-y-6">
			<div class="mb-6">
				<h1 class="text-2xl font-heading font-medium text-gray-900">Address Book</h1>
				<p class="mt-1 text-sm text-gray-600">Manage your shipping and billing addresses</p>
			</div>
			{!loaded ? (
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
				<p class="text-sm text-gray-600">No addresses found. Addresses will appear here after you place an order.</p>
			) : (
				<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
					{[...appState.addressBook].map((address) => (
						<AddressCard
							key={address.id}
							address={address}
							onDelete$={async (id) => {
								try {
									await deleteCustomerAddressMutation(id);
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
