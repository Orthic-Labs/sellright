// License flow shell: resolves the host variant once per request (src/brand/hosts.json) and sets its tokens on the root.
import { component$, Slot } from '@qwik.dev/core';
import { routeLoader$, type RequestHandler } from '@qwik.dev/router';
import { NO_STORE_CACHE_CONTROL } from '~/config/route-cache-policy';
import type { HostVariant } from '~/platform/host-variant';
import { validatedRequestHost } from '~/utils/trusted-request.server';
import { variantForHost } from '../variant';

// Every document, loader and action response of the flow is private, no-store, whatever server entry serves it.
export const onRequest: RequestHandler = ({ headers }) => {
  headers.set('Cache-Control', NO_STORE_CACHE_CONTROL);
};

/** The variant of the request's validated host: X-Forwarded-Host only behind a declared trusted proxy, the same boundary the API's store resolution uses. */
export const useHostVariant = routeLoader$<HostVariant>(({ request, url }) =>
  variantForHost(validatedRequestHost({ host: request.headers.get('host') ?? url.host, 'x-forwarded-host': request.headers.get('x-forwarded-host') ?? undefined })),
);

export default component$(() => {
	const v = useHostVariant();
	return (
		<div style={v.value.style} data-app={v.value.key}>
			<header class="topbar">
				<div class="wrap">
					<a href={`https://${v.value.domain}/`} class="wordmark">
						{v.value.wordmark[0]}
						<span class="r">{v.value.wordmark[1]}</span>
					</a>
					<a class="back" href={`https://${v.value.domain}`}>
						← {v.value.domain}
					</a>
				</div>
			</header>
			<Slot />
		</div>
	);
});
