import type { DocumentHead } from '@qwik.dev/router';
import type { JsonLdSchema } from '~/types/seo.types';
import { injectJsonLdSchemas, debugJsonLdSchemas } from './schema-injection';

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
}: SEOConfig): DocumentHead => {
  const SITE_DOMAIN = 'https://www.damneddesigns.com';
  const DEFAULT_IMAGE = `${SITE_DOMAIN}/social-image.jpg`;
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
    title: title.endsWith(' | Damned Designs') ? title : `${title} | Damned Designs`,
    meta: [
      { name: 'description', content: description },
      { property: 'og:type', content: ogType },
      { property: 'og:title', content: title },
      { property: 'og:description', content: description },
      { property: 'og:site_name', content: 'Damned Designs' },
      ...(ogUrl ? [{ property: 'og:url', content: ogUrl }] : []),
      ...(optimizedImage ? [{ property: 'og:image', content: optimizedImage }] : []),
      ...(optimizedImage ? [{ property: 'og:image:width', content: '1200' }] : []),
      ...(optimizedImage ? [{ property: 'og:image:height', content: '630' }] : []),
      { name: 'twitter:card', content: 'summary_large_image' },
      { name: 'twitter:title', content: title },
      { name: 'twitter:description', content: description },
      ...(optimizedImage ? [{ name: 'twitter:image', content: optimizedImage }] : []),
      ...(articleMeta?.publishedTime ? [{ property: 'article:published_time', content: articleMeta.publishedTime }] : []),
      ...(articleMeta?.modifiedTime ? [{ property: 'article:modified_time', content: articleMeta.modifiedTime }] : []),
      ...(articleMeta?.section ? [{ property: 'article:section', content: articleMeta.section }] : []),
      ...(articleMeta?.author ? [{ property: 'article:author', content: articleMeta.author }] : []),
      ...((articleMeta?.tags || []).map((t) => ({ property: 'article:tag', content: t }))),
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
  });
};
