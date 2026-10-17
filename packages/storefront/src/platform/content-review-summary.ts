import { routeLoader$ } from '@qwik.dev/router';
import { DECLARED_CONTENT } from '~/platform/brand-data';
import { matchDeclaredPath } from '~/platform/content-routes';
import { hasContentViewFor } from '~/platform/content-view';
import type { ContentViewProps } from '~/platform/views';

/** Only declared, selected content views read this optional server-owned editorial source. */
export const useContentReviewSummary = routeLoader$(async ({ url }): Promise<ContentViewProps['reviewSummary']> => {
	if (!hasContentViewFor(url.pathname) || !matchDeclaredPath(DECLARED_CONTENT, url.pathname)) return null;
	const { readReviewSummary } = await import('~/platform/review-summary.server');
	return readReviewSummary();
});
