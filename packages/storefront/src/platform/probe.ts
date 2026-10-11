// A12 probe. NOT product behaviour: a throwaway platform module that defines a routeLoader$ and a routeAction$ (zod$)
// so e2e/platform-reexport.spec.ts can prove that route files may RE-EXPORT them (src/routes/__platform-reexport-probe/).
// If the re-export does not work, L3 pages must keep their own loader/action definitions (plan A12, owner decision).
// Gated at request time: every response is a 404 unless the server runs with E2E_PLATFORM_PROBE=1, so a production
// build that ships these files exposes nothing. No stock, cart, checkout or payment code is touched here.
import { routeAction$, routeLoader$, z, zod$ } from '@qwik.dev/router';

export const PROBE_LOADER_VALUE = 'probe-loader-value';
export const PROBE_FORBIDDEN_WORD = 'explode';

export const useProbeLoader = routeLoader$(({ env, status }) => {
	if (env.get('E2E_PLATFORM_PROBE') !== '1') {
		status(404);
		return { enabled: false as const, value: '' };
	}
	return { enabled: true as const, value: PROBE_LOADER_VALUE };
});

export const useProbeAction = routeAction$(
	(data, { env, status }) => {
		if (env.get('E2E_PLATFORM_PROBE') !== '1') {
			status(404);
			return { success: false as const, echoed: '' };
		}
		// A thrown server error must surface as a failed action (HTTP 500 on the action call), not a crashed page.
		if (data.word === PROBE_FORBIDDEN_WORD) throw new Error('probe action: forced server error');
		return { success: true as const, echoed: data.word };
	},
	zod$({ word: z.string().min(3, 'word must have at least 3 characters') })
);
