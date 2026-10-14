// The only importer of `virtual:sellright-brand-data` (plan §1). A missing head.json / routes.json means today's defaults:
// an empty spec and no declared content, no per-page head, the default blog page size.
import { brandHead, brandRoutes } from 'virtual:sellright-brand-data';
import type { BrandHeadSpec, StaticSchema } from '~/platform/head-resolve';
import type { DeclaredContent } from '~/platform/content-routes';

export interface BrandRoutes {
	version: 1;
	content?: DeclaredContent[];
	pages?: Record<string, { head?: { title?: string; description?: string; noindex?: boolean } }>;
	blog?: { pageSize?: number };
	/** Brand views PR2 §9: where product pages live. Default `/products/:slug/`. */
	productPath?: '/products/:slug/' | '/shop/:slug/';
	shop?: {
		/** The configurator's products (1-4), metadata only; each one's head copy applies only while the product is found. */
		detailProducts?: DetailProduct[];
		/** Query params that pick the shop's initial product (`?style=long`): the first param present wins. */
		productQuery?: { params: string[]; values: Record<string, string> };
	};
	operational?: { cartSeedPath?: string; analyticsPath?: string };
	/** Plain-text copy for base components a brand does not replace with a view (no markup: rendered as text). */
	copy?: { cart?: { emptyTitle?: string; emptyBody?: string } };
	/** The configurator's cart drawer opens this long after a successful add (0, the default, opens it at once). */
	cart?: { openAfterAddMs?: number };
}

export interface DetailProduct {
	key: string;
	slug: string;
	head?: { title: string; description: string };
	breadcrumbName?: string;
	schemas?: StaticSchema[];
	/** Plain product facts the platform adds to its own commerce JSON-LD (platform/product-jsonld.ts). */
	facts?: { material?: string };
}

export const BRAND_HEAD: BrandHeadSpec = (brandHead as BrandHeadSpec | null) ?? {};
export const BRAND_ROUTES: BrandRoutes | null = (brandRoutes as BrandRoutes | null) ?? null;
export const DECLARED_CONTENT: readonly DeclaredContent[] = BRAND_ROUTES?.content ?? [];
export const DETAIL_PRODUCTS: readonly DetailProduct[] = BRAND_ROUTES?.shop?.detailProducts ?? [];
export const BRAND_COPY: NonNullable<BrandRoutes['copy']> = BRAND_ROUTES?.copy ?? {};
export const CART_OPEN_AFTER_ADD_MS: number = BRAND_ROUTES?.cart?.openAfterAddMs ?? 0;
