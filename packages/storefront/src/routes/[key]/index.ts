// Serves the IndexNow key-file at /{key}.txt — the key VALUE and whether
// IndexNow is even configured are entirely backend store config
// (GET /v1/shop/seo/indexnow-key.txt); nothing is hardcoded here. Falls
// through to a plain 404 for any other single-segment path (named routes
// always take precedence over this dynamic segment, so this only ever
// receives genuinely unmatched top-level paths).
import type { RequestHandler } from '@qwik.dev/router';
import { indexNowKeyFile } from '~/services/sellright-seo';

export const onGet: RequestHandler = async ({ params, send, headers, status }) => {
	const result = await indexNowKeyFile(params.key);
	if (!result) {
		status(404);
		return;
	}
	headers.set('Content-Type', 'text/plain; charset=utf-8');
	headers.set('Cache-Control', 'public, max-age=3600');
	send(200, result.body);
};
