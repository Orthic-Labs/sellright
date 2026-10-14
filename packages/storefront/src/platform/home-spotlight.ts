// The brand home view's spotlight (routes.json home.spotlight): one product the home page sells in place through the shared
// configurator. Metadata only, like the shop's configurator products: the model comes from the catalog generation or, when that is
// missing, from the live API; stock is never read here (the configurator makes the view's one live read in the browser). With no
// route.home view or no declared spotlight this loader returns null without any I/O.
import { routeLoader$ } from '@qwik.dev/router';
import { hasView } from '~/platform/gateway';
import { HOME_SPOTLIGHT } from '~/platform/brand-data';
import type { ModelProduct } from '~/platform/controllers/product-model';
import { modelsFromLive, modelsFromManifest } from '~/platform/product-detail';

export interface HomeSpotlightDetail {
	detail: ModelProduct[];
	source: 'manifest' | 'network';
}

export const useHomeSpotlight = routeLoader$(async (): Promise<HomeSpotlightDetail | null> => {
	if (!hasView('route.home') || !HOME_SPOTLIGHT) return null;
	const set = [HOME_SPOTLIGHT];
	const pinned = await modelsFromManifest(set);
	const models = pinned ?? (await modelsFromLive(set));
	const model = models[0];
	if (!model || model.variants.length === 0) return null;
	return { detail: [model], source: pinned ? 'manifest' : 'network' };
});
