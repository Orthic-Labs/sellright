// The Turnstile container a brand form renders. The L1 form controller loads the script and fills the token; the brand only places the <div>.
import { component$ } from '@qwik.dev/core';

export type TurnstileTarget = 'newsletter' | 'contact';

/** Element ids the controllers mount into (utils/turnstile-widget.ts mounts by id). */
export const TURNSTILE_CONTAINER_ID: Record<TurnstileTarget, string> = {
	newsletter: 'nl-turnstile',
	contact: 'turnstile-container',
};

export const TurnstileMount = component$<{ for: TurnstileTarget; class?: string }>((props) => (
	<div id={TURNSTILE_CONTAINER_ID[props.for]} class={props.class ?? 'min-h-[65px]'} />
));
