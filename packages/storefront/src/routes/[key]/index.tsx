// Serves the IndexNow key-file at /{key}.txt — the key VALUE and whether IndexNow is even configured are entirely backend store
// config (GET /v1/shop/seo/indexnow-key.txt); nothing is hardcoded here. Named routes always take precedence over this dynamic
// segment, so it only receives unmatched top-level paths. Brand views: a single-segment content path the brand declares in
// routes.json (`/slow-fashion/`) renders `route.content` here; every other path keeps a plain 404 (no document).
import type { DocumentHead, DocumentHeadValue, RequestHandler } from '@qwik.dev/router';
import { indexNowKeyFile } from '~/services/sellright-seo';
import { DECLARED_CONTENT } from '~/platform/brand-data';
import { matchDeclaredPath } from '~/platform/content-routes';
import { contentHead } from '~/platform/head-resolve';
import { BrandContentMount } from '~/platform/controllers/content';
import { hasView } from '~/platform/gateway';
import { useStoreIdentityLoader } from '~/routes/layout';

const declared = (pathname: string) => (hasView('route.content') ? matchDeclaredPath(DECLARED_CONTENT, pathname) : null);

export const onGet: RequestHandler = async ({ params, send, headers, status, url }) => {
	if (declared(url.pathname)) return; // a declared content page: rendered below with its own head
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

export const head: DocumentHead = ({ resolveValue, url }) => {
	const decl = declared(url.pathname);
	return (decl ? contentHead(decl, resolveValue(useStoreIdentityLoader).identity) : {}) as DocumentHeadValue;
};

export default BrandContentMount;
