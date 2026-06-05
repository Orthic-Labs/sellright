import { Slot, component$, useContext, useOnDocument, $ } from '@qwik.dev/core';
import { AccountNav } from '~/components/account/AccountNav';
import { RequestHandler } from '@qwik.dev/router';
import { APP_STATE, CUSTOMER_NOT_DEFINED_ID, AUTH_TOKEN } from '~/constants';
import { getActiveCustomerQuery } from '~/providers/shop/customer/customer';
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
		const activeCustomer = await getActiveCustomerQuery();
		if (activeCustomer) {
			appState.customer = {
				title: activeCustomer.title ?? '',
				firstName: activeCustomer.firstName,
				id: activeCustomer.id,
				lastName: activeCustomer.lastName,
				emailAddress: activeCustomer.emailAddress,
				phoneNumber: activeCustomer.phoneNumber ?? '',
			};

			if (activeCustomer.id !== CUSTOMER_NOT_DEFINED_ID && appState.addressBook.length === 0) {
				try {
					await LocalAddressService.syncFromVendure(activeCustomer.id);
					const addresses = LocalAddressService.getAddresses();
					appState.addressBook = addresses;

					if (addresses.length > 0) {
						const defaultShipping = addresses.find(a => a.defaultShippingAddress) || addresses[0];
						if (defaultShipping && defaultShipping.phoneNumber) {
							appState.customer.phoneNumber = sanitizePhoneNumber(defaultShipping.phoneNumber);
						}

						if (defaultShipping && !appState.shippingAddress.streetLine1) {
							appState.shippingAddress = {
								id: defaultShipping.id,
								fullName: defaultShipping.fullName,
								streetLine1: defaultShipping.streetLine1,
								streetLine2: defaultShipping.streetLine2 || '',
								city: defaultShipping.city,
								province: defaultShipping.province,
								postalCode: defaultShipping.postalCode,
								countryCode: defaultShipping.countryCode,
								phoneNumber: defaultShipping.phoneNumber || '',
								company: defaultShipping.company || '',
							};

							if (typeof sessionStorage !== 'undefined') {
								sessionStorage.setItem('countryCode', defaultShipping.countryCode);
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
		<div class="min-h-screen bg-[#F7F2EA]">
			<AccountNav />
			<div class="max-w-[1400px] mx-auto px-4 sm:px-6 lg:px-8 w-full py-6 sm:py-8 lg:py-12">
				<Slot />
			</div>
		</div>
	);
});
