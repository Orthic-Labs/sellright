// Fixture platform module: platform code may define loaders and actions.
import { routeAction$, routeLoader$ } from '@qwik.dev/router';

export const useProbeLoader = routeLoader$(() => ({ value: 'v' }));
export const useProbeAction = routeAction$(() => ({ ok: true }));
