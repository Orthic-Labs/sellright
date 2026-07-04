import sanitizeHtml from 'sanitize-html';

const ALLOWED_TAGS = [
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'p', 'a', 'ul', 'ol', 'li',
  'strong', 'em', 'blockquote', 'code', 'pre',
  'img', 'br', 'hr', 'span',
];

const ALLOWED_ATTRIBUTES = {
  a: ['href', 'title', 'target', 'rel'],
  img: ['src', 'alt', 'title'],
};

const ALLOWED_SCHEMES = ['http', 'https', 'mailto'];

/**
 * Sanitizes admin-authored blog HTML before it is stored and served
 * verbatim to unauthenticated storefront visitors. Strips scripts,
 * styles, iframes, event handlers, and javascript: URLs; keeps a
 * conservative rich-text allowlist.
 */
export function sanitizeBlogHtml(input: string): string {
  return sanitizeHtml(input, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: ALLOWED_ATTRIBUTES,
    allowedSchemes: ALLOWED_SCHEMES,
    allowedSchemesByTag: { img: ['http', 'https'] },
    allowProtocolRelative: false,
    transformTags: {
      a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer' }, true),
    },
  });
}
