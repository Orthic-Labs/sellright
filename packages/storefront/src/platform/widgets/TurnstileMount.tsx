// The Turnstile container a brand form renders. The L1 form controller loads the script and fills the token; the brand only places the <div>.
import { component$ } from '@qwik.dev/core';
import { TURNSTILE_SITE_KEY } from '~/utils/turnstile-widget';

export type TurnstileTarget = 'newsletter' | 'contact';

/** Element ids the controllers mount into (utils/turnstile-widget.ts mounts by id). */
export const TURNSTILE_CONTAINER_ID: Record<TurnstileTarget, string> = {
	newsletter: 'nl-turnstile',
	contact: 'turnstile-container',
};

/** The widget's own height (Turnstile "normal": 65 px) plus its inline wrapper's line box, measured 73 px on Chrome mobile. Reserved
 *  while the widget loads (it mounts seconds after first paint), so it does not push the submit button down (contact CLS 0.137). */
export const TURNSTILE_RESERVED_HEIGHT_PX = 73;

export const TurnstileMount = component$<{ for: TurnstileTarget; class?: string }>((props) => (
	<div id={TURNSTILE_CONTAINER_ID[props.for]} class={props.class} style={TURNSTILE_SITE_KEY ? `min-height:${TURNSTILE_RESERVED_HEIGHT_PX}px` : undefined} />
));
