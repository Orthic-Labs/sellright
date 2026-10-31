// The brand home view's spotlight (routes.json home.spotlight): one product the home page sells in place through the shared
// configurator. Metadata only, like the shop's configurator products: the model comes from the catalog generation or, when that is
// missing, from the live API; stock is never read here (the configurator makes the view's one live read in the browser). With no
// route.home view or no declared spotlight this loader returns null without any I/O.
import { routeLoader$, server$ } from '@qwik.dev/router';
import { noStore, shellRender } from '~/platform/shell-render';
import { hasView } from '~/platform/gateway';
import { HOME_SPOTLIGHT } from '~/platform/brand-data';
import { redactModel, type ModelProduct } from '~/platform/controllers/product-model';
import { modelsFromLive, modelsFromManifest } from '~/platform/product-detail';

export interface HomeSpotlightDetail {
	detail: ModelProduct[];
	source: 'manifest' | 'network';
}

export async function buildHomeSpotlight(): Promise<HomeSpotlightDetail | null> {
	if (!hasView('route.home') || !HOME_SPOTLIGHT) return null;
	const set = [HOME_SPOTLIGHT];
	const pinned = await modelsFromManifest(set);
	const models = pinned ?? (await modelsFromLive(set));
	const model = models[0];
	if (!model || model.variants.length === 0) return null;
	return { detail: [model], source: pinned ? 'manifest' : 'network' };
}

/** ADR-0001: the shell carries the spotlight's metadata, no price (and no stock hint). */
export const useHomeSpotlight = routeLoader$(async (): Promise<HomeSpotlightDetail | null> => {
	const d = await buildHomeSpotlight();
	return d && shellRender() ? { ...d, detail: d.detail.map(redactModel) } : d;
});

/** The spotlight's live values in the browser (ADR-0001): the same build, per request, no-store. */
export const readHomeSpotlight = server$(async function (): Promise<HomeSpotlightDetail | null> {
	noStore(this);
	return buildHomeSpotlight();
});
