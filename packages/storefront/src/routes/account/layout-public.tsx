import { Slot, component$ } from '@qwik.dev/core';

/**
 * A pass-through layout for the few /account/* pages that must work BEFORE a session exists (today: the emailed
 * sign-in link). Pages opt in with the `index@public.tsx` file name, which skips `layout.tsx` — whose server guard
 * redirects signed-out visitors to /sign-in and whose chrome assumes a signed-in customer.
 */
export default component$(() => <Slot />);
