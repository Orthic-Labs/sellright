import DOMPurify from 'isomorphic-dompurify';

type DomPurifyConfig = Parameters<typeof DOMPurify.sanitize>[1];

/** The attribute allow-list of the default `sanitizeHtml` configuration (options replace keys wholesale, so a caller that adds one repeats it). */
export const DEFAULT_ALLOWED_ATTR = ['href', 'title', 'target', 'rel', 'class', 'src', 'alt', 'width', 'height'];

/**
 * Security utility for sanitizing HTML content to prevent XSS attacks
 * Uses DOMPurify to remove potentially malicious scripts and HTML
 */

/**
 * Sanitize HTML content for safe rendering
 * Removes script tags, event handlers, and other XSS vectors
 *
 * @param dirty - The potentially unsafe HTML string
 * @param options - Optional DOMPurify configuration
 * @returns Sanitized HTML string safe for rendering
 */
export const sanitizeHtml = (dirty: string, options?: DomPurifyConfig): string => {
	if (!dirty || typeof dirty !== 'string') {
		return '';
	}

	// Default configuration: Allow basic HTML formatting but remove scripts
	const defaultConfig: DomPurifyConfig = {
		ALLOWED_TAGS: [
			'p', 'br', 'strong', 'em', 'u', 'b', 'i', 'ul', 'ol', 'li',
			'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'a', 'span', 'div',
			'img', 'figure', 'figcaption', 'hr', 'pre', 'code',
			'table', 'thead', 'tbody', 'tr', 'th', 'td'
		],
		ALLOWED_ATTR: DEFAULT_ALLOWED_ATTR,
		ALLOW_DATA_ATTR: true,
		// Forbid tags that can execute JavaScript
		FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button'],
		FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'onfocus', 'onblur'],
		...options
	};

	try {
		return DOMPurify.sanitize(dirty, defaultConfig) as unknown as string;
	} catch (error) {
		console.error('HTML sanitization failed:', error);
		// Return empty string on error to be safe
		return '';
	}
};

/** A heading id the blog policy keeps: lowercase words joined by single hyphens, at most 80 chars. */
const BLOG_HEADING_ID = /^[a-z0-9]+(?:-[a-z0-9]+){0,15}$/;

/**
 * The `blog` sanitiser policy (brand views, plan §2.5): the default configuration plus `id`, kept only on H2/H3 with a
 * value matching BLOG_HEADING_ID (and at most 80 chars). Every other `id` is dropped. DOMPurify's SANITIZE_DOM stays on,
 * so an id that would clobber a document property (`location`) is dropped as well. The hook is added and removed inside
 * the call, so no other sanitiser call sees it.
 */
export const sanitizeBlogHtml = (dirty: string): string => {
	const hook = (node: Element, data: { attrName: string; attrValue: string; keepAttr: boolean }) => {
		if (data.attrName !== 'id') return;
		const tag = node.nodeName.toUpperCase();
		const ok = (tag === 'H2' || tag === 'H3') && data.attrValue.length <= 80 && BLOG_HEADING_ID.test(data.attrValue);
		if (!ok) data.keepAttr = false;
	};
	DOMPurify.addHook('uponSanitizeAttribute', hook as never);
	try {
		return sanitizeHtml(dirty, { ALLOWED_ATTR: [...DEFAULT_ALLOWED_ATTR, 'id'] });
	} finally {
		DOMPurify.removeHook('uponSanitizeAttribute', hook as never);
	}
};

/**
 * Sanitize product descriptions with more permissive formatting
 * Allows additional formatting tags commonly used in product descriptions
 */
export const sanitizeProductDescription = (dirty: string): string => {
	return sanitizeHtml(dirty, {
		ALLOWED_TAGS: [
			'p', 'br', 'strong', 'em', 'u', 'b', 'i', 'ul', 'ol', 'li',
			'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'a', 'span', 'div',
			'table', 'thead', 'tbody', 'tr', 'th', 'td', 'img'
		],
		ALLOWED_ATTR: DEFAULT_ALLOWED_ATTR,
		// Ensure links open safely
		ADD_ATTR: ['rel'],
		SAFE_FOR_TEMPLATES: true
	});
};

/**
 * Strip all HTML tags - returns plain text only
 * Use when you need to display content without any formatting
 */
export const stripHtml = (dirty: string): string => {
	if (!dirty || typeof dirty !== 'string') {
		return '';
	}

	return DOMPurify.sanitize(dirty, {
		ALLOWED_TAGS: [],
		ALLOWED_ATTR: [],
		KEEP_CONTENT: true
	}) as unknown as string;
};

/**
 * Sanitize inline JavaScript for controlled environments
 * ONLY use for trusted, static JavaScript - not user input
 * Validates against dangerous patterns
 */
export const sanitizeInlineScript = (scriptContent: string): string => {
	if (!scriptContent || typeof scriptContent !== 'string') {
		return '';
	}

	// Check for dangerous patterns that should never be in trusted scripts
	const dangerousPatterns = [
		/eval\s*\(/,
		/document\.write\s*\(/,
		/innerHTML\s*=/,
		/outerHTML\s*=/,
		/document\.location/,
		/window\.location\s*=/,
		/<script/i,
		/javascript:/i,
		/data:/i,
		/vbscript:/i
	];

	// Check for dangerous patterns
	for (const pattern of dangerousPatterns) {
		if (pattern.test(scriptContent)) {
			console.error('Dangerous pattern detected in script content:', pattern);
			return ''; // Return empty string for safety
		}
	}

	// Return the script content if it passes validation
	return scriptContent;
};

/**
 * Sanitize inline CSS styles
 * Only allows safe CSS properties
 */
export const sanitizeStyle = (styleString: string): string => {
	if (!styleString || typeof styleString !== 'string') {
		return '';
	}

	// Strip all HTML tags from style strings for safety
	return DOMPurify.sanitize(styleString, {
		ALLOWED_TAGS: [],
		ALLOWED_ATTR: [],
		SAFE_FOR_TEMPLATES: true
	}) as unknown as string;
};
