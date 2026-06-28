import { component$, type QRL } from '@qwik.dev/core';
import type { Country } from '~/types';

type AddressCountrySelectProps = {
 id: string;
 value: string;
 countries: Country[];
 className: string;
 disabled?: boolean;
 onChange$: QRL<(value: string) => void>;
};

export const AddressCountrySelect = component$<AddressCountrySelectProps>((props) => (
 <div class="relative">
  <select
   id={props.id}
   name={props.id}
   autocomplete="country"
   class={props.className}
   value={props.value}
   onChange$={(_, el) => props.onChange$(el.value)}
   aria-label="Country"
   disabled={props.disabled}
   required
  >
   <option value="" disabled>{`Select a country`}</option>
   {props.countries.map((item) => (
    <option
     key={item.id}
     value={item.code}
     selected={item.code === props.value}
    >
     {item.name}
    </option>
   ))}
  </select>
  <div class="absolute inset-y-0 right-0 flex items-center pr-2 pointer-events-none">
   <svg class="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path>
   </svg>
  </div>
 </div>
));
