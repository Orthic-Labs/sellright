import { component$ } from '@qwik.dev/core';
import XCircleIcon from '~/components/icons/XCircleIcon';

export const SignInError = component$<{ message: string }>(({ message }) => {
 return (
  <div class="rounded-md bg-red-50 p-3">
   <div class="flex items-start gap-2">
    <div class="shrink-0 mt-0.5"><XCircleIcon /></div>
    <p class="text-sm text-red-700">{message}</p>
   </div>
  </div>
 );
});
