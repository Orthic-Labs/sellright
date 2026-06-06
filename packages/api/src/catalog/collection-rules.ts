/**
 * Smart-collection membership rules (Shopify-parity). A collection with `rules`
 * includes products matching them dynamically — no stored membership. Pure — the
 * caller supplies the candidate products. `match: all` = AND, `any` = OR.
 */
export type RuleField = 'title' | 'vendor' | 'productType' | 'tag' | 'price';
export type RuleOp = 'equals' | 'contains' | 'starts_with' | 'gt' | 'lt';
export type RuleCondition = { field: RuleField; op: RuleOp; value: string };
export type CollectionRules = { match: 'all' | 'any'; conditions: RuleCondition[] };

export type MatchableProduct = {
  name: string;
  vendor: string | null;
  productType: string | null;
  tags: string[] | null;
  minPrice: number | null; // cents
};

function ci(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase();
}

function matchOne(p: MatchableProduct, cond: RuleCondition): boolean {
  const v = ci(cond.value);
  if (cond.field === 'price') {
    const price = p.minPrice ?? NaN;
    const target = Number(cond.value);
    if (Number.isNaN(price) || Number.isNaN(target)) return false;
    if (cond.op === 'gt') return price > target;
    if (cond.op === 'lt') return price < target;
    if (cond.op === 'equals') return price === target;
    return false; // contains/starts_with don't apply to price
  }
  if (cond.field === 'tag') {
    const tags = (p.tags ?? []).map(ci);
    if (cond.op === 'equals') return tags.includes(v);
    if (cond.op === 'contains') return tags.some((t) => t.includes(v));
    if (cond.op === 'starts_with') return tags.some((t) => t.startsWith(v));
    return false;
  }
  const field = cond.field === 'title' ? ci(p.name) : cond.field === 'vendor' ? ci(p.vendor) : ci(p.productType);
  if (cond.op === 'equals') return field === v;
  if (cond.op === 'contains') return field.includes(v);
  if (cond.op === 'starts_with') return field.startsWith(v);
  return false; // gt/lt don't apply to text
}

/** Validate-and-parse an unknown `rules` jsonb into CollectionRules, or null. */
export function parseRules(rules: unknown): CollectionRules | null {
  if (!rules || typeof rules !== 'object') return null;
  const r = rules as { match?: unknown; conditions?: unknown };
  if (r.match !== 'all' && r.match !== 'any') return null;
  if (!Array.isArray(r.conditions) || r.conditions.length === 0) return null;
  return r as CollectionRules;
}

export function productMatchesRules(p: MatchableProduct, rules: CollectionRules): boolean {
  if (!rules.conditions.length) return false;
  return rules.match === 'all'
    ? rules.conditions.every((c) => matchOne(p, c))
    : rules.conditions.some((c) => matchOne(p, c));
}
