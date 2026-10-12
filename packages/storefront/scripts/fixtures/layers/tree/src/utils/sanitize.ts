// Fixture reviewed pure util (listed in layers.json imports.transitiveL1Allow): reaching it is allowed.
import DOMPurify from 'isomorphic-dompurify';
export const stripHtml = (s: string) => DOMPurify.sanitize(s, { ALLOWED_TAGS: [], ALLOWED_ATTR: [], KEEP_CONTENT: true }) as unknown as string;
