import { Slot, component$, useContext, useOnDocument, $ } from '@qwik.dev/core';
import { AccountNav } from '~/components/account/AccountNav';
import { RequestHandler } from '@qwik.dev/router';
import { APP_STATE, CUSTOMER_NOT_DEFINED_ID, AUTH_TOKEN } from '~/constants';
import { getMe } from '~/services/customer';
import { LocalAddressService } from '~/services/LocalAddressService';
import { sanitizePhoneNumber } from '~/utils/validation';

// T16: Server-side auth guard — redirect to /sign-in if no token
export const onRequest: RequestHandler = async ({ cookie, redirect }) => {
	const token = cookie.get(AUTH_TOKEN)?.value;
	if (!token) throw redirect(302, '/sign-in');
};

export default component$(() => {
	const appState = useContext(APP_STATE);

	// T17: Load customer data on init (qinit — eager, runs right after hydration)
	useOnDocument('qinit', $(async () => {
		const activeCustomer = await getMe();
		if (activeCustomer) {
			appState.customer = {
				title: '',
				firstName: activeCustomer.firstName ?? '',
				id: activeCustomer.id,
				lastName: activeCustomer.lastName ?? '',
				emailAddress: activeCustomer.email,
				phoneNumber: activeCustomer.phone ?? '',
			};

			if (activeCustomer.id !== CUSTOMER_NOT_DEFINED_ID && appState.addressBook.length === 0) {
				try {
					await LocalAddressService.syncFromServer(activeCustomer.id);
					const addresses = LocalAddressService.getAddresses();
					// appState.addressBook / appState.shippingAddress use the
					// checkout area's own long-standing field names — map the
					// native LocalAddress shape onto them at this boundary.
					appState.addressBook = addresses.map((a) => ({
						id: a.id,
						fullName: a.fullName,
						streetLine1: a.line1,
						streetLine2: a.line2 || '',
						company: a.company || '',
						city: a.city,
						province: a.province,
						postalCode: a.postalCode,
						countryCode: a.country,
						phoneNumber: a.phone || '',
						defaultShippingAddress: a.isDefaultShipping,
						defaultBillingAddress: a.isDefaultBilling,
					}));

					if (addresses.length > 0) {
						const defaultShipping = addresses.find(a => a.isDefaultShipping) || addresses[0];
						if (defaultShipping && defaultShipping.phone) {
							appState.customer.phoneNumber = sanitizePhoneNumber(defaultShipping.phone);
						}

						if (defaultShipping && !appState.shippingAddress.streetLine1) {
							appState.shippingAddress = {
								id: defaultShipping.id,
								fullName: defaultShipping.fullName,
								streetLine1: defaultShipping.line1,
								streetLine2: defaultShipping.line2 || '',
								city: defaultShipping.city,
								province: defaultShipping.province,
								postalCode: defaultShipping.postalCode,
								countryCode: defaultShipping.country,
								phoneNumber: defaultShipping.phone || '',
								company: defaultShipping.company || '',
							};

							if (typeof sessionStorage !== 'undefined') {
								sessionStorage.setItem('countryCode', defaultShipping.country);
								sessionStorage.setItem('countrySource', 'customer');
							}
						}
					}
				} catch (error) {
					console.error('Failed to sync addresses in account layout:', error);
				}
			}
		} else {
			window.location.href = '/';
		}
	}));

	return (
		<div class="min-h-screen bg-[var(--color-parchment)]">
			<AccountNav />
			<div class="max-w-[1400px] mx-auto px-4 sm:px-6 lg:px-8 w-full py-6 sm:py-8 lg:py-12">
				<Slot />
			</div>
		</div>
	);
});
