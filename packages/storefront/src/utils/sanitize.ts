// HTML sanitising (#427). DOMPurify runs on the server only (sanitize.server.ts). Every HTML string the browser renders comes from server
// data that was sanitised there: route loaders and server reads (the PDP loader's product description, the blog post loader's body,
// product models built for loaders). So in the browser the HTML functions return their input, and the text helpers parse it in an
// inert DOMParser document (no script runs; the output is text). `isServer` is a build-time constant, so the client build has no
// DOMPurify (10.6 KB br on every page before).
import { isServer } from '@qwik.dev/core/build';
import * as server from './sanitize.server';

export { sanitizeInlineScript } from './sanitize-lite';

type Options = Parameters<typeof server.sanitizeHtml>[1];

/** Text of an HTML string, escaped as DOMPurify serialises text (&, <, >, nbsp), so callers decode the same five entities. */
function browserText(dirty: string): string {
	const text = new DOMParser().parseFromString(dirty, 'text/html').body.textContent ?? '';
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\u00a0/g, '&nbsp;');
}
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export const sanitizeHtml = (dirty: string, options?: Options): string => (isServer ? server.sanitizeHtml(dirty, options) : str(dirty));
export const sanitizeBlogHtml = (dirty: string): string => (isServer ? server.sanitizeBlogHtml(dirty) : str(dirty));
export const sanitizeProductDescription = (dirty: string): string => (isServer ? server.sanitizeProductDescription(dirty) : str(dirty));
export const stripHtml = (dirty: string): string => (isServer ? server.stripHtml(dirty) : str(dirty) && browserText(dirty));
export const sanitizeStyle = (styleString: string): string =>
	isServer ? server.sanitizeStyle(styleString) : str(styleString) && browserText(styleString).replace(/\{\{[\s\S]*?\}\}|\$\{[\s\S]*?\}|<%[\s\S]*?%>/g, ' ');
