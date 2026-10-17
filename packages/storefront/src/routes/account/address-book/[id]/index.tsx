import { $, component$, useContext, useSignal, useStore, useTask$, useVisibleTask$ } from '@qwik.dev/core';
import { useLocation, useNavigate } from '@qwik.dev/router';
import AddressForm from '~/components/address-form/AddressForm';
import { Button, CheckIcon, XCircleIcon, platformAction } from '~/platform/gateway';
import { APP_STATE } from '~/constants';
import { CountryPreferenceService } from '~/services/CountryPreferenceService';
import { CountryService } from '~/services/CountryService';
import { createAddress, getAddresses, updateAddress, getAddressDrafts, completeAddressDraft, deleteAddressDraft } from '~/services/customer';
import { SellRightError } from '~/sellright/client';
import type { NewAddressInput } from '~/sellright/types/account';
import { ShippingAddress } from '~/types';
import { toShippingAddress } from '~/utils/address-book';
import { createSEOHead } from '~/utils/seo';

const INPUT =
	'block w-full px-[14px] py-[11px] text-[16px] rounded-[3px] border border-[rgba(140,107,58,0.18)] focus:border-[rgba(140,107,58,0.4)] focus:outline-hidden bg-white';

/**
 * Add (`/account/address-book/add/`) or edit (`/account/address-book/<id>/`) one saved address.
 *
 * The shared AddressForm only owns the postal fields (country, postal code, street lines, city, state), so this page
 * adds the two the address book also stores — full name and phone. The saved address is read live from the API (never
 * from state some other page happened to leave behind) and the write goes straight to the API from the form action.
 */
export default component$(() => {
	const navigate = useNavigate();
	const location = useLocation();
	const appState = useContext(APP_STATE);
	const isNew = location.params.id === 'add';
	const isDraft = !isNew && location.url.searchParams.get('draft') === '1';

	const form = useStore<ShippingAddress>({
		fullName: '', streetLine1: '', streetLine2: '', company: '', city: '', province: '', postalCode: '', phoneNumber: '',
		countryCode: '',
	});
	const loaded = useSignal(false);
	const missing = useSignal(false);

	// Only checkout and the cart fill the country list, so opening the address book first left the (required) Country
	// dropdown empty and the form impossible to submit.
	useTask$(async () => {
		if (!appState.availableCountries || appState.availableCountries.length === 0) {
			appState.availableCountries = await CountryService.getAvailableCountries();
		}
	});

	useVisibleTask$(async () => {
		if (isDraft) {
			const draft = (await getAddressDrafts()).find(row => row.id === location.params.id);
			if (!draft) { missing.value = true; return; }
			Object.assign(form, { fullName: draft.fullName ?? '', streetLine1: draft.line1 ?? '', streetLine2: draft.line2 ?? '',
				city: draft.city ?? '', province: draft.province ?? '', postalCode: draft.postalCode ?? '',
				phoneNumber: draft.phone ?? '', countryCode: draft.countryCode ?? '',
				defaultShippingAddress: draft.isDefaultShipping ?? false, defaultBillingAddress: draft.isDefaultBilling ?? false });
			loaded.value = true;
			return;
		}
		if (isNew) {
			// A new address starts in the shopper's remembered destination (US until they choose otherwise).
			form.countryCode = appState.shippingAddress.countryCode || CountryPreferenceService.getCountry();
			loaded.value = true;
			return;
		}
		const found = (await getAddresses()).find((a) => a.id === location.params.id);
		if (!found) { missing.value = true; return; }
		Object.assign(form, toShippingAddress(found));
		loaded.value = true;
	});

	// The write happens in the browser (not in a server action): the API only accepts a cookie-authenticated change
	// together with the CSRF token the browser holds, which a server-side call cannot supply.
	const error = useSignal('');
	const saving = useSignal(false);
	const save = $(async (_: Event, formEl: HTMLFormElement) => {
		error.value = '';
		const f = new FormData(formEl);
		const text = (k: string) => String(f.get(k) ?? '').trim();
		const native: NewAddressInput = {
			fullName: text('fullName'),
			line1: text('streetLine1'),
			line2: text('streetLine2') || null,
			city: text('city'),
			province: text('province') || null,
			postalCode: text('postalCode') || null,
			country: text('countryCode'),
			phone: text('phoneNumber') || null,
			isDefaultShipping: f.get('defaultShippingAddress') === 'true',
			isDefaultBilling: f.get('defaultBillingAddress') === 'true',
		};
		if (!native.fullName || !native.line1 || !native.city || !native.country || (!isDraft && (!native.province || !native.postalCode))) {
			error.value = isDraft
				? 'Please fill in your name, country, street address and city.'
				: 'Please fill in your name, country, street address, city, state and postal code.';
			return;
		}
		saving.value = true;
		try {
			if (isDraft) await completeAddressDraft(location.params.id, native);
			else if (isNew) await createAddress(native);
			else await updateAddress(location.params.id, native);
			await navigate('/account/address-book/');
		} catch (e) {
			error.value = e instanceof SellRightError && e.status === 401
				? 'Please sign in again.'
				: 'We could not save that address. Please check it and try again.';
		} finally {
			saving.value = false;
		}
	});
	const cancel = $(() => { navigate('/account/address-book'); });

	if (missing.value) {
		return (
			<div class="max-w-md mx-auto py-10 text-center">
				<p class="text-gray-700 mb-4">We couldn't find that address.</p>
				<a href="/account/address-book" class="text-[var(--color-accent)] underline">Back to your addresses</a>
			</div>
		);
	}
	if (!loaded.value) return <div class="h-screen" />;

	return (
		<div class="max-w-6xl mx-auto px-4 py-8">
			<div class="mt-8">
				<div class="max-w-md mx-auto">
				<form preventdefault:submit onSubmit$={save} class="space-y-4">
					<div class="grid grid-cols-2 gap-4">
						<div>
							<label for="fullName" class="sr-only">Full name</label>
							<input class={INPUT} id="fullName" name="fullName" type="text" autoComplete="name" placeholder="Full name" required value={form.fullName} />
						</div>
						<div>
							<label for="phoneNumber" class="sr-only">Phone</label>
							<input class={INPUT} id="phoneNumber" name="phoneNumber" type="tel" autoComplete="tel" placeholder="Phone (optional)" value={form.phoneNumber} />
						</div>
					</div>
					{isDraft ? <>
						<h1 class="text-xl font-heading">Needs completion</h1>
						<p class="text-sm text-gray-600">Complete these retained details to create a saved address.</p>
						{[
							['streetLine1', 'Street address', form.streetLine1, true], ['streetLine2', 'Address line 2', form.streetLine2, false],
							['city', 'City', form.city, true], ['province', 'State / province (optional)', form.province, false],
							['postalCode', 'Postal code (optional)', form.postalCode, false], ['countryCode', 'Country code (2 letters)', form.countryCode, true],
						].map(([name, label, value, required]) => <label key={String(name)} class="block text-sm">{label}
							<input class={INPUT} name={String(name)} value={String(value ?? '')} required={Boolean(required)} maxLength={name === 'countryCode' ? 2 : undefined} />
						</label>)}
						<label class="block text-sm"><input type="checkbox" name="defaultShippingAddress" value="true" checked={form.defaultShippingAddress} /> Use completed address as default shipping</label>
						<label class="block text-sm"><input type="checkbox" name="defaultBillingAddress" value="true" checked={form.defaultBillingAddress} /> Use completed address as default billing</label>
						<button type="button" class="underline text-sm" onClick$={async () => {
							try { await deleteAddressDraft(location.params.id); await navigate('/account/address-book/'); }
							catch { error.value = 'We could not delete that address. Please try again.'; }
						}}>Delete retained address</button>
					</> : <AddressForm shippingAddress={form} />}
					{error.value && (
						<div class="rounded-md bg-red-50 p-4 mt-8" role="alert">
							<div class="flex">
								<div class="shrink-0">
									<XCircleIcon />
								</div>
								<div class="ml-3">
									<h3 class="text-sm font-medium text-red-800">We ran into a problem updating your address!</h3>
									<p class="text-sm text-red-700 mt-2">{error.value}</p>
								</div>
							</div>
						</div>
					)}
					<div class="flex mt-8">
						<button
							type="submit"
							disabled={saving.value}
							class="flex items-center justify-around bg-[var(--color-accent)] border border-transparent rounded-md py-2 px-4 text-base font-medium text-white hover:bg-black focus:outline-hidden focus:ring-2 focus:ring-offset-0 focus:ring-gray-800"
						>
							<CheckIcon /> &nbsp; Save
						</button>

						<span class="mr-4" />
						<Button onClick$={platformAction('ui.press', cancel)} icon="x-mark" text=" &nbsp; Cancel" />
					</div>
				</form>
			</div>
			</div>
		</div>
	);
});

export const head = ({ params }: { params: { id: string } }) => {
	const isNewAddress = params.id === 'add';
	return createSEOHead({
		title: isNewAddress ? 'Add New Address' : 'Edit Address',
		description: isNewAddress ? 'Add a new shipping address to your account.' : 'Edit your shipping address details.',
		noindex: true,
	});
};
