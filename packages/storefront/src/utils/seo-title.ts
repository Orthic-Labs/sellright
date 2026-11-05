// #408 items 5 and 9: a <title> stays within MAX_TITLE_LENGTH characters. The ` | <store>` suffix is dropped when it would push the
// title over; a base title that is itself too long is cut at a word boundary (never mid-word) and ends in an ellipsis.
// Pure (no Qwik, no env) so utils/seo.ts, platform/head-resolve.ts and unit tests share one rule.

export const MAX_TITLE_LENGTH = 60;
const SEPARATOR = ' | ';
const ELLIPSIS = '…';

/** Trailing characters that read badly before an ellipsis (a dangling separator, dash, comma or ampersand). */
const DANGLING = /[\s,;:|\-–—/&(]+$/;

/**
 * `text` cut to at most `max` characters at a word boundary, with an ellipsis when anything was removed. Text that already fits is
 * only whitespace-normalised. A single word longer than `max` cannot be kept whole, so that one case is cut mid-word.
 */
export function truncateAtWord(text: string, max: number = MAX_TITLE_LENGTH): string {
	const t = text.replace(/\s+/g, ' ').trim();
	if (t.length <= max) return t;
	const room = max - ELLIPSIS.length;
	if (room <= 0) return t.slice(0, max);
	// A boundary at index `room` means the first `room` characters end exactly at a word, so look for a space at or before it.
	const space = t.lastIndexOf(' ', room);
	const cut = (space > 0 ? t.slice(0, space) : t.slice(0, room)).replace(DANGLING, '');
	return `${cut || t.slice(0, room)}${ELLIPSIS}`;
}

/**
 * The page <title>: `title | store` when that fits in `max`, otherwise the title alone (suffix dropped), shortened at a word boundary
 * if it is still too long. A title that already is the store name, or already ends with ` | store`, is not suffixed twice.
 */
export function fitTitle(title: string, storeName: string, max: number = MAX_TITLE_LENGTH): string {
	const clean = title.replace(/\s+/g, ' ').trim();
	const store = storeName.trim();
	if (!store || clean === store) return truncateAtWord(clean, max);
	const suffix = `${SEPARATOR}${store}`;
	const base = clean.endsWith(suffix) ? clean.slice(0, -suffix.length).trim() : clean;
	if (!base) return truncateAtWord(store, max);
	const composed = `${base}${suffix}`;
	return composed.length <= max ? composed : truncateAtWord(base, max);
}
