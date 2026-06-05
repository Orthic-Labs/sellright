import { $, Signal, component$, useSignal, useVisibleTask$ } from '@qwik.dev/core';
import type { QRL } from '@qwik.dev/core';
import { processNMIPayment } from '~/providers/shop/checkout/checkout';
import { useCheckoutValidationActions } from '~/contexts/CheckoutValidationContext';

import { ValidationIcon } from '~/components/checkout/ValidationIcon';
import {
	validateCardNumber,
	validateCVV,
	validateExpiryDate,
	formatCardNumber,
	formatExpiryDate,
	type CardValidationResult
} from '~/utils/card-validation';

/**
 * 🚀 Enhanced NMI Payment Component with Smart Field Navigation
 * 
 * Features implemented:
 * - Auto-advance to next field when current field is complete
 * - Smart expiry date formatting (typing "426" becomes "04/26" and advances to CVV)
 * - Intelligent field focus management with keyboard navigation
 * - Backspace navigation to previous field when current field is empty
 * - Enter key support for field navigation and form submission
 * - Enhanced UX similar to Stripe's payment forms
 */

// Moved CardValidationErrors to module scope
interface CardValidationErrors {
 cardNumber?: string;
 cvv?: string;
 expiryDate?: string;
}

export interface CardFormData {
	cardNumber: string;
	expiryDate: string;
	cvv: string;
}

interface NMIProps {
	isDisabled?: boolean;
	hideButton?: boolean;
	onForward$: QRL<(orderCode: string) => void>;
 onError$: QRL<(errorMessage: string) => void>;
 onProcessingChange$?: QRL<(isProcessing: boolean) => void>;
 triggerSignal: Signal<number>; // Incremented by parent to trigger submission
}

export default component$<NMIProps>(({ isDisabled, hideButton = false, onForward$, onError$, onProcessingChange$, triggerSignal }) => {

	const cardData = useSignal<CardFormData>({
		cardNumber: '',
		cvv: '',
		expiryDate: ''
	});

 const validationErrors = useSignal<CardValidationErrors>({});
	const isProcessing = useSignal(false);
	const error = useSignal('');
 const isValid = useSignal(false);
 const validationActions = useCheckoutValidationActions();
 
 // Individual field touched states - following customer/address pattern
 const cardNumberTouched = useSignal<boolean>(false);
 const cvvTouched = useSignal<boolean>(false);
 const expiryDateTouched = useSignal<boolean>(false);
 
 // Individual field validation states
 const cardNumberValid = useSignal<boolean>(false);
 const cvvValid = useSignal<boolean>(false);
 const expiryDateValid = useSignal<boolean>(false);

	// Update payment validation context based on individual field states
	const updatePaymentValidationContext = $(() => {
		const allFieldsValid = cardNumberValid.value && cvvValid.value && expiryDateValid.value;
		const anyFieldTouched = cardNumberTouched.value || cvvTouched.value || expiryDateTouched.value;
		
		// Only consider payment section valid if ALL individual fields are valid
		isValid.value = allFieldsValid;
		
		// Update the checkout validation context
		validationActions.updatePaymentValidation(
			allFieldsValid,
			{
				cardNumber: validationErrors.value.cardNumber,
				cvv: validationErrors.value.cvv,
				expiryDate: validationErrors.value.expiryDate
			},
			anyFieldTouched // Payment form is touched when any field has been touched
		);
		
	});

	// Individual field validation function - follows customer/address pattern
	const validateField = $((field: keyof CardFormData, value: string) => {
		let validation: CardValidationResult;

		switch (field) {
			case 'cardNumber':
				validation = validateCardNumber(value);
				cardNumberValid.value = validation.isValid;
				break;
			case 'cvv':
				// Enhanced CVV validation using card number for better accuracy
				const cardNumberValidation = validateCardNumber(cardData.value.cardNumber);
				if (cardNumberValidation.isValid && cardNumberValidation.cardBrand) {
					// Use card brand specific validation when available
					const cvvLength = cardNumberValidation.cardBrand === 'american-express' ? 4 : 3;
					validation = validateCVV(value);
					// Override with more specific error if needed
					if (!validation.isValid && value.replace(/\D/g, '').length !== cvvLength) {
						validation.errorMessage = `Security code must be ${cvvLength} digits for ${cardNumberValidation.cardBrand}`;
					}
				} else {
					validation = validateCVV(value);
				}
				cvvValid.value = validation.isValid;
				break;
			case 'expiryDate':
				validation = validateExpiryDate(value);
				expiryDateValid.value = validation.isValid;
				break;
			default:
				validation = { isValid: true, errorMessage: '' };
		}

		// Update validation errors for this field
		validationErrors.value = {
			...validationErrors.value,
			[field]: validation.isValid ? undefined : validation.errorMessage
		};

		// Update overall payment validation in the checkout context
		updatePaymentValidationContext();

		return validation.isValid;
	});

	// 🚀 Smart field navigation functions
	const focusNextField = $((currentFieldId: string) => {
		if (typeof document === 'undefined') return;
		
		const fieldOrder = ['cardNumber', 'expiryDate', 'cvv'];
		const currentIndex = fieldOrder.indexOf(currentFieldId);
		const nextIndex = currentIndex + 1;
		
		if (nextIndex < fieldOrder.length) {
			const nextField = document.getElementById(fieldOrder[nextIndex]);
			if (nextField) {
				nextField.focus();
			}
		}
	});

	const focusPreviousField = $((currentFieldId: string) => {
		if (typeof document === 'undefined') return;
		
		const fieldOrder = ['cardNumber', 'expiryDate', 'cvv'];
		const currentIndex = fieldOrder.indexOf(currentFieldId);
		const previousIndex = currentIndex - 1;
		
		if (previousIndex >= 0) {
			const previousField = document.getElementById(fieldOrder[previousIndex]);
			if (previousField) {
				previousField.focus();
				// Position cursor at end
				setTimeout(() => {
					if (previousField instanceof HTMLInputElement) {
						previousField.setSelectionRange(previousField.value.length, previousField.value.length);
					}
				}, 0);
			}
		}
	});

	// Enhanced keyboard navigation handler
	const handleKeyDown = $((event: KeyboardEvent, fieldId: string) => {
		// Handle backspace on empty fields to go to previous field
		if (event.key === 'Backspace') {
			const target = event.target as HTMLInputElement;
			if (target.value === '' || target.selectionStart === 0) {
				focusPreviousField(fieldId);
			}
		}
		// Handle Enter to move to next field or submit
		else if (event.key === 'Enter') {
			if (fieldId === 'cvv') {
				// Submit form if on last field
				submitPaymentForm();
			} else {
				focusNextField(fieldId);
			}
		}
	});

	// Check if field is complete AND valid before allowing auto-advance
	const isFieldCompleteAndValid = $((field: keyof CardFormData, value: string): boolean => {
		switch (field) {
			case 'cardNumber':
				// Card number must be valid (correct format and length for card type)
				const cardValidation = validateCardNumber(value.replace(/\D/g, ''));
				return cardValidation.isValid;
			case 'expiryDate':
				// Expiry must be valid format AND not in the past
				if (value.length !== 5 || !/^\d{2}\/\d{2}$/.test(value)) {
					return false;
				}
				const expiryValidation = validateExpiryDate(value.replace(/\D/g, ''));
				return expiryValidation.isValid;
			case 'cvv':
				// CVV must be correct length for card type
				const cardNumberValidation = validateCardNumber(cardData.value.cardNumber.replace(/\D/g, ''));
				const expectedLength = (cardNumberValidation.cardBrand === 'american-express') ? 4 : 3;
				const cvvDigits = value.replace(/\D/g, '');
				if (cvvDigits.length !== expectedLength) {
					return false;
				}
				const cvvValidation = validateCVV(cvvDigits);
				return cvvValidation.isValid;
			default:
				return false;
		}
	});

	// 🚀 Smart expiry date formatting (like Stripe)
	const formatExpiryDateSmart = $((input: string): string => {
		const digitsOnly = input.replace(/\D/g, '');
		
		if (digitsOnly.length === 0) return '';
		if (digitsOnly.length === 1) {
			// If first digit is > 1, prepend 0 (e.g., "4" becomes "04")
			if (parseInt(digitsOnly) > 1) {
				return `0${digitsOnly}/`;
			}
			return digitsOnly;
		}
		if (digitsOnly.length === 2) {
			// Check if we have a valid month
			const month = parseInt(digitsOnly);
			if (month > 12) {
				// Invalid month, restructure as 0X/Y
				return `0${digitsOnly[0]}/${digitsOnly[1]}`;
			}
			return `${digitsOnly}/`;
		}
		if (digitsOnly.length === 3) {
			// Handle case where user types 3 digits (e.g., "426")
			const month = parseInt(digitsOnly.slice(0, 2));
			if (month > 12) {
				// Restructure as 0X/YZ
				return `0${digitsOnly[0]}/${digitsOnly.slice(1)}`;
			}
			return `${digitsOnly.slice(0, 2)}/${digitsOnly.slice(2)}`;
		}
		if (digitsOnly.length >= 4) {
			// Full date: MMYY
			return `${digitsOnly.slice(0, 2)}/${digitsOnly.slice(2, 4)}`;
		}
		
		return formatExpiryDate(digitsOnly);
	});
	
	// Individual field blur handlers - following customer/address pattern
	const handleCardNumberBlur$ = $(() => {
		cardNumberTouched.value = true;
		// Extract digits for validation, but keep formatted value in state
		const digitsOnly = cardData.value.cardNumber.replace(/\D/g, '');
		validateField('cardNumber', digitsOnly);
	});
	
	const handleCvvBlur$ = $(() => {
		cvvTouched.value = true;
		validateField('cvv', cardData.value.cvv);
	});
	
	const handleExpiryDateBlur$ = $(() => {
		expiryDateTouched.value = true;
		// Extract digits for validation, but keep formatted value in state
		const digitsOnly = cardData.value.expiryDate.replace(/\D/g, '');
		validateField('expiryDate', digitsOnly);
	});

	// Validate all card details at once - QRL function for Qwik serialization
	const validateCard = $(async () => {
		// Mark all fields as touched when doing complete validation
		cardNumberTouched.value = true;
		cvvTouched.value = true;
		expiryDateTouched.value = true;
		
		// Perform individual field validation for all fields
		const cardNumberResult = await validateField('cardNumber', cardData.value.cardNumber);
		const cvvResult = await validateField('cvv', cardData.value.cvv);
		const expiryDateResult = await validateField('expiryDate', cardData.value.expiryDate);
		
		// Overall validation is based on all individual fields being valid
		const allValid = cardNumberResult && cvvResult && expiryDateResult;
		isValid.value = allValid;
		
		
		return allValid;
	});

	// Core submission logic for NMI payment
	const submitPaymentForm = $(async () => {
		error.value = '';
		const isFormValid = await validateCard();
		if (!isFormValid) {
			error.value = 'Please check your card details and try again.';
			return;
		}

		if (isProcessing.value) {
			return;
		}

		try {
			isProcessing.value = true;
  // Notify parent about processing state change
  if (onProcessingChange$) {
  await onProcessingChange$(true);
  }

			// Process the payment with the card data
			const paymentResult = await processNMIPayment({
				cardNumber: cardData.value.cardNumber.replace(/\D/g, ''),
				expiryDate: cardData.value.expiryDate.replace(/\D/g, ''),
				cvv: cardData.value.cvv.replace(/\D/g, ''),
			});


			if (paymentResult?.__typename === 'Order') {
				// Call the success callback with the order code
				await onForward$(paymentResult.code);
			} else {
				console.error('[NMI] Payment failed with result:', paymentResult);
				let errorMsg = 'Payment processing failed. Please try again.';
				if (paymentResult && typeof paymentResult === 'object' && 'errorMessage' in paymentResult) {
					errorMsg = paymentResult.errorMessage as string;
				}
				throw new Error(errorMsg);
			}
		} catch (err) {
			console.error('[NMI] Payment error:', err);
			error.value = err instanceof Error ? err.message : 'An unknown error occurred during payment processing.';
			// Call the error callback with the error message
			await onError$(error.value);
		} finally {
				isProcessing.value = false;
  // Notify parent about processing state change
  if (onProcessingChange$) {
   await onProcessingChange$(false);
  }
		}
	});

 // Watch for trigger signal from parent component
 useVisibleTask$(({track}) => {
   track(() => triggerSignal.value);
   // Ensure we only trigger if the signal has a positive value (indicating a new attempt)
   // and we are not already processing a payment.
   if (triggerSignal.value > 0) {
     if (!isProcessing.value) {
       submitPaymentForm();
     }
   }
 });

	return (
		<div class={`w-full ${isDisabled ? 'opacity-50 pointer-events-none' : ''} border-0`}>
			{/* Accepted cards */}
			<div class="flex items-center gap-1.5 mb-3">
				{/* Visa */}
				<div class="bg-white border border-[rgba(140,107,58,0.12)] rounded flex items-center justify-center" style="width:44px;height:28px">
					<svg width="32" height="20" viewBox="0 0 750 471">
						<rect width="750" height="471" rx="40" fill="#fff"/>
						<path d="M278.2 334.2h-60.6l37.9-233.9h60.6L278.2 334.2z" fill="#00579f"/>
						<path d="M524.3 105.6c-12-4.6-30.8-9.5-54.3-9.5-59.8 0-101.9 31.8-102.3 77.3-.3 33.7 30.1 52.4 53 63.6 23.6 11.5 31.5 18.8 31.4 29.1-.2 15.7-18.8 22.9-36.2 22.9-24.2 0-37.1-3.5-57-12.2l-7.8-3.7-8.5 52.4c14.1 6.5 40.3 12.2 67.5 12.5 63.6 0 104.9-31.4 105.4-80 .2-26.7-15.9-47-50.9-63.7-21.2-10.8-34.2-18.1-34.1-29.1 0-9.7 11-20.1 34.8-20.1 19.9-.3 34.3 4.2 45.5 9l5.5 2.7 8.3-51.2z" fill="#00579f"/>
						<path d="M661.6 100.3h-46.8c-14.5 0-25.3 4.2-31.7 19.5L487.8 334.2h63.6s10.4-28.9 12.7-35.2h77.7c1.8 8.2 7.4 35.2 7.4 35.2H706L661.6 100.3zm-74.8 181.6c5-13.5 24.2-65.6 24.2-65.6-.3.6 5-13.7 8.1-22.5l4.1 20.3s11.6 56.1 14.1 67.8h-50.5z" fill="#00579f"/>
						<path d="M232.8 100.3L173.5 261l-6.4-32.5c-11-37.5-45.5-78.2-84-98.5l54.2 204h64l95.3-233.7h-63.8z" fill="#00579f"/>
						<path d="M120 100.3H22.4l-.8 4.5C97.7 120.1 149 163.5 167.1 228.5L148.7 120c-3.1-15-14.3-19.3-28.7-19.7z" fill="#faa61a"/>
					</svg>
				</div>
				{/* Mastercard */}
				<div class="bg-white border border-[rgba(140,107,58,0.12)] rounded flex items-center justify-center" style="width:44px;height:28px">
					<svg width="32" height="20" viewBox="0 0 750 471">
						<rect width="750" height="471" rx="40" fill="#fff"/>
						<circle cx="292" cy="235.5" r="140" fill="#EB001B"/>
						<circle cx="458" cy="235.5" r="140" fill="#F79E1B"/>
						<path d="M375 130.7c35.3 27.6 58 70.6 58 119.3s-22.7 91.7-58 119.3c-35.3-27.6-58-70.6-58-119.3s22.7-91.7 58-119.3z" fill="#FF5F00"/>
					</svg>
				</div>
				{/* Amex */}
				<div class="bg-[#2557D6] border border-[rgba(140,107,58,0.12)] rounded flex items-center justify-center" style="width:44px;height:28px">
					<svg width="32" height="20" viewBox="0 0 750 471">
						<rect width="750" height="471" rx="40" fill="#2557D6"/>
						<text x="375" y="260" text-anchor="middle" fill="#fff" font-family="Arial,sans-serif" font-size="120" font-weight="bold">AMEX</text>
					</svg>
				</div>
				{/* Maestro */}
				<div class="bg-white border border-[rgba(140,107,58,0.12)] rounded flex items-center justify-center" style="width:44px;height:28px">
					<svg width="32" height="20" viewBox="0 0 750 471">
						<rect width="750" height="471" rx="40" fill="#fff"/>
						<circle cx="292" cy="235.5" r="140" fill="#0099DF"/>
						<circle cx="458" cy="235.5" r="140" fill="#000"/>
						<path d="M375 130.7c35.3 27.6 58 70.6 58 119.3s-22.7 91.7-58 119.3c-35.3-27.6-58-70.6-58-119.3s22.7-91.7 58-119.3z" fill="#00588B"/>
					</svg>
				</div>
				{/* Diners */}
				<div class="bg-white border border-[rgba(140,107,58,0.12)] rounded flex items-center justify-center" style="width:44px;height:28px">
					<svg width="32" height="20" viewBox="0 0 750 471">
						<rect width="750" height="471" rx="40" fill="#fff"/>
						<circle cx="375" cy="235.5" r="150" fill="none" stroke="#0079BE" stroke-width="30"/>
						<path d="M300 150v171M450 150v171" stroke="#0079BE" stroke-width="20" stroke-linecap="round"/>
					</svg>
				</div>
				{/* JCB */}
				<div class="bg-white border border-[rgba(140,107,58,0.12)] rounded flex items-center justify-center" style="width:44px;height:28px">
					<svg width="32" height="20" viewBox="0 0 750 471">
						<rect width="750" height="471" rx="40" fill="#fff"/>
						<rect x="200" y="100" width="100" height="271" rx="30" fill="#047AB1"/>
						<rect x="325" y="100" width="100" height="271" rx="30" fill="#D42D06"/>
						<rect x="450" y="100" width="100" height="271" rx="30" fill="#5EA630"/>
						<text x="250" y="270" text-anchor="middle" fill="#fff" font-family="Arial,sans-serif" font-size="70" font-weight="bold">J</text>
						<text x="375" y="270" text-anchor="middle" fill="#fff" font-family="Arial,sans-serif" font-size="70" font-weight="bold">C</text>
						<text x="500" y="270" text-anchor="middle" fill="#fff" font-family="Arial,sans-serif" font-size="70" font-weight="bold">B</text>
					</svg>
				</div>
			</div>

			{/* Card Fields - Single Line Layout */}
			<div class="grid grid-cols-4 gap-4 w-full mb-2">

				{/* Card Number: Half width (2 columns) */}
				<div class="col-span-2 relative">
					<label for="cardNumber" class="sr-only">Card Number</label>
					<input
						id="cardNumber"
						type="text"
						placeholder="Card Number"
						value={cardData.value.cardNumber}
						maxLength={19}
						class={`block w-full px-[14px] py-[11px] pr-10 text-[16px] rounded-[3px] border placeholder:text-[rgba(100,85,65,0.42)] focus:outline-hidden transition-colors duration-200 bg-white ${
							cardNumberTouched.value && validationErrors.value.cardNumber
								? 'border-red-300 focus:border-red-500 focus:ring-red-500'
								: 'border-[rgba(140,107,58,0.18)] focus:border-[rgba(140,107,58,0.4)] focus:ring-[rgba(140,107,58,0.25)]'
						}`}
						onInput$={async (_, el) => {
							const digitsOnly = el.value.replace(/\D/g, '');
							const formattedValue = formatCardNumber(digitsOnly);
							cardData.value = { ...cardData.value, cardNumber: formattedValue };
							const isValid = await validateField('cardNumber', digitsOnly);
							const isComplete = await isFieldCompleteAndValid('cardNumber', formattedValue);
							if (isComplete && isValid) {
								focusNextField('cardNumber');
							}
						}}
						onKeyDown$={(event) => handleKeyDown(event, 'cardNumber')}
						onBlur$={handleCardNumberBlur$}
					/>
					<ValidationIcon
						touched={cardNumberTouched.value}
						error={validationErrors.value.cardNumber || ''}
						valid={cardNumberTouched.value && !validationErrors.value.cardNumber && cardNumberValid.value}
					/>
				</div>

				{/* Expiry Date: Quarter width (1 column) */}
				<div class="col-span-1 relative">
					<label for="expiryDate" class="sr-only">Expiry</label>
					<input
						id="expiryDate"
						type="text"
						placeholder="MM/YY"
						value={cardData.value.expiryDate}
						maxLength={5}
						class={`block w-full px-[14px] py-[11px] pr-10 text-[16px] rounded-[3px] border placeholder:text-[rgba(100,85,65,0.42)] focus:outline-hidden transition-colors duration-200 bg-white ${
							expiryDateTouched.value && validationErrors.value.expiryDate
								? 'border-red-300 focus:border-red-500 focus:ring-red-500'
								: 'border-[rgba(140,107,58,0.18)] focus:border-[rgba(140,107,58,0.4)] focus:ring-[rgba(140,107,58,0.25)]'
						}`}
						onInput$={async (_, el) => {
							const formattedValue = await formatExpiryDateSmart(el.value);
							cardData.value = { ...cardData.value, expiryDate: formattedValue };
							const digitsOnly = formattedValue.replace(/\D/g, '');
							const isValid = await validateField('expiryDate', digitsOnly);
							const isComplete = await isFieldCompleteAndValid('expiryDate', formattedValue);
							if (isComplete && isValid) {
								focusNextField('expiryDate');
							}
						}}
						onKeyDown$={(event) => handleKeyDown(event, 'expiryDate')}
						onBlur$={handleExpiryDateBlur$}
					/>
					<ValidationIcon
						touched={expiryDateTouched.value}
						error={validationErrors.value.expiryDate || ''}
						valid={expiryDateTouched.value && !validationErrors.value.expiryDate && expiryDateValid.value}
					/>
				</div>

				{/* CVV: Quarter width (1 column) */}
				<div class="col-span-1 relative">
					<label for="cvv" class="sr-only">CVV</label>
					<input
						id="cvv"
						type="text"
						placeholder="CVV"
						value={cardData.value.cvv}
						maxLength={4}
						class={`block w-full px-[14px] py-[11px] pr-10 text-[16px] rounded-[3px] border placeholder:text-[rgba(100,85,65,0.42)] focus:outline-hidden transition-colors duration-200 bg-white ${
							cvvTouched.value && validationErrors.value.cvv
								? 'border-red-300 focus:border-red-500 focus:ring-red-500'
								: 'border-[rgba(140,107,58,0.18)] focus:border-[rgba(140,107,58,0.4)] focus:ring-[rgba(140,107,58,0.25)]'
						}`}
						onInput$={async (_, el) => {
							const value = el.value.replace(/\D/g, '');
							cardData.value = { ...cardData.value, cvv: value };
							if (cvvTouched.value) {
								validateField('cvv', value);
							}
							const isComplete = await isFieldCompleteAndValid('cvv', value);
							if (isComplete) {
								el.blur();
							}
						}}
						onKeyDown$={(event) => handleKeyDown(event, 'cvv')}
						onBlur$={handleCvvBlur$}
					/>
					<ValidationIcon
						touched={cvvTouched.value}
						error={validationErrors.value.cvv || ''}
						valid={cvvTouched.value && !validationErrors.value.cvv && cvvValid.value}
					/>
				</div>
			</div>

			{/* Error displayed by checkout page inline error box instead */}

			<div class="w-full flex items-center justify-center gap-1.5 mb-1">
				<svg class="w-3.5 h-3.5" style="color:rgba(140,107,58,0.6)" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M12 11c1.1 0 2-.9 2-2V7a2 2 0 00-4 0v2c0 1.1.9 2 2 2zm6 0h-1V9a5 5 0 10-10 0v2H6a2 2 0 00-2 2v5a2 2 0 002 2h12a2 2 0 002-2v-5a2 2 0 00-2-2z" />
				</svg>
				<span class="text-[11px] font-medium" style="color:rgba(100,85,65,0.55)">Secure Credit Card Processing</span>
			</div>

			{!hideButton && (
				<button
					type="button"
					onClick$={submitPaymentForm}
					class="w-full flex justify-center py-2 px-4 border border-transparent rounded-md shadow-xs text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50 disabled:cursor-not-allowed"
					disabled={isProcessing.value || isDisabled}
				>
					{isProcessing.value ? 'Processing...' : 'Pay Now'}
				</button>
			)}
		</div>
	);
});
