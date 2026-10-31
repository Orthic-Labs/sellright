// Dependency-free text and style helpers. They live apart from sanitize.ts because that module imports isomorphic-dompurify
// (~32 KB raw, ~13 KB br): any client bundle that imports it, even for one small helper, pulls the DOMPurify chunk on that page.
// Use these only where the result is rendered as TEXT (a text node, a meta value) or as CSS; HTML that is rendered as markup still
// goes through sanitize.ts.

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

const decodeEntities = (s: string): string =>
	s.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z]+));/gi, (m, dec, hex, name) => {
		if (name) return ENTITIES[name.toLowerCase()] ?? m;
		const code = dec ? Number(dec) : parseInt(hex, 16);
		return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
	});

/** Catalog HTML as plain text for rendering as a text node: script/style blocks, comments and tags dropped, entities decoded. */
export const htmlToText = (html: string): string => {
	if (!html || typeof html !== 'string') return '';
	let s = html.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
	// Repeat so a tag rebuilt by removing an inner one (`<<b>b>`) cannot survive.
	for (let prev = ''; prev !== s; ) {
		prev = s;
		s = s.replace(/<\/?[a-z!][^>]*>/gi, '');
	}
	return decodeEntities(s);
};

/** Inline CSS for a <style> element: every `<` is removed, so no tag (`</style>`) can be formed. */
export const cssText = (css: string): string => (!css || typeof css !== 'string' ? '' : css.replace(/</g, ''));

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
