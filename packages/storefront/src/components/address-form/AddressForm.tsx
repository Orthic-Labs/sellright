import { component$, useContext, useSignal, $, type QRL, type Signal, useStore, useTask$, useOnDocument } from '@qwik.dev/core';
import { APP_STATE, CUSTOMER_NOT_DEFINED_ID } from '~/constants';
import { ShippingAddress } from '~/types';
import { 
 validatePostalCode,
 validateName,
 validateAddress,
 validateStateProvince
} from '~/utils/validation';
import { isActiveCustomerValid } from '~/utils/customer-validators';
import { ValidationIcon } from '~/components/checkout/ValidationIcon';
import { LocalCartService } from '~/services/LocalCartService';
import { lookupPostalCode } from '~/utils/postal-lookup';

type IProps = {
	shippingAddress: ShippingAddress;
	formApi?: Signal<{ getFormData$?: QRL<() => ShippingAddress> }>;
	isReviewMode?: boolean; // New optional prop
	onUserInteraction$?: QRL<() => void>; // Callback for when user starts interacting
};

interface ValidationErrors {
	streetLine1?: string;
	city?: string;
	province?: string;
	postalCode?: string;
}

// Canonical state/city mapping for India (can be expanded for other countries)
const IN_STATE_MAP: Record<string, string> = {
 'maharashtra': 'Maharashtra',
 'delhi': 'Delhi',
 'karnataka': 'Karnataka',
 'tamil nadu': 'Tamil Nadu',
 'west bengal': 'West Bengal',
 'uttar pradesh': 'Uttar Pradesh',
 'gujarat': 'Gujarat',
 'rajasthan': 'Rajasthan',
 'madhya pradesh': 'Madhya Pradesh',
 'andhra pradesh': 'Andhra Pradesh'
};

const IN_CITY_MAP: Record<string, string> = {
 'mumbai': 'Mumbai',
 'delhi': 'Delhi',
 'bengaluru': 'Bengaluru',
 'bangalore': 'Bengaluru',
 'chennai': 'Chennai',
 'kolkata': 'Kolkata',
 'hyderabad': 'Hyderabad'
};

export default component$<IProps>(({ shippingAddress, formApi, isReviewMode, onUserInteraction$ }) => { // Added onUserInteraction$ to destructuring
	const appState = useContext(APP_STATE);
	const validationErrors = useSignal<ValidationErrors>({});
	const touchedFields = useSignal<Set<string>>(new Set());
	const isFormValid = useSignal(false);
	const validationTimer = useSignal<number | null>(null);
	
	// Local signal for country code to manage UI reactivity independently
	const localCountryCode = useSignal(shippingAddress.countryCode || '');
	
	// Local state for form fields to avoid circular reactivity
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
	
	// Local state for debouncing dropdown selection
	const dropdownState = useStore({
		pendingCountryCode: '',
		debounceTimer: null as number | null,
		DEBOUNCE_DELAY: 500 // 500ms delay to wait for user to finish selecting
	});

	// Track if user has interacted with form
	const hasUserInteracted = useSignal(false);
	const postalLookupSeq = useSignal(0);

	// Load guest address from localStorage and country code — client-only init.
	// localStorage persists across tabs and browser restarts (matches cart pattern).
	// Falls back to legacy sessionStorage key for in-flight users mid-deploy.
	useOnDocument('qinit', $(() => {
		// Skip restoring guest data if user is authenticated — their real data is loaded from Vendure
		if (appState.customer?.id && appState.customer.id !== CUSTOMER_NOT_DEFINED_ID) return;

		if (typeof localStorage === 'undefined') return;

		let storedGuestAddress = localStorage.getItem('guestShippingAddress');
		if (!storedGuestAddress && typeof sessionStorage !== 'undefined') {
			storedGuestAddress = sessionStorage.getItem('guestShippingAddress');
		}

		if (storedGuestAddress) {
			try {
				const guestData = JSON.parse(storedGuestAddress);
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
				}
			} catch (error) {
				console.warn('[AddressForm] Failed to parse guest address from storage:', error);
			}
		} else {
			// No guest address — fall back to country-only from LocalCartService
			const storedCountry = LocalCartService.getCountry();
			if (storedCountry && storedCountry !== appState.shippingAddress.countryCode) {
				appState.shippingAddress.countryCode = storedCountry;
				localCountryCode.value = storedCountry;
			}
		}
	}));

	// Sync shipping address changes to local form data (e.g., after login)
	useTask$(({ track }) => {
		// Track the shipping address fields that might change after login
		track(() => shippingAddress.streetLine1);
		track(() => shippingAddress.streetLine2);
		track(() => shippingAddress.city);
		track(() => shippingAddress.province);
		track(() => shippingAddress.postalCode);
		track(() => shippingAddress.countryCode);
		
		// Update local form data when shipping address changes (but only if user hasn't interacted yet)
		// This ensures address fields are populated when customer logs in
		if (!hasUserInteracted.value) {
			localFormData.value = {
				streetLine1: shippingAddress.streetLine1 || localFormData.value.streetLine1,
				streetLine2: shippingAddress.streetLine2 || localFormData.value.streetLine2,
				city: shippingAddress.city || localFormData.value.city,
				province: shippingAddress.province || localFormData.value.province,
				postalCode: shippingAddress.postalCode || localFormData.value.postalCode,
			};
			
			// Update country code if it changed
			if (shippingAddress.countryCode && shippingAddress.countryCode !== localCountryCode.value) {
				localCountryCode.value = shippingAddress.countryCode;
			}
		}
	});

	// Individual field validation
	const validateField$ = $((fieldName: string, value: string, countryCode: string = 'US') => {
		// No review mode: always validate

		const currentErrors = validationErrors.value;
		const errors = { ...currentErrors };

		switch (fieldName) {
			case 'streetLine1':
				const addressResult = validateAddress(value, 'Street address');
				if (!addressResult.isValid) {
					errors.streetLine1 = addressResult.message;
				} else {
					errors.streetLine1 = '';
				}
				break;
				
			case 'city':
				const cityResult = validateName(value, 'City');
				if (!cityResult.isValid) {
					errors.city = cityResult.message;
				} else {
					errors.city = '';
				}
				break;
				
			case 'province':
				const provinceResult = validateStateProvince(value, countryCode, 'State/Province');
				if (!provinceResult.isValid) {
					errors.province = provinceResult.message;
				} else {
					errors.province = '';
				}
				break;
				
			case 'postalCode':
				const postalResult = validatePostalCode(value, countryCode);
				if (!postalResult.isValid) {
					errors.postalCode = postalResult.message;
				} else {
					errors.postalCode = '';
				}
				break;
		}
		
		// Only update if errors actually changed
		if (JSON.stringify(currentErrors) !== JSON.stringify(errors)) {
			validationErrors.value = errors;
		}
	});

	const validateAndSync$ = $(() => {
		// Merge local form data with shipping address
		const mergedAddress = {
			...shippingAddress,
			...localFormData.value,
		};

		// console.log('[AddressForm] Validating complete address for country:', mergedAddress.countryCode);

		// Apply local normalization for India
		if (mergedAddress.countryCode === 'IN') {
			const cityKey = (mergedAddress.city || '').trim().toLowerCase();
			const provinceKey = (mergedAddress.province || '').trim().toLowerCase();
			
			if (IN_CITY_MAP[cityKey]) mergedAddress.city = IN_CITY_MAP[cityKey];
			if (IN_STATE_MAP[provinceKey]) mergedAddress.province = IN_STATE_MAP[provinceKey];
			
			// Capitalize first letter if not in mapping
			if (!IN_CITY_MAP[cityKey] && mergedAddress.city) {
				mergedAddress.city = mergedAddress.city.charAt(0).toUpperCase() + mergedAddress.city.slice(1);
			}
			if (!IN_STATE_MAP[provinceKey] && mergedAddress.province) {
				mergedAddress.province = mergedAddress.province.charAt(0).toUpperCase() + mergedAddress.province.slice(1);
			}
		}

		// Validate all required fields using the same validation functions as individual fields
		const streetResult = validateAddress(mergedAddress.streetLine1 || '', 'Street address');
		const cityResult = validateName(mergedAddress.city || '', 'City');
		const provinceResult = validateStateProvince(mergedAddress.province || '', mergedAddress.countryCode || 'US', 'State/Province');
		const postalResult = validatePostalCode(mergedAddress.postalCode || '', mergedAddress.countryCode || 'US');
		const customerValid = isActiveCustomerValid(appState.customer);

		const addressValid = streetResult.isValid && cityResult.isValid && provinceResult.isValid && postalResult.isValid;
		const overallValid = addressValid && customerValid;

		// console.log('[AddressForm] Validation results:', {
		// 	street: streetResult.isValid,
		// 	city: cityResult.isValid,
		// 	province: provinceResult.isValid,
		// 	postal: postalResult.isValid,
		// 	customer: customerValid,
		// 	overall: overallValid
		// });

		// Update form validity state
		isFormValid.value = overallValid;

		// Sync to app state if everything is valid
		if (overallValid) {
			// console.log('[AddressForm] All validation passed, syncing to appState');
			appState.shippingAddress = { ...mergedAddress };

			// Save guest address to localStorage for persistence across tabs and browser restarts
			if (typeof localStorage !== 'undefined') {
				try {
					const guestAddressData = {
						firstName: appState.customer.firstName || '',
						lastName: appState.customer.lastName || '',
						emailAddress: appState.customer.emailAddress || '',
						streetLine1: mergedAddress.streetLine1,
						streetLine2: mergedAddress.streetLine2,
						city: mergedAddress.city,
						province: mergedAddress.province,
						postalCode: mergedAddress.postalCode,
						countryCode: mergedAddress.countryCode,
						phoneNumber: mergedAddress.phoneNumber,
						lastUpdated: Date.now()
					};
					localStorage.setItem('guestShippingAddress', JSON.stringify(guestAddressData));
				} catch (error) {
					console.warn('[AddressForm] Failed to save guest address to localStorage:', error);
				}
			}
		} else {
			// console.log('[AddressForm] Validation failed, not syncing to appState');
		}
	});

	// 🚀 NEW: Re-validate country-dependent fields when country changes
	// This ensures pre-filled address fields get validated when user changes country
	useTask$(({ track }) => {
		track(() => appState.shippingAddress.countryCode);

		const countryCode = appState.shippingAddress.countryCode || 'US';
		console.log(`📍 [AddressForm] Country changed to: ${countryCode}, re-validating address fields`);

		// Mark country-dependent fields as touched and re-validate them
		const currentTouched = touchedFields.value;
		let needsUpdate = false;

		// Re-validate street address if it has a value
		if (localFormData.value.streetLine1) {
			if (!currentTouched.has('streetLine1')) {
				touchedFields.value = new Set([...currentTouched, 'streetLine1']);
				needsUpdate = true;
			}
			validateField$('streetLine1', localFormData.value.streetLine1, countryCode);
		}

		// Re-validate city if it has a value
		if (localFormData.value.city) {
			if (!currentTouched.has('city')) {
				touchedFields.value = new Set([...touchedFields.value, 'city']);
				needsUpdate = true;
			}
			validateField$('city', localFormData.value.city, countryCode);
		}

		// Re-validate postal code if it has a value
		if (localFormData.value.postalCode) {
			if (!currentTouched.has('postalCode')) {
				touchedFields.value = new Set([...touchedFields.value, 'postalCode']);
				needsUpdate = true;
			}
			validateField$('postalCode', localFormData.value.postalCode, countryCode);
		}

		// Re-validate state/province if it has a value
		if (localFormData.value.province) {
			if (!currentTouched.has('province')) {
				touchedFields.value = new Set([...touchedFields.value, 'province']);
				needsUpdate = true;
			}
			validateField$('province', localFormData.value.province, countryCode);
		}

		// Trigger complete form validation after field validations
		if (needsUpdate) {
			setTimeout(() => {
				validateAndSync$();
			}, 100);
		}
	});

	// Handle field blur events
	const handleFieldBlur$ = $((fieldName: string, value: string) => {
		// Mark field as touched
		if (!touchedFields.value.has(fieldName)) {
			touchedFields.value = new Set([...touchedFields.value, fieldName]);
		}
		
		// Validate the specific field
		validateField$(fieldName, value, shippingAddress.countryCode || 'US');
		
		// Trigger complete form validation (debounced)
		if (validationTimer.value) {
			clearTimeout(validationTimer.value);
		}
		validationTimer.value = setTimeout(() => {
			validateAndSync$();
		}, 300) as unknown as number;
	});

	// Handle input changes
	const handleInputChange$ = $((fieldName: string, value: string | boolean) => {
		// Notify parent component on first user interaction
		if (!hasUserInteracted.value && onUserInteraction$) {
			hasUserInteracted.value = true;
			onUserInteraction$();
		}
		
		// Handle country code changes with debounced update to both local and global state
		if (fieldName === 'countryCode') {
			// Debounce the update to prevent rapid successive updates
			dropdownState.pendingCountryCode = value as string;
			
			// Clear any existing timer
			if (dropdownState.debounceTimer !== null) {
				clearTimeout(dropdownState.debounceTimer);
			}
			
			// Set a new debounce timer
			dropdownState.debounceTimer = setTimeout(() => {
				const finalCountryCode = dropdownState.pendingCountryCode;
				
				// Only proceed if a country is selected and different from current
				if (finalCountryCode && finalCountryCode !== appState.shippingAddress.countryCode) {
					// console.log('Applying final country selection:', finalCountryCode);
					// console.log('Before update - Global state:', appState.shippingAddress.countryCode, 'Local signal:', localCountryCode.value);

					// Apply the country change to both global and local state
					appState.shippingAddress.countryCode = finalCountryCode;
					localCountryCode.value = finalCountryCode;

					// console.log('After update - Global state:', appState.shippingAddress.countryCode, 'Local signal:', localCountryCode.value);
					
					// Store user selection via LocalCartService (shared cart/country contract)
					LocalCartService.setCountry(finalCountryCode);

					// Find the country name from available countries
					const country = appState.availableCountries.find(c => c.code === finalCountryCode);
					if (country) {
						appState.shippingAddress.country = country.name;
						// console.log('Country name set to:', country.name);
					}
				}
				
				// Clear timer reference
				dropdownState.debounceTimer = null;
			}, dropdownState.DEBOUNCE_DELAY) as any;
		} else {
			// Update local form data for other fields
			(localFormData.value as any)[fieldName] = value;
		}

		// Validate field if it has been touched (only for string fields)
		if (typeof value === 'string' && touchedFields.value.has(fieldName)) {
			const countryCode = fieldName === 'countryCode' ? value as string : (shippingAddress.countryCode || 'US');
			validateField$(fieldName, value, countryCode);
		}

		// Check if all required fields are filled for complete form validation
		const hasAllRequiredFields = 
			localFormData.value.streetLine1.trim() &&
			localFormData.value.city.trim() &&
			localFormData.value.province.trim() &&
			localFormData.value.postalCode.trim();

		if (hasAllRequiredFields) {
			// Debounced complete form validation (standardized to 300ms)
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
		// Always overwrite on successful lookup — postal is the authoritative location signal
		handleInputChange$('city', result.city);
		if (result.province) handleInputChange$('province', result.province);
		localFormData.value = {
			...localFormData.value,
			city: result.city,
			...(result.province ? { province: result.province } : {}),
		};
	});

	// CSS classes for form fields
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

	// Function to collect all form data for submission
	const getFormData$ = $(() => {
		// Automatically set as default shipping address if there's only one address
		const isDefaultShipping = true; // Always set as default shipping
		const isDefaultBilling = true; // Always set as default billing

		return {
			...shippingAddress, // shipping-critical fields (country from appState)
			...localFormData.value, // form fields
			defaultShippingAddress: isDefaultShipping,
			defaultBillingAddress: isDefaultBilling,
		};
	});

	// Expose form API if requested
	if (formApi) {
		formApi.value = { getFormData$: getFormData$ };
	}

	return (
		<div>
			{/* Always show the form, don't depend on shippingAddress.countryCode */}
			{(
				<div class="space-y-4">
					{/* Row 1: Country + Postal Code */}
					<div class="grid grid-cols-2 gap-4">
						{/* Country */}
						<div class="relative">
							<select
								id="countryCode"
								name="countryCode"
								autocomplete="country"
								class={getSelectClasses()}
								value={localCountryCode.value}
								onChange$={(_, el) => {
									console.log(`📍 [AddressForm] Shipping country dropdown changed to: ${el.value}`);
									handleInputChange$('countryCode', el.value);
									if (localFormData.value.postalCode) {
										runPostalLookup$(localFormData.value.postalCode, el.value);
									}
								}}
								aria-label="Country"
								disabled={isReviewMode}
								required
							>
								<option value="" disabled>{`Select a country`}</option>
								{appState.availableCountries.map((item) => (
									<option
										key={item.id}
										value={item.code}
										selected={item.code === localCountryCode.value}
									>
										{item.name}
									</option>
								))}
							</select>
							{/* Custom dropdown arrow */}
							<div class="absolute inset-y-0 right-0 flex items-center pr-2 pointer-events-none">
								<svg class="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path>
								</svg>
							</div>
						</div>

						{/* Postal Code */}
						<div class="relative">
							<input
								type="text"
								inputMode="numeric"
								name="postalCode"
								id="postalCode"
								value={localFormData.value.postalCode}
								autoComplete="postal-code"
								placeholder={`Postal code`}
								class={getFieldClasses('postalCode')}
								onInput$={(_, el) => handleInputChange$('postalCode', el.value)}
								onBlur$={(_, el) => {
									handleFieldBlur$('postalCode', el.value);
									runPostalLookup$(el.value, localCountryCode.value);
								}}
								required
								disabled={isReviewMode}
							/>
							<ValidationIcon
								touched={touchedFields.value.has('postalCode')}
								error={validationErrors.value.postalCode || ''}
								valid={touchedFields.value.has('postalCode') && !validationErrors.value.postalCode && !!(localFormData.value.postalCode)}
							/>
						</div>
					</div>

					{/* Row 2: Street Address — full width */}
					<div class="relative">
						<input
							type="text"
							name="streetLine1"
							id="streetLine1"
							value={localFormData.value.streetLine1}
							autoComplete="street-address"
							placeholder={`Street address`}
							class={getFieldClasses('streetLine1')}
							onInput$={(_, el) => handleInputChange$('streetLine1', el.value)}
							onBlur$={(_, el) => handleFieldBlur$('streetLine1', el.value)}
							required
							disabled={isReviewMode}
						/>
						<ValidationIcon
							touched={touchedFields.value.has('streetLine1')}
							error={validationErrors.value.streetLine1 || ''}
							valid={touchedFields.value.has('streetLine1') && !validationErrors.value.streetLine1 && !!(localFormData.value.streetLine1)}
						/>
					</div>

					{/* Row 2b: Apt/Suite/Unit (optional) — full width */}
					<div>
						<input
							type="text"
							name="streetLine2"
							id="streetLine2"
							value={localFormData.value.streetLine2}
							autoComplete="address-line2"
							placeholder={`Apt, suite, unit (optional)`}
							class={getFieldClasses('streetLine2')}
							onInput$={(_, el) => handleInputChange$('streetLine2', el.value)}
							disabled={isReviewMode}
						/>
					</div>

					{/* Row 3: City + State/Province (auto-filled from postal) */}
					<div class="grid grid-cols-2 gap-4">
						{/* City */}
						<div class="relative">
							<input
								type="text"
								name="city"
								id="city"
								autoComplete="address-level2"
								value={localFormData.value.city}
								placeholder={`City`}
								class={getFieldClasses('city')}
								onInput$={(_, el) => handleInputChange$('city', el.value)}
								onBlur$={(_, el) => handleFieldBlur$('city', el.value)}
								required
								disabled={isReviewMode}
							/>
							<ValidationIcon
								touched={touchedFields.value.has('city')}
								error={validationErrors.value.city || ''}
								valid={touchedFields.value.has('city') && !validationErrors.value.city && !!(localFormData.value.city)}
							/>
						</div>

						{/* State/Province */}
						<div class="relative">
							<input
								type="text"
								name="province"
								id="province"
								value={localFormData.value.province}
								autoComplete="address-level1"
								placeholder={`State / Province`}
								class={getFieldClasses('province')}
								onInput$={(_, el) => handleInputChange$('province', el.value)}
								onBlur$={(_, el) => handleFieldBlur$('province', el.value)}
								required
								disabled={isReviewMode}
							/>
							<ValidationIcon
								touched={touchedFields.value.has('province')}
								error={validationErrors.value.province || ''}
								valid={touchedFields.value.has('province') && !validationErrors.value.province && !!(localFormData.value.province)}
							/>
						</div>
					</div>

					<input type="hidden" name="defaultShippingAddress" value="true" />
					<input type="hidden" name="defaultBillingAddress" value="true" />
				</div>
			)}
		</div>
	);
});
