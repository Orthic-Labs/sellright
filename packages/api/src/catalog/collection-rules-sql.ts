/**
 * PERF-16: compile a smart-collection's rule DSL (collection-rules.ts) into a
 * Drizzle SQL predicate against `product` (+ correlated min-price subquery
 * against `product_variant`), so the storefront browse endpoint can filter +
 * paginate in Postgres instead of loading every store product into JS.
 *
 * Keeps semantics identical to `productMatchesRules` in collection-rules.ts —
 * same case-insensitive text compare, same price-as-cents numeric compare.
 * Only the field/op combinations the DSL actually allows are meaningful; an
 * illegal combo (e.g. price+contains, title+gt) compiles to `sql\`false\``,
 * mirroring matchOne()'s `return false` for the same illegal combos — never
 * silently matches everything.
 */
import { and, or, sql, type SQL } from 'drizzle-orm';
import * as s from '../db/schema.js';
import type { CollectionRules, RuleCondition } from './collection-rules.js';

// Correlated scalar subquery: cheapest non-deleted variant price for this product.
const MIN_PRICE = sql<number>`(select min(pv.price) from product_variant pv where pv.product_id = ${s.product.id} and pv.deleted_at is null)`;

function textField(field: RuleCondition['field']): SQL {
  if (field === 'title') return sql`${s.product.name}`;
  if (field === 'vendor') return sql`coalesce(${s.product.vendor}, '')`;
  if (field === 'productType') return sql`coalesce(${s.product.productType}, '')`;
  throw new Error(`textField: not a text field: ${field}`);
}

/** All ops are SQL-compilable for the current DSL (title/vendor/productType/tag/price × equals/contains/starts_with/gt/lt). */
function compileCondition(cond: RuleCondition): SQL {
  if (cond.field === 'price') {
    const target = Number(cond.value);
    if (Number.isNaN(target)) return sql`false`; // matchOne returns false on NaN target too
    if (cond.op === 'gt') return sql`${MIN_PRICE} > ${target}`;
    if (cond.op === 'lt') return sql`${MIN_PRICE} < ${target}`;
    if (cond.op === 'equals') return sql`${MIN_PRICE} = ${target}`;
    return sql`false`; // contains/starts_with don't apply to price (matches matchOne)
  }

  if (cond.field === 'tag') {
    const v = cond.value.trim().toLowerCase();
    // tags is text[]; compare case-insensitively against each element via a
    // lateral EXISTS over unnest — mirrors matchOne's `tags.map(ci)...`.
    if (cond.op === 'equals') {
      return sql`exists (select 1 from unnest(coalesce(${s.product.tags}, array[]::text[])) t where lower(trim(t)) = ${v})`;
    }
    if (cond.op === 'contains') {
      return sql`exists (select 1 from unnest(coalesce(${s.product.tags}, array[]::text[])) t where lower(trim(t)) like ${'%' + escapeLike(v) + '%'})`;
    }
    if (cond.op === 'starts_with') {
      return sql`exists (select 1 from unnest(coalesce(${s.product.tags}, array[]::text[])) t where lower(trim(t)) like ${escapeLike(v) + '%'})`;
    }
    return sql`false`;
  }

  // text fields: title / vendor / productType
  const v = cond.value.trim().toLowerCase();
  const field = textField(cond.field);
  if (cond.op === 'equals') return sql`lower(trim(${field})) = ${v}`;
  if (cond.op === 'contains') return sql`lower(trim(${field})) like ${'%' + escapeLike(v) + '%'}`;
  if (cond.op === 'starts_with') return sql`lower(trim(${field})) like ${escapeLike(v) + '%'}`;
  return sql`false`; // gt/lt don't apply to text (matches matchOne)
}

// Escape LIKE metacharacters in a user-supplied value so `%`/`_` in a tag or
// title don't get interpreted as wildcards — matchOne uses plain JS
// String#includes/startsWith, which treats them literally.
function escapeLike(v: string): string {
  return v.replace(/[\\%_]/g, (m) => '\\' + m);
}

/** Compile a full CollectionRules DSL into one Drizzle SQL predicate over `product`. */
export function compileRulesToSql(rules: CollectionRules): SQL {
  const parts = rules.conditions.map(compileCondition);
  const combined = rules.match === 'all' ? and(...parts) : or(...parts);
  // `and()`/`or()` with a non-empty array never return undefined, but the
  // types allow it — parseRules already guarantees conditions.length > 0.
  return combined ?? sql`false`;
}
