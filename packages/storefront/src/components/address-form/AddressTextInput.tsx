import { $, component$, type QRL } from '@qwik.dev/core';
import { FieldError, ValidationIcon } from '~/components/checkout/ValidationIcon';

type AddressTextInputProps = {
 fieldName: string;
 /** The form-control name for autofill; defaults to `fieldName`. */
 name?: string;
 id: string;
 value: string;
 placeholder: string;
 class: string;
 disabled?: boolean;
 required?: boolean;
 inputMode?: 'numeric' | 'text';
 autoComplete?: string;
 touched?: boolean;
 error?: string;
 valid?: boolean;
 onInput$: QRL<(fieldName: string, value: string | boolean) => void>;
 onBlur$?: QRL<(fieldName: string, value: string) => void>;
 afterBlur$?: QRL<(value: string) => void>;
};

export const AddressTextInput = component$<AddressTextInputProps>((props) => {
 const showError = !!(props.touched && props.error);
 const errorId = showError && props.id ? `${props.id}-error` : undefined;
 // `change` is the commit event: blur after typing, and the only event some autofill (older Safari) fires.
 // Treat it like a blur so an autofilled form validates and unlocks payment without the shopper touching it (#407).
 const commit$ = $(async (value: string) => {
  await props.onInput$(props.fieldName, value);
  if (props.onBlur$) await props.onBlur$(props.fieldName, value);
  if (props.afterBlur$) await props.afterBlur$(value);
 });
 return (
  <div>
   <div class="relative">
    <input
     type="text"
     inputMode={props.inputMode}
     name={props.name ?? props.fieldName}
     id={props.id}
     value={props.value}
     autoComplete={props.autoComplete}
     placeholder={props.placeholder}
     class={props.class}
     onInput$={(_, el) => props.onInput$(props.fieldName, el.value)}
     onChange$={(_, el) => commit$(el.value)}
     onBlur$={async (_, el) => {
      if (props.onBlur$) await props.onBlur$(props.fieldName, el.value);
      if (props.afterBlur$) await props.afterBlur$(el.value);
     }}
     required={props.required}
     disabled={props.disabled}
     aria-invalid={showError}
     aria-describedby={errorId}
    />
    {props.touched !== undefined && (
     <ValidationIcon touched={props.touched} error={props.error || ''} valid={!!props.valid} />
    )}
   </div>
   <FieldError id={errorId} message={showError ? props.error : undefined} />
  </div>
 );
});
