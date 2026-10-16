// Serves the IndexNow key-file at /{key}.txt — the key VALUE and whether IndexNow is even configured are entirely backend store
// config (GET /v1/shop/seo/indexnow-key.txt); nothing is hardcoded here. Named routes always take precedence over this dynamic
// segment, so it only receives unmatched top-level paths.
//
// Brand views: a single-segment content path the brand declares in routes.json (`/slow-fashion/`) renders `route.content` here. A
// document request for any other path answers as before (onGet/onHead: key file or a plain 404); a client-side navigation to one
// (where onGet does not run) renders today's 404 markup, never the content view.
import { component$ } from '@qwik.dev/core';
import { useLocation, type DocumentHead, type DocumentHeadValue, type RequestHandler } from '@qwik.dev/router';
import { indexNowKeyFile } from '~/services/sellright-seo';
import { DECLARED_CONTENT } from '~/platform/brand-data';
import { matchDeclaredPath } from '~/platform/content-routes';
import { contentHead } from '~/platform/head-resolve';
import { BrandContentMount } from '~/platform/controllers/content';
import { hasContentViewFor } from '~/platform/content-view';
import { useStoreIdentityLoader } from '~/routes/layout';
import { head as catchAllHead, notFoundMarkup } from '../[...catchall]/index';

/** True when this build declares at least one single-segment content path and has a content view to render it. */
const HAS_SINGLE_SEGMENT_CONTENT = DECLARED_CONTENT.some((d) => d.path.split('/').filter(Boolean).length === 1 && hasContentViewFor(d.path));

const declared = (pathname: string) => (HAS_SINGLE_SEGMENT_CONTENT && hasContentViewFor(pathname) ? matchDeclaredPath(DECLARED_CONTENT, pathname) : null);

/** GET and HEAD: a declared page renders; a key file is served; anything else is a plain 404. */
const classify: RequestHandler = async ({ params, send, headers, status, url }) => {
	if (declared(url.pathname)) return;
	const result = await indexNowKeyFile(params.key);
	if (!result) {
		status(404);
		send(404, '');
		return;
	}
	headers.set('Content-Type', 'text/plain; charset=utf-8');
	headers.set('Cache-Control', 'public, max-age=3600');
	send(200, result.body);
};
export const onGet = classify;
export const onHead = classify;

export const head: DocumentHead = (props) => {
	const decl = declared(props.url.pathname);
	if (decl) return contentHead(decl, props.resolveValue(useStoreIdentityLoader).identity) as DocumentHeadValue;
	return (typeof catchAllHead === 'function' ? catchAllHead(props) : catchAllHead) as DocumentHeadValue;
};

/**
 * A declared path renders the content view; anything else reached by client navigation (where onGet does not run) renders today's
 * 404 markup, as the catch-all did for single segments when this route was an endpoint. The route exports no loader, so its onGet
 * never sees a loader request.
 */
export default component$(() => {
	const location = useLocation();
	return declared(location.url.pathname) ? <BrandContentMount /> : notFoundMarkup(location.url.pathname);
});
