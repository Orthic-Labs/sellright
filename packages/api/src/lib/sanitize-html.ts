import sanitizeHtml from 'sanitize-html';

// Allowlist ported 1:1 from the previous the previous platform blog plugin
// (damned/admin/src/plugins/blog/services/blog-post.service.ts SANITIZE_OPTIONS):
// rich infographic posts (div/section/table/figure/inline svg + class/style/id/
// data-*) must survive an edit round trip unchanged.
const ALLOWED_TAGS = [
  // Text structure
  'h2', 'h3', 'h4', 'p', 'br', 'hr',
  // Inline formatting
  'strong', 'em', 'b', 'i', 'u', 's', 'mark', 'code', 'sub', 'sup',
  // Links & media
  'a', 'img',
  // Lists
  'ul', 'ol', 'li',
  // Quotes & code
  'blockquote', 'pre',
  // Layout (for infographics)
  'div', 'span', 'section', 'article', 'aside', 'header', 'footer',
  // Tables
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  // Figures
  'figure', 'figcaption',
  // SVG (for inline infographics)
  'svg', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon',
  'g', 'text', 'tspan', 'defs', 'use', 'symbol', 'title', 'desc',
  'linearGradient', 'radialGradient', 'stop', 'clipPath', 'mask',
];

const ALLOWED_ATTRIBUTES: sanitizeHtml.IOptions['allowedAttributes'] = {
  // Global attributes allowed on any tag
  '*': ['style', 'class', 'id', 'data-*'],
  a: ['href', 'title', 'target', 'rel'],
  img: ['src', 'alt', 'width', 'height', 'loading'],
  td: ['colspan', 'rowspan'],
  th: ['colspan', 'rowspan', 'scope'],
  col: ['span'],
  colgroup: ['span'],
  // SVG attributes
  svg: ['xmlns', 'viewBox', 'width', 'height', 'fill', 'stroke', 'stroke-width', 'aria-label', 'role'],
  path: ['d', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'opacity'],
  circle: ['cx', 'cy', 'r', 'fill', 'stroke', 'stroke-width', 'opacity'],
  rect: ['x', 'y', 'width', 'height', 'rx', 'ry', 'fill', 'stroke', 'stroke-width', 'opacity'],
  line: ['x1', 'y1', 'x2', 'y2', 'stroke', 'stroke-width'],
  polyline: ['points', 'fill', 'stroke', 'stroke-width'],
  polygon: ['points', 'fill', 'stroke', 'stroke-width'],
  g: ['transform', 'fill', 'stroke', 'opacity'],
  text: ['x', 'y', 'fill', 'font-size', 'font-family', 'text-anchor'],
  tspan: ['x', 'y', 'dx', 'dy'],
  linearGradient: ['id', 'x1', 'y1', 'x2', 'y2', 'gradientUnits'],
  radialGradient: ['id', 'cx', 'cy', 'r', 'fx', 'fy', 'gradientUnits'],
  stop: ['offset', 'stop-color', 'stop-opacity'],
  use: ['href', 'x', 'y', 'width', 'height'],
  clipPath: ['id'],
  mask: ['id'],
};

// the previous platform allowed https/http/data. mailto is kept as well: its link transform
// deliberately leaves mailto: hrefs alone, but without the scheme here the
// href would be stripped, silently breaking mail links.
const ALLOWED_SCHEMES = ['https', 'http', 'data', 'mailto'];

/**
 * Sanitizes admin-authored blog HTML before it is stored and served
 * verbatim to unauthenticated storefront visitors. Strips scripts, iframes,
 * event handlers and javascript: URLs; keeps the rich-text + infographic
 * allowlist the stores already published with.
 */
export function sanitizeBlogHtml(input: string): string {
  return sanitizeHtml(input, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: ALLOWED_ATTRIBUTES,
    allowedSchemes: ALLOWED_SCHEMES,
    allowProtocolRelative: false,
    // The parser lowercases attribute names by default, which silently drops the
    // camelCase SVG `viewBox` (the allowlist entry never matches) and un-scales
    // every inline chart. Tag names stay lowercased (camelCase tags still match).
    parser: { lowerCaseAttributeNames: false },
    transformTags: {
      a: (tagName: string, attribs: sanitizeHtml.Attributes) => {
        const out: sanitizeHtml.Attributes = { ...attribs, target: '_blank', rel: 'noopener noreferrer' };
        let href = attribs.href;
        // Script-capable schemes are dropped outright rather than being rewritten to a bogus https:// link.
        if (href && /^\s*(javascript|vbscript|data|file):/i.test(href)) href = undefined;
        // Ensure an absolute URL: prefix bare domains with https://
        if (href && !/^https?:\/\//i.test(href) && !href.startsWith('/') && !href.startsWith('#') && !href.startsWith('mailto:')) {
          href = 'https://' + href;
        }
        if (href !== undefined) out.href = href;
        else delete out.href;
        return { tagName, attribs: out };
      },
    },
  });
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Visible text of sanitised HTML (tags -> spaces, common entities decoded, whitespace collapsed). */
function plainText(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, (_m, e: string) => (e === '#39' ? "'" : ENTITIES[e]!))
    .replace(/\s+/g, ' ')
    .trim();
}

/** Auto excerpt when none is given: first 160 chars of text, cut at a word boundary with an ellipsis (the previous platform autoExcerpt). */
export function autoExcerpt(html: string): string {
  const text = plainText(html);
  if (text.length <= 160) return text;
  return text.substring(0, 157).replace(/\s+\S*$/, '') + '...';
}

/** Reading time in whole minutes at 225 wpm, minimum 1 (the previous platform computeReadingTime). */
export function computeReadingTime(html: string): number {
  const words = html.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 225));
}
