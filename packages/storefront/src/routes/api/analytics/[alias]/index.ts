// routes.json operational.analyticsPath (e.g. Rotten's /api/analytics/performance/): the event sink under a brand's alias. Any other
// segment, and every path when no alias is configured, is a 404.
import type { RequestHandler } from '@qwik.dev/router';
import { BRAND_ROUTES } from '~/platform/brand-data';
import { sinkPost } from '~/platform/analytics-sink';

const ALIAS = BRAND_ROUTES?.operational?.analyticsPath ?? null;
const matches = (pathname: string) => ALIAS !== null && (pathname === ALIAS || `${pathname}/` === ALIAS);

export const onRequest: RequestHandler = async (ev) => {
	if (!matches(ev.url.pathname)) throw ev.json(404, { error: 'Not found' });
	if (ev.request.method !== 'POST') throw ev.json(405, { error: 'Method not allowed' });
	return sinkPost(ev);
};
