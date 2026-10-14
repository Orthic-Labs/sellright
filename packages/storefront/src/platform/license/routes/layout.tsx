// License flow shell: resolves the host variant once per request (src/brand/hosts.json) and sets its tokens on the root.
import { component$, Slot } from '@qwik.dev/core';
import { routeLoader$ } from '@qwik.dev/router';
import type { HostVariant } from '~/platform/host-variant';
import { variantForHost } from '../variant';

export const useHostVariant = routeLoader$<HostVariant>(({ request, url }) => variantForHost(request.headers.get('host') ?? url.host));

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
