// Brand views, plan §1 "Rich content": the only way HTML reaches a brand view. `SanitizedHtml` is created here and
// nowhere else; `RichContent` (widgets/RichContent.tsx) is the only renderer. Brand code never inserts HTML (check-code-shape r7).
import { sanitizeBlogHtml, sanitizeProductDescription } from '~/utils/sanitize';

/** Sanitised markup. Branded by `kind`; JSON-shaped so it can cross the slot boundary as plain data. */
export type SanitizedHtml = { readonly kind: 'sanitized-html'; readonly html: string };

/** `product` = the product-description policy; `blog` = the default policy plus H2/H3 heading ids (utils/sanitize.ts). */
export type SanitizePolicy = 'product' | 'blog';

export function toSanitizedHtml(raw: string, policy: SanitizePolicy): SanitizedHtml {
	const html = policy === 'blog' ? sanitizeBlogHtml(raw) : sanitizeProductDescription(raw);
	return { kind: 'sanitized-html', html };
}

/** True for a value `toSanitizedHtml` could have produced (shape only; a forged literal passes, see the plan's trust model). */
export const isSanitizedHtml = (v: unknown): v is SanitizedHtml =>
	!!v && typeof v === 'object' && (v as SanitizedHtml).kind === 'sanitized-html' && typeof (v as SanitizedHtml).html === 'string';
