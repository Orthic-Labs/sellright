import { $, component$, useContext, useOnDocument, useSignal } from '@qwik.dev/core';
import { isBrowser } from '@qwik.dev/core/build';
import { Button } from '~/components/buttons/Button';
import { HighlightedButton } from '~/components/buttons/HighlightedButton';
import { ErrorMessage } from '~/components/error-message/ErrorMessage';
import CheckIcon from '~/components/icons/CheckIcon';
import PencilSquareIcon from '~/components/icons/PencilSquareIcon';
import ShieldCheckIcon from '~/components/icons/ShieldCheckIcon';
import XMarkIcon from '~/components/icons/XMarkIcon';
import { Modal } from '~/components/modal/Modal';
import { LoyaltyBalanceCard } from '~/components/loyalty/LoyaltyBalanceCard';
import { APP_STATE } from '~/constants';
import {
	requestEmailChange,
	updateProfile,
} from '~/providers/shop/account/account';
import {
	getMeCached,
	getOrders,
} from '~/services/customer';
import { ActiveCustomer } from '~/types';
import { createSEOHead } from '~/utils/seo';
import { sanitizePhoneNumber } from '~/utils/validation';

export default component$(() => {
	const appState = useContext(APP_STATE);
	const isEditing = useSignal(false);
	const showModal = useSignal(false);
	const newEmail = useSignal('');
	const errorMessage = useSignal('');
	const currentPassword = useSignal('');
	const orderCount = useSignal(0);
	const statsLoaded = useSignal(false);
	const update = {
		customer: {} as ActiveCustomer,
	};

	// T17: Load account data on qinit
	useOnDocument('qinit', $(async () => {
		const activeCustomer = await getMeCached();
		if (activeCustomer) {
			appState.customer = {
				title: '',
				firstName: activeCustomer.firstName ?? '',
				id: activeCustomer.id,
				lastName: activeCustomer.lastName ?? '',
				emailAddress: activeCustomer.email,
				phoneNumber: sanitizePhoneNumber(activeCustomer.phone ?? ''),
			};
			newEmail.value = activeCustomer.email;
		}

		// Real total from the API's own pagination — never the page length.
		const orders = await getOrders({ limit: 1 });
		orderCount.value = orders.total;
		statsLoaded.value = true;
	}));

	const updateCustomer = $(async (): Promise<void> => {
		await updateProfile({
			firstName: appState.customer.firstName,
			lastName: appState.customer.lastName,
			phone: appState.customer.phoneNumber,
		});

		appState.customer.emailAddress !== newEmail.value
			? (showModal.value = true)
			: (isEditing.value = false);
	});

	const updateEmail = $(async (password: string, newEmail: string) => {
		const result = await requestEmailChange(newEmail, password);
		if (!result.ok) {
			errorMessage.value = result.message;
		} else {
			errorMessage.value = '';
			isEditing.value = false;
			showModal.value = false;
		}
	});

	return (
		<div>
			{/* Account Details Card */}
			{!isEditing.value && (
				<div class="bg-white rounded-lg shadow-soft border border-gray-100/50 p-6 mb-6">
					<div class="flex items-center justify-between">
						<div>
							<h3 class="text-lg font-heading font-medium text-gray-900 mb-3">Account Details</h3>
							<div class="space-y-2 text-sm">
								<div class="flex items-center gap-2 text-gray-700">
									<span class="font-medium">Email:</span>
									<span>{appState.customer?.emailAddress}</span>
								</div>
								{appState.customer?.phoneNumber && (
									<div class="flex items-center gap-2 text-gray-700">
										<span class="font-medium">Phone:</span>
										<span>{appState.customer?.phoneNumber}</span>
									</div>
								)}
							</div>
						</div>
						<button
							class="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-[#F9F7F4] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] transition-all duration-200 flex items-center gap-2"
							onClick$={() => {
								isEditing.value = true;
								if (isBrowser) {
									window.scrollTo(0, 100);
								}
							}}
						>
							<PencilSquareIcon />
							<span>Edit</span>
						</button>
					</div>
				</div>
			)}

			{/* Quick Stats Panel */}
			<LoyaltyBalanceCard />

			<div class="mb-8">
				{/* Only what the API can actually report: the account order
				    endpoint's real `total`. No per-status breakdown (Delivered,
				    etc.) — the order-history list doesn't carry fulfillment state,
				    so that count would have to be fabricated. */}
				<a href="/account/orders" class="block max-w-xs bg-white rounded-lg p-8 shadow-soft border border-gray-100/50 hover:shadow-medium transition-all duration-300 text-center group cursor-pointer no-underline">
					<div class="flex justify-center mb-4">
						<div class="w-12 h-12 bg-[#F5F0E8] rounded-full flex items-center justify-center transition-colors duration-300">
							<svg class="w-6 h-6 text-[var(--color-accent)] transition-colors duration-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z"></path>
							</svg>
						</div>
					</div>
					<div class="text-4xl font-heading font-light text-[var(--color-accent)] mb-2">
						{statsLoaded.value ? (
							orderCount.value
						) : (
							<div class="h-10 w-16 mx-auto bg-gray-200 rounded animate-pulse" />
						)}
					</div>
					<div class="text-xs uppercase tracking-wider text-gray-600 font-medium mb-3">
						Total Orders
					</div>
					<div class="text-xs text-gray-500 group-hover:text-[var(--color-accent)] transition-colors">
						View all orders →
					</div>
				</a>
			</div>

			{/* Email Change Modal */}
			<Modal
				open={showModal.value}
				title="Confirm E-Mail address change"
				onSubmit$={() => {
					updateEmail(currentPassword.value, newEmail.value);
				}}
				onCancel$={() => {
					showModal.value = false;
				}}
			>
				<div q:slot="modalIcon">
					<ShieldCheckIcon forcedClass="h-10 w-10 text-primary-500" />
				</div>
				<div q:slot="modalContent" class="space-y-4">
					<p>We will send a verification E-Mail to {newEmail.value}</p>

					<div class="space-y-1">
						<label html-for="password">Confirm the change by entering your password:</label>
						<input
							type="password"
							name="password"
							onChange$={(_, el) => {
								currentPassword.value = el.value;
							}}
							class="w-full"
						/>
					</div>

					{errorMessage.value !== '' && (
						<ErrorMessage
							heading="We ran into a problem changing your E-Mail!"
							message={errorMessage.value}
						/>
					)}
				</div>
			</Modal>

			{/* Edit Profile Form */}
			{isEditing.value && (
				<div class="bg-white rounded-lg shadow-soft border border-gray-100/50 p-6 mb-6">
					<h3 class="text-lg font-heading font-medium text-gray-900 mb-6">Edit Profile</h3>

					<div class="gap-4 grid grid-cols-1 md:grid-cols-2">
						<div class="md:col-span-2 md:w-1/4">
							<label class="block text-sm font-medium text-gray-700 mb-1">Title</label>
							<input
								type="text"
								value={appState.customer?.title}
								onInput$={(_, el) => {
									update.customer.title = el.value;
								}}
								class="block w-full border-gray-300 rounded-md shadow-sm focus:ring-[var(--color-accent)] focus:border-[var(--color-accent)] text-sm"
							/>
						</div>

						<div>
							<label html-for="firstName" class="block text-sm font-medium text-gray-700 mb-1">
								First Name
							</label>
							<input
								type="text"
								value={appState.customer?.firstName}
								onChange$={(_, el) => {
									if (el.value !== '') {
										update.customer.firstName = el.value;
									}
								}}
								class="block w-full border-gray-300 rounded-md shadow-sm focus:ring-[var(--color-accent)] focus:border-[var(--color-accent)] text-sm"
							/>
						</div>

						<div>
							<label html-for="lastName" class="block text-sm font-medium text-gray-700 mb-1">
								Last Name
							</label>
							<input
								type="text"
								value={appState.customer?.lastName}
								onChange$={(_, el) => {
									if (el.value !== '') {
										update.customer.lastName = el.value;
									}
								}}
								class="block w-full border-gray-300 rounded-md shadow-sm focus:ring-[var(--color-accent)] focus:border-[var(--color-accent)] text-sm"
							/>
						</div>

						<div>
							<label class="block text-sm font-medium text-gray-700 mb-1">E-Mail</label>
							<input
								type="email"
								value={appState.customer?.emailAddress}
								onChange$={(_, el) => {
									if (el.value !== '') {
										newEmail.value = el.value;
									}
								}}
								class="block w-full border-gray-300 rounded-md shadow-sm focus:ring-[var(--color-accent)] focus:border-[var(--color-accent)] text-sm"
							/>
						</div>

						<div>
							<label class="block text-sm font-medium text-gray-700 mb-1">Phone Number</label>
							<input
								type="tel"
								value={appState.customer?.phoneNumber}
								onChange$={(_, el) => {
									update.customer.phoneNumber = el.value;
								}}
								class="block w-full border-gray-300 rounded-md shadow-sm focus:ring-[var(--color-accent)] focus:border-[var(--color-accent)] text-sm"
							/>
						</div>
					</div>

					<div class="flex gap-3 mt-6">
						<HighlightedButton
							onClick$={() => {
								appState.customer = { ...appState.customer, ...update.customer };
								updateCustomer();
							}}
						>
							<CheckIcon /> &nbsp; Save Changes
						</HighlightedButton>

						<Button
							onClick$={() => {
								isEditing.value = false;
							}}
						>
							<XMarkIcon forcedClass="w-4 h-4" /> &nbsp; Cancel
						</Button>
					</div>
				</div>
			)}
		</div>
	);
});

export const head = () => {
	return createSEOHead({
		title: 'My Account',
		description: 'Manage your account settings, view orders, update personal information and shipping addresses.',
		noindex: true,
	});
};
