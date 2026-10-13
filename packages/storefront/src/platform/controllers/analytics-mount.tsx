// Mounted by the layout only when head.json declares analytics: starts the conversion subscriber once the document is ready.
import { component$, useVisibleTask$ } from '@qwik.dev/core';
import { startConversion } from './conversion';

export const AnalyticsMount = component$(() => {
	useVisibleTask$(() => startConversion(), { strategy: 'document-ready' });
	return null;
});
