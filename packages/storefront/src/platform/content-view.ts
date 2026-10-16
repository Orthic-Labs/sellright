// One selection rule for built-in pages, declared content dispatch, status & head.
import { BRAND_ROUTES } from '~/platform/brand-data';
import { selectsContentView } from '~/platform/content-routes';
import { hasView } from '~/platform/gateway';

export const hasContentViewFor = (pathname: string): boolean => hasView('route.content') && selectsContentView(BRAND_ROUTES?.contentViewPaths, pathname);
