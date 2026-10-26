/**
 * Product JSON-LD text helpers: the plain-text description and the machine-readable specs parsed from the free-text "SPECS" block
 * authored inside a product description ("Blade Material: 14C28N<br>..."). Pure functions. Ported from the previous the previous platform store
 * (`store/src/utils/product-specs.ts`, `services/seo-api.service.ts`); only structures what the description already says, so a
 * description without a SPECS block yields nothing.
 */

/** Text extraction, not sanitisation: tags are removed until the string stops changing (a single pass leaves `<scr<x>ipt>` as
 *  `<script>`) and any `<` or `>` that survives is dropped, so no angle bracket from the source reaches the output. */
export function stripTags(s: string): string {
  let prev: string;
  do {
    prev = s;
    s = s.replace(/<[^<>]*>/g, '');
  } while (s !== prev);
  return s.replace(/[<>]/g, '');
}

const ENTITIES: Record<string, string> = { '&nbsp;': ' ', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&amp;': '&' };

/** Catalog HTML as plain text: block breaks become spaces, tags are dropped, the common text entities decoded, whitespace collapsed. */
export function htmlToPlainText(html: string): string {
  const spaced = html.replace(/<\s*br\s*\/?\s*>/gi, ' ').replace(/<\/\s*(p|div|li|h[1-6])\s*>/gi, ' ');
  return stripTags(spaced).replace(/&(nbsp|quot|#39|apos|amp);/g, (m) => ENTITIES[m] ?? m).replace(/\s+/g, ' ').trim();
}

export interface ParsedSpecs {
  /** "Label: Value" spec pairs, in source order. */
  rows: Array<[string, string]>;
}

export function parseSpecBlock(html: string | null | undefined): ParsedSpecs | null {
  if (!html) return null;
  const marker = html.search(/SPECS?\b/i);
  if (marker === -1) return null;
  const tail = stripTags(html.slice(marker).replace(/^SPECS?\b\s*/i, '').replace(/<\s*br\s*\/?\s*>/gi, '\n').replace(/<\/\s*p\s*>/gi, '\n'));
  const lines = tail
    .split('\n')
    .map((l) => l.replace(/[ ]/g, ' ').trim())
    .filter((l) => l && l !== '"');
  const rows: Array<[string, string]> = [];
  for (const line of lines) {
    const m = line.match(/^([^:]{1,40}):\s*(.+?)\.?$/);
    if (m?.[1] && m[2]?.trim()) rows.push([m[1].trim(), m[2].trim()]);
  }
  return rows.length > 0 ? { rows } : null;
}

/** schema.org PropertyValue array derived from the spec rows. */
export function specsToSchemaProperties(html: string | null | undefined): Array<{ '@type': 'PropertyValue'; name: string; value: string }> {
  const parsed = parseSpecBlock(html);
  return parsed ? parsed.rows.map(([name, value]) => ({ '@type': 'PropertyValue' as const, name, value })) : [];
}

/** Best-effort blade/primary material for schema.org `material`. */
export function specsToMaterial(html: string | null | undefined): string | undefined {
  const mat = parseSpecBlock(html)?.rows.find(([k]) => /blade material/i.test(k));
  return mat ? mat[1] : undefined;
}
