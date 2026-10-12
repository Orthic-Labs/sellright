// The only importer of `virtual:sellright-brand-data` (plan §1). A missing head.json / routes.json means today's defaults:
// an empty spec and no declared content, no per-page head, the default blog page size.
import { brandHead, brandRoutes } from 'virtual:sellright-brand-data';
import type { BrandHeadSpec } from '~/platform/head-resolve';
import type { DeclaredContent } from '~/platform/content-routes';

export interface BrandRoutes {
	version: 1;
	content?: DeclaredContent[];
	pages?: Record<string, { head?: { title?: string; description?: string; noindex?: boolean } }>;
	blog?: { pageSize?: number };
}

export const BRAND_HEAD: BrandHeadSpec = (brandHead as BrandHeadSpec | null) ?? {};
export const BRAND_ROUTES: BrandRoutes | null = (brandRoutes as BrandRoutes | null) ?? null;
export const DECLARED_CONTENT: readonly DeclaredContent[] = BRAND_ROUTES?.content ?? [];
