/**
 * Parser for the free-text "SPECS" block authored inside product descriptions
 * (e.g. "Blade Material: 14C28N<br>..."). Only structures data already present
 * in the description; products without a SPECS block return null.
 */

export interface ParsedSpecs {
  /** Description HTML preceding the SPECS block. */
  intro: string;
  /** "Label: Value" spec pairs, in source order. */
  rows: Array<[string, string]>;
  /** Non-key/value spec lines. */
  notes: string[];
}

export const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Text extraction, not sanitisation: every label, value and note goes through `escapeHtml` before it is rendered. Tags are
 * removed until the string stops changing (a single pass leaves `<scr<x>ipt>` as `<script>`), and any `<` or `>` that survives
 * (unterminated tags) is dropped too, so no angle bracket from the source ever reaches the spec rows.
 */
export function stripTags(s: string): string {
  let prev: string;
  do {
    prev = s;
    s = s.replace(/<[^<>]*>/g, '');
  } while (s !== prev);
  return s.replace(/[<>]/g, '');
}

export function parseSpecBlock(html: string): ParsedSpecs | null {
  if (!html) return null;
  const marker = html.search(/SPECS?\b/i);
  if (marker === -1) return null;

  const intro = html.slice(0, marker).replace(/<p>\s*<\/p>\s*$/i, '').replace(/<p>\s*$/i, '');
  let tail = html.slice(marker).replace(/^SPECS?\b\s*/i, '');
  tail = stripTags(tail.replace(/<\s*br\s*\/?\s*>/gi, '\n').replace(/<\/\s*p\s*>/gi, '\n'));
  const lines = tail
    .split('\n')
    .map((l) => l.replace(/[\u00a0]/g, ' ').trim())
    .filter((l) => l && l !== '"');

  const rows: Array<[string, string]> = [];
  const notes: string[] = [];
  for (const line of lines) {
    const m = line.match(/^([^:]{1,40}):\s*(.+?)\.?$/);
    if (m && m[2].trim()) rows.push([m[1].trim(), m[2].trim()]);
    else notes.push(line.replace(/\.$/, ''));
  }
  if (rows.length === 0) return null;
  return { intro, rows, notes };
}

/** Markup for a parsed spec block; every label, value and note is escaped. */
export function renderSpecBlock(parsed: ParsedSpecs): string {
  const rowsHtml = parsed.rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join('');
  const notesHtml = parsed.notes.length
    ? `<div class="sr-specs-notes">${parsed.notes.map((n) => `<span>${escapeHtml(n)}</span>`).join('')}</div>`
    : '';
  return `<div class="sr-specs"><div class="sr-specs-title">Specs</div><dl class="sr-specs-grid">${rowsHtml}</dl>${notesHtml}</div>`;
}
