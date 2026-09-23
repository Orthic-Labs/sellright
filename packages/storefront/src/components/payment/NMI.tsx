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
	type CardValidationResult
} from '~/utils/card-validation';
import { AcceptedCards } from './AcceptedCards';
import {
	focusNextPaymentField,
	focusPreviousPaymentField,
	formatExpiryDateSmart,
	isCardFieldCompleteAndValid,
} from './nmi-field-helpers';

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
 triggerSignal: Signal<number>;
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
 
 const cardNumberTouched = useSignal<boolean>(false);
 const cvvTouched = useSignal<boolean>(false);
 const expiryDateTouched = useSignal<boolean>(false);
 
 const cardNumberValid = useSignal<boolean>(false);
 const cvvValid = useSignal<boolean>(false);
 const expiryDateValid = useSignal<boolean>(false);

	const updatePaymentValidationContext = $(() => {
		const allFieldsValid = cardNumberValid.value && cvvValid.value && expiryDateValid.value;
		const anyFieldTouched = cardNumberTouched.value || cvvTouched.value || expiryDateTouched.value;
		
		isValid.value = allFieldsValid;
		
		validationActions.updatePaymentValidation(
			allFieldsValid,
			{
				cardNumber: validationErrors.value.cardNumber,
				cvv: validationErrors.value.cvv,
				expiryDate: validationErrors.value.expiryDate
			},
			anyFieldTouched
		);
		
	});

	const validateField = $((field: keyof CardFormData, value: string) => {
		let validation: CardValidationResult;

		switch (field) {
			case 'cardNumber':
				validation = validateCardNumber(value);
				cardNumberValid.value = validation.isValid;
				break;
			case 'cvv':
				const cardNumberValidation = validateCardNumber(cardData.value.cardNumber);
				if (cardNumberValidation.isValid && cardNumberValidation.cardBrand) {
					const cvvLength = cardNumberValidation.cardBrand === 'american-express' ? 4 : 3;
					validation = validateCVV(value);
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

		validationErrors.value = {
			...validationErrors.value,
			[field]: validation.isValid ? undefined : validation.errorMessage
		};

		updatePaymentValidationContext();

		return validation.isValid;
	});

	const focusNextField = $((currentFieldId: string) => {
		focusNextPaymentField(currentFieldId);
	});

	const focusPreviousField = $((currentFieldId: string) => {
		focusPreviousPaymentField(currentFieldId);
	});

	const handleKeyDown = $((event: KeyboardEvent, fieldId: string) => {
		if (event.key === 'Backspace') {
			const target = event.target as HTMLInputElement;
			if (target.value === '' || target.selectionStart === 0) {
				focusPreviousField(fieldId);
			}
		}
		else if (event.key === 'Enter') {
			if (fieldId === 'cvv') {
				submitPaymentForm();
			} else {
				focusNextField(fieldId);
			}
		}
	});

	const isFieldCompleteAndValid = $((field: keyof CardFormData, value: string): boolean => {
		return isCardFieldCompleteAndValid(field, value, cardData.value.cardNumber);
	});

	const handleCardNumberBlur$ = $(() => {
		cardNumberTouched.value = true;
		const digitsOnly = cardData.value.cardNumber.replace(/\D/g, '');
		validateField('cardNumber', digitsOnly);
	});
	
	const handleCvvBlur$ = $(() => {
		cvvTouched.value = true;
		validateField('cvv', cardData.value.cvv);
	});
	
	const handleExpiryDateBlur$ = $(() => {
		expiryDateTouched.value = true;
		const digitsOnly = cardData.value.expiryDate.replace(/\D/g, '');
		validateField('expiryDate', digitsOnly);
	});

	const validateCard = $(async () => {
		cardNumberTouched.value = true;
		cvvTouched.value = true;
		expiryDateTouched.value = true;
		
		const cardNumberResult = await validateField('cardNumber', cardData.value.cardNumber);
		const cvvResult = await validateField('cvv', cardData.value.cvv);
		const expiryDateResult = await validateField('expiryDate', cardData.value.expiryDate);
		
		const allValid = cardNumberResult && cvvResult && expiryDateResult;
		isValid.value = allValid;
		
		
		return allValid;
	});

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
  if (onProcessingChange$) {
  await onProcessingChange$(true);
  }

			const paymentResult = await processNMIPayment({
				cardNumber: cardData.value.cardNumber.replace(/\D/g, ''),
				expiryDate: cardData.value.expiryDate.replace(/\D/g, ''),
				cvv: cardData.value.cvv.replace(/\D/g, ''),
			});


			if (paymentResult?.__typename === 'Order') {
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
			await onError$(error.value);
		} finally {
				isProcessing.value = false;
  if (onProcessingChange$) {
   await onProcessingChange$(false);
  }
		}
	});

 useVisibleTask$(({track}) => {
   track(() => triggerSignal.value);
   if (triggerSignal.value > 0) {
     if (!isProcessing.value) {
       submitPaymentForm();
     }
   }
 });

	return (
		<div class={`w-full ${isDisabled ? 'opacity-50 pointer-events-none' : ''} border-0`}>
			<AcceptedCards />

			<div class="grid grid-cols-4 gap-4 w-full mb-2">
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
							const formattedValue = formatExpiryDateSmart(el.value);
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
