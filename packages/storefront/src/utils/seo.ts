import type { DocumentHead } from '@qwik.dev/router';
import type { JsonLdSchema } from '~/types/seo.types';
import { injectJsonLdSchemas, debugJsonLdSchemas } from './schema-injection';
import { identityFromStaticTheme } from '~/theme/theme.config';
import type { SrStoreIdentity } from './sellright';

interface SEOConfig {
  title: string;
  description: string;
  image?: string;
  noindex?: boolean;
  canonical?: string;
  ogUrl?: string;
  ogType?: string;
  articleMeta?: {
    publishedTime?: string | null;
    modifiedTime?: string | null;
    section?: string;
    tags?: string[];
    author?: string;
  };
  links?: Array<{
    rel: string;
    href?: string;
    as?: string;
    type?: string;
    crossorigin?: string;
    media?: string;
    imagesrcset?: string;
    imagesizes?: string;
  }>;
  schemas?: JsonLdSchema[];
  /**
   * WS-C: the runtime store identity resolved per-request by the root
   * layout's useStoreIdentityLoader. Route `head` functions read it via
   * `resolveValue(useStoreIdentityLoader)` and pass it through here so the
   * title suffix / og:site_name / default image reflect the actual resolved
   * store instead of the build-time static theme. Omitting it falls back to
   * that static theme (offline/dev, or a caller not yet threaded through).
   */
  identity?: SrStoreIdentity;
  /** Open Graph product tags (product:price:amount, :currency, :brand, :condition, :availability), product pages only. */
  productMeta?: { price?: string; currency?: string; brand?: string; condition?: string; availability?: string };
}

export const createSEOHead = ({
  title,
  description,
  image,
  noindex = false,
  canonical,
  ogUrl,
  ogType = 'website',
  articleMeta,
  links = [],
  schemas = [],
  identity = identityFromStaticTheme(),
  productMeta,
}: SEOConfig): DocumentHead => {
  const SITE_DOMAIN = identity.siteOrigin;
  const DEFAULT_IMAGE = `${SITE_DOMAIN}${identity.ogImageUrl}`;
  const absoluteImage = image
    ? (image.startsWith('http') ? image : `${SITE_DOMAIN}${image}`)
    : undefined;
  const optimizedImage = absoluteImage
    ? (absoluteImage.includes('/assets/') ? absoluteImage + '?preset=xl' : absoluteImage)
    : DEFAULT_IMAGE;

  const allLinks = [
    ...(canonical ? [{ rel: 'canonical', href: canonical }] : []),
    ...links,
  ];

  const jsonLdMetas = injectJsonLdSchemas(schemas);

  if (import.meta.env.DEV && schemas.length > 0) {
    debugJsonLdSchemas(schemas, `SEO Head: ${title}`);
  }

  const head: DocumentHead = {
    title:
      title === identity.storeName || title.endsWith(` | ${identity.storeName}`)
        ? title
        : `${title} | ${identity.storeName}`,
    meta: [
      { name: 'description', content: description },
      { property: 'og:type', content: ogType },
      { property: 'og:title', content: title },
      { property: 'og:description', content: description },
      { property: 'og:site_name', content: identity.storeName },
      ...(ogUrl ? [{ property: 'og:url', content: ogUrl }] : []),
      ...(optimizedImage ? [{ property: 'og:image', content: optimizedImage }] : []),
      // The alt text is the page title (as the Rotten store publishes it). No og:image:width/height: they were a fixed
      // 1200x630 for every image, product photos included; the tags are optional and crawlers read the real size.
      ...(optimizedImage ? [{ property: 'og:image:alt', content: title }] : []),
      { name: 'twitter:card', content: 'summary_large_image' },
      { name: 'twitter:title', content: title },
      { name: 'twitter:description', content: description },
      ...(optimizedImage ? [{ name: 'twitter:image', content: optimizedImage }] : []),
      ...(articleMeta?.publishedTime ? [{ property: 'article:published_time', content: articleMeta.publishedTime }] : []),
      ...(articleMeta?.modifiedTime ? [{ property: 'article:modified_time', content: articleMeta.modifiedTime }] : []),
      ...(articleMeta?.section ? [{ property: 'article:section', content: articleMeta.section }] : []),
      ...(articleMeta?.author ? [{ property: 'article:author', content: articleMeta.author }] : []),
      ...((articleMeta?.tags || []).map((t) => ({ property: 'article:tag', content: t }))),
      ...(productMeta?.price ? [{ property: 'product:price:amount', content: productMeta.price }] : []),
      ...(productMeta?.price && productMeta.currency ? [{ property: 'product:price:currency', content: productMeta.currency }] : []),
      ...(productMeta?.availability ? [{ property: 'product:availability', content: productMeta.availability }] : []),
      ...(productMeta?.condition ? [{ property: 'product:condition', content: productMeta.condition }] : []),
      ...(productMeta?.brand ? [{ property: 'product:brand', content: productMeta.brand }] : []),
      // Discourage gen-AI training on our content/images (advisory). Does NOT block
      // AI-search citation — that is governed by crawler access in robots.txt, which stays open.
      { name: 'robots', content: noindex ? 'noindex, nofollow, noai, noimageai' : 'noai, noimageai' },
      ...jsonLdMetas,
    ],
    ...(allLinks.length > 0 ? { links: allLinks } : {}),
  };

  return head;
};

/**
 * Create SEO head with product schema
 * Convenience function for product pages
 */
export const createProductSEOHead = ({
  title,
  description,
  image,
  canonical,
  links = [],
  productSchema,
  breadcrumbSchema,
  identity,
}: SEOConfig & {
  productSchema?: JsonLdSchema;
  breadcrumbSchema?: JsonLdSchema;
}): DocumentHead => {
  const schemas: JsonLdSchema[] = [];

  if (productSchema) schemas.push(productSchema);
  if (breadcrumbSchema) schemas.push(breadcrumbSchema);

  return createSEOHead({
    title,
    description,
    image,
    canonical,
    links,
    schemas,
    identity,
  });
};

/**
 * Create SEO head with organization and website schemas
 * Convenience function for homepage and static pages
 */
export const createOrganizationSEOHead = ({
  title,
  description,
  image,
  canonical,
  links = [],
  organizationSchema,
  websiteSchema,
  identity,
}: SEOConfig & {
  organizationSchema?: JsonLdSchema;
  websiteSchema?: JsonLdSchema;
}): DocumentHead => {
  const schemas: JsonLdSchema[] = [];

  if (organizationSchema) schemas.push(organizationSchema);
  if (websiteSchema) schemas.push(websiteSchema);

  return createSEOHead({
    title,
    description,
    image,
    canonical,
    links,
    schemas,
    identity,
  });
};
