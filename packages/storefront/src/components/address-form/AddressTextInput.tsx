import { component$, type QRL } from '@qwik.dev/core';
import { ValidationIcon } from '~/components/checkout/ValidationIcon';

type AddressTextInputProps = {
 fieldName: string;
 id: string;
 value: string;
 placeholder: string;
 className: string;
 disabled?: boolean;
 required?: boolean;
 inputMode?: 'numeric';
 autoComplete?: string;
 touched?: boolean;
 error?: string;
 valid?: boolean;
 onInput$: QRL<(fieldName: string, value: string | boolean) => void>;
 onBlur$?: QRL<(fieldName: string, value: string) => void>;
 afterBlur$?: QRL<(value: string) => void>;
};

export const AddressTextInput = component$<AddressTextInputProps>((props) => {
 return (
  <div class="relative">
   <input
    type="text"
    inputMode={props.inputMode}
    name={props.fieldName}
    id={props.id}
    value={props.value}
    autoComplete={props.autoComplete}
    placeholder={props.placeholder}
    class={props.className}
    onInput$={(_, el) => props.onInput$(props.fieldName, el.value)}
    onBlur$={async (_, el) => {
     if (props.onBlur$) await props.onBlur$(props.fieldName, el.value);
     if (props.afterBlur$) await props.afterBlur$(el.value);
    }}
    required={props.required}
    disabled={props.disabled}
   />
   {props.touched !== undefined && (
    <ValidationIcon
     touched={props.touched}
     error={props.error || ''}
     valid={!!props.valid}
    />
   )}
  </div>
 );
});
