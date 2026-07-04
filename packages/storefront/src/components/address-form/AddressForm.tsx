import { component$, useContext, useSignal, $, type QRL, type Signal, useStore, useTask$, useOnDocument } from '@qwik.dev/core';
import { APP_STATE, CUSTOMER_NOT_DEFINED_ID } from '~/constants';
import { ShippingAddress } from '~/types';
import { isActiveCustomerValid } from '~/utils/customer-validators';
import { ValidationIcon } from '~/components/checkout/ValidationIcon';
import { LocalCartService } from '~/services/LocalCartService';
import { lookupPostalCode } from '~/utils/postal-lookup';
import { AddressCountrySelect } from './AddressCountrySelect';
import { AddressTextInput } from './AddressTextInput';
import { loadGuestShippingAddress, saveGuestShippingAddress } from './address-guest-storage';
import {
 ValidationErrors,
 isShippingAddressFieldsValid,
 normalizeShippingAddress,
 validateAddressField,
} from './address-form-utils';

type IProps = {
	shippingAddress: ShippingAddress;
	formApi?: Signal<{ getFormData$?: QRL<() => ShippingAddress> }>;
	isReviewMode?: boolean;
	onUserInteraction$?: QRL<() => void>;
};

export default component$<IProps>(({ shippingAddress, formApi, isReviewMode, onUserInteraction$ }) => {
	const appState = useContext(APP_STATE);
	const validationErrors = useSignal<ValidationErrors>({});
	const touchedFields = useSignal<Set<string>>(new Set());
	const isFormValid = useSignal(false);
	const validationTimer = useSignal<number | null>(null);
	
	const localCountryCode = useSignal(shippingAddress.countryCode || '');
	
	const localFormData = useSignal<{
		streetLine1: string;
		streetLine2: string;
		city: string;
		province: string;
		postalCode: string;
	}>({
		streetLine1: shippingAddress.streetLine1 || '',
		streetLine2: shippingAddress.streetLine2 || '',
		city: shippingAddress.city || '',
		province: shippingAddress.province || '',
		postalCode: shippingAddress.postalCode || '',
	});
	
	const dropdownState = useStore({
		pendingCountryCode: '',
		debounceTimer: null as number | null,
		DEBOUNCE_DELAY: 500
	});

	const hasUserInteracted = useSignal(false);
	const postalLookupSeq = useSignal(0);

	useOnDocument('qinit', $(() => {
		if (appState.customer?.id && appState.customer.id !== CUSTOMER_NOT_DEFINED_ID) return;

		const guestData = loadGuestShippingAddress();
		if (guestData) {
			appState.customer = {
				...appState.customer,
				firstName: guestData.firstName || '',
				lastName: guestData.lastName || '',
				emailAddress: guestData.emailAddress || ''
			};
			appState.shippingAddress = {
				...appState.shippingAddress,
				streetLine1: guestData.streetLine1 || '',
				streetLine2: guestData.streetLine2 || '',
				city: guestData.city || '',
				province: guestData.province || '',
				postalCode: guestData.postalCode || '',
				countryCode: guestData.countryCode || '',
				phoneNumber: guestData.phoneNumber || ''
			};
			localCountryCode.value = guestData.countryCode || '';
		} else {
			const storedCountry = LocalCartService.getCountry();
			if (storedCountry && storedCountry !== appState.shippingAddress.countryCode) {
				appState.shippingAddress.countryCode = storedCountry;
				localCountryCode.value = storedCountry;
			}
		}
	}));

	useTask$(({ track }) => {
		track(() => shippingAddress.streetLine1);
		track(() => shippingAddress.streetLine2);
		track(() => shippingAddress.city);
		track(() => shippingAddress.province);
		track(() => shippingAddress.postalCode);
		track(() => shippingAddress.countryCode);
		
		if (!hasUserInteracted.value) {
			localFormData.value = {
				streetLine1: shippingAddress.streetLine1 || localFormData.value.streetLine1,
				streetLine2: shippingAddress.streetLine2 || localFormData.value.streetLine2,
				city: shippingAddress.city || localFormData.value.city,
				province: shippingAddress.province || localFormData.value.province,
				postalCode: shippingAddress.postalCode || localFormData.value.postalCode,
			};
			
			if (shippingAddress.countryCode && shippingAddress.countryCode !== localCountryCode.value) {
				localCountryCode.value = shippingAddress.countryCode;
			}
		}
	});

	const validateField$ = $((fieldName: string, value: string, countryCode: string = 'US') => {
		const currentErrors = validationErrors.value;
		const errors = validateAddressField(fieldName, value, countryCode, currentErrors);
		
		if (JSON.stringify(currentErrors) !== JSON.stringify(errors)) {
			validationErrors.value = errors;
		}
	});

	const validateAndSync$ = $(() => {
		let mergedAddress = {
			...shippingAddress,
			...localFormData.value,
		};

		mergedAddress = normalizeShippingAddress(mergedAddress);
		const customerValid = isActiveCustomerValid(appState.customer);
		const addressValid = isShippingAddressFieldsValid(mergedAddress);
		const overallValid = addressValid && customerValid;

		isFormValid.value = overallValid;

		if (overallValid) {
			appState.shippingAddress = { ...mergedAddress };
			saveGuestShippingAddress(appState.customer, mergedAddress);
		}
	});

	useTask$(({ track }) => {
		track(() => appState.shippingAddress.countryCode);

		const countryCode = appState.shippingAddress.countryCode || 'US';

		const currentTouched = touchedFields.value;
		let needsUpdate = false;

		if (localFormData.value.streetLine1) {
			if (!currentTouched.has('streetLine1')) {
				touchedFields.value = new Set([...currentTouched, 'streetLine1']);
				needsUpdate = true;
			}
			validateField$('streetLine1', localFormData.value.streetLine1, countryCode);
		}

		if (localFormData.value.city) {
			if (!currentTouched.has('city')) {
				touchedFields.value = new Set([...touchedFields.value, 'city']);
				needsUpdate = true;
			}
			validateField$('city', localFormData.value.city, countryCode);
		}

		if (localFormData.value.postalCode) {
			if (!currentTouched.has('postalCode')) {
				touchedFields.value = new Set([...touchedFields.value, 'postalCode']);
				needsUpdate = true;
			}
			validateField$('postalCode', localFormData.value.postalCode, countryCode);
		}

		if (localFormData.value.province) {
			if (!currentTouched.has('province')) {
				touchedFields.value = new Set([...touchedFields.value, 'province']);
				needsUpdate = true;
			}
			validateField$('province', localFormData.value.province, countryCode);
		}

		if (needsUpdate) {
			setTimeout(() => {
				validateAndSync$();
			}, 100);
		}
	});

	const handleFieldBlur$ = $((fieldName: string, value: string) => {
		if (!touchedFields.value.has(fieldName)) {
			touchedFields.value = new Set([...touchedFields.value, fieldName]);
		}
		
		validateField$(fieldName, value, shippingAddress.countryCode || 'US');
		
		if (validationTimer.value) {
			clearTimeout(validationTimer.value);
		}
		validationTimer.value = setTimeout(() => {
			validateAndSync$();
		}, 300) as unknown as number;
	});

	const handleInputChange$ = $((fieldName: string, value: string | boolean) => {
		if (!hasUserInteracted.value && onUserInteraction$) {
			hasUserInteracted.value = true;
			onUserInteraction$();
		}
		
		if (fieldName === 'countryCode') {
			dropdownState.pendingCountryCode = value as string;
			
			if (dropdownState.debounceTimer !== null) {
				clearTimeout(dropdownState.debounceTimer);
			}
			
			dropdownState.debounceTimer = setTimeout(() => {
				const finalCountryCode = dropdownState.pendingCountryCode;
				
				if (finalCountryCode && finalCountryCode !== appState.shippingAddress.countryCode) {
					appState.shippingAddress.countryCode = finalCountryCode;
					localCountryCode.value = finalCountryCode;
					
					LocalCartService.setCountry(finalCountryCode);

					const country = appState.availableCountries.find(c => c.code === finalCountryCode);
					if (country) {
						appState.shippingAddress.country = country.name;
					}
				}
				
				dropdownState.debounceTimer = null;
			}, dropdownState.DEBOUNCE_DELAY) as any;
		} else {
			(localFormData.value as any)[fieldName] = value;
		}

		if (typeof value === 'string' && touchedFields.value.has(fieldName)) {
			const countryCode = fieldName === 'countryCode' ? value as string : (shippingAddress.countryCode || 'US');
			validateField$(fieldName, value, countryCode);
		}

		const hasAllRequiredFields = 
			localFormData.value.streetLine1.trim() &&
			localFormData.value.city.trim() &&
			localFormData.value.province.trim() &&
			localFormData.value.postalCode.trim();

		if (hasAllRequiredFields) {
			if (validationTimer.value) {
				clearTimeout(validationTimer.value);
			}
			validationTimer.value = setTimeout(() => {
				validateAndSync$();
			}, 300) as unknown as number;
		}
	});

	const runPostalLookup$ = $(async (postalValue: string, countryValue: string) => {
		if (!postalValue || !countryValue) return;
		const seq = ++postalLookupSeq.value;
		const result = await lookupPostalCode(countryValue, postalValue);
		if (seq !== postalLookupSeq.value) return;
		if (!result) return;
		handleInputChange$('city', result.city);
		if (result.province) handleInputChange$('province', result.province);
		localFormData.value = {
			...localFormData.value,
			city: result.city,
			...(result.province ? { province: result.province } : {}),
		};
	});

	const getFieldClasses = (fieldName: string) => {
		const hasError = touchedFields.value.has(fieldName) && validationErrors.value[fieldName as keyof ValidationErrors];
		const baseClasses ="block w-full px-[14px] py-[11px] pr-10 text-[16px] rounded-[3px] border placeholder:text-[rgba(100,85,65,0.42)] focus:outline-hidden transition-colors duration-200 bg-white";
		const errorClasses = hasError
			?"border-red-300 focus:border-red-500 focus:ring-red-500"
			:"border-[rgba(140,107,58,0.18)] focus:border-[rgba(140,107,58,0.4)] focus:ring-[rgba(140,107,58,0.25)]";
		return `${baseClasses} ${errorClasses}`;
	};

	const getSelectClasses = () => {
		return "block w-full px-[14px] py-[11px] text-[16px] rounded-[3px] border placeholder:text-[rgba(100,85,65,0.42)] focus:outline-hidden border-[rgba(140,107,58,0.18)] focus:border-[rgba(140,107,58,0.4)] focus:ring-[rgba(140,107,58,0.25)] transition-colors duration-200 bg-white appearance-none";
	};

	const getFormData$ = $(() => {
		return {
			...shippingAddress,
			...localFormData.value,
			defaultShippingAddress: true,
			defaultBillingAddress: true,
		};
	});

	if (formApi) {
		formApi.value = { getFormData$: getFormData$ };
	}

	return (
		<div class="space-y-4">
					<div class="grid grid-cols-2 gap-4">
						<div>
							<label for="countryCode" class="sr-only">Country</label>
							<AddressCountrySelect
								id="countryCode"
								value={localCountryCode.value}
								countries={appState.availableCountries}
								className={getSelectClasses()}
								disabled={isReviewMode}
								onChange$={$((value: string) => {
									handleInputChange$('countryCode', value);
									if (localFormData.value.postalCode) {
										runPostalLookup$(localFormData.value.postalCode, value);
									}
								})}
							/>
						</div>

						<div>
							<label for="postalCode" class="sr-only">Postal code</label>
							<AddressTextInput
								fieldName="postalCode"
								id="postalCode"
								value={localFormData.value.postalCode}
								autoComplete="postal-code"
								placeholder="Postal code"
								className={getFieldClasses('postalCode')}
								inputMode="numeric"
								onInput$={handleInputChange$}
								onBlur$={handleFieldBlur$}
								afterBlur$={$((value: string) => runPostalLookup$(value, localCountryCode.value))}
								required
								disabled={isReviewMode}
								touched={touchedFields.value.has('postalCode')}
								error={validationErrors.value.postalCode || ''}
								valid={touchedFields.value.has('postalCode') && !validationErrors.value.postalCode && !!(localFormData.value.postalCode)}
							/>
						</div>
					</div>

					<div>
						<label for="streetLine1" class="sr-only">Street address</label>
						<AddressTextInput
							fieldName="streetLine1"
							id="streetLine1"
							value={localFormData.value.streetLine1}
							autoComplete="street-address"
							placeholder="Street address"
							className={getFieldClasses('streetLine1')}
							onInput$={handleInputChange$}
							onBlur$={handleFieldBlur$}
							required
							disabled={isReviewMode}
							touched={touchedFields.value.has('streetLine1')}
							error={validationErrors.value.streetLine1 || ''}
							valid={touchedFields.value.has('streetLine1') && !validationErrors.value.streetLine1 && !!(localFormData.value.streetLine1)}
						/>
					</div>

					<div>
						<label for="streetLine2" class="sr-only">Apt, suite, unit (optional)</label>
						<AddressTextInput
							fieldName="streetLine2"
							id="streetLine2"
							value={localFormData.value.streetLine2}
							autoComplete="address-line2"
							placeholder="Apt, suite, unit (optional)"
							className={getFieldClasses('streetLine2')}
							onInput$={handleInputChange$}
							disabled={isReviewMode}
						/>
					</div>

					<div class="grid grid-cols-2 gap-4">
						<div>
							<label for="city" class="sr-only">City</label>
							<AddressTextInput
								fieldName="city"
								id="city"
								value={localFormData.value.city}
								autoComplete="address-level2"
								placeholder="City"
								className={getFieldClasses('city')}
								onInput$={handleInputChange$}
								onBlur$={handleFieldBlur$}
								required
								disabled={isReviewMode}
								touched={touchedFields.value.has('city')}
								error={validationErrors.value.city || ''}
								valid={touchedFields.value.has('city') && !validationErrors.value.city && !!(localFormData.value.city)}
							/>
						</div>

						<div>
							<label for="province" class="sr-only">State / Province</label>
							<AddressTextInput
								fieldName="province"
								id="province"
								value={localFormData.value.province}
								autoComplete="address-level1"
								placeholder="State / Province"
								className={getFieldClasses('province')}
								onInput$={handleInputChange$}
								onBlur$={handleFieldBlur$}
								required
								disabled={isReviewMode}
								touched={touchedFields.value.has('province')}
								error={validationErrors.value.province || ''}
								valid={touchedFields.value.has('province') && !validationErrors.value.province && !!(localFormData.value.province)}
							/>
						</div>
					</div>

					<input type="hidden" name="defaultShippingAddress" value="true" />
					<input type="hidden" name="defaultBillingAddress" value="true" />
		</div>
	);
});
