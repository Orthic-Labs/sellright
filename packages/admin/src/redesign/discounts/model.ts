/**
 * #406 discounts model. Holds the condition builders the original page exported (pages/Discounts.tsx re-exports them
 * for Discounts.test.ts), plus the one status function, list filtering/paging, validation and overlap detection.
 */

export interface Promo {
  id: string; code: string | null; type: string; value: number; enabled: boolean;
  freeShipping?: boolean;
  usedCount: number; usageLimit: number | null; perCustomerUsageLimit: number | null;
  startsAt?: string | null; endsAt?: string | null;
}
export interface PromoDetail extends Promo {
  conditions: unknown;
  /** Present only once the API returns them on the detail route. */
  priority?: number | null;
  exclusionGroup?: string | null;
  usage: { orderCode: string; email: string | null; at: string }[];
}
export interface ConditionArg { name: string; value: string }
export interface Condition { code: string; args?: ConditionArg[] }

export type ScopeKind = '' | 'collections' | 'products' | 'tags';

/** Reads the repo's existing condition shape (money/coupon.ts evaluateCoupon)
 *  back into simple form fields: no new condition vocabulary invented here,
 *  only surfaced: `minimum_order_amount` and the native item-scope conditions
 *  `at_least_n_in_collections` / `at_least_n_products` / `at_least_n_with_tags`,
 *  which match on a product's real collection membership, id, or `tags`. */
export function readCondition(conditions: unknown, code: string): Record<string, string> {
  const arr = Array.isArray(conditions) ? (conditions as Condition[]) : [];
  const c = arr.find((x) => x?.code === code);
  const out: Record<string, string> = {};
  for (const a of c?.args ?? []) out[a.name] = a.value;
  return out;
}

export interface FormState {
  id: string | null; // null = create
  code: string; type: string; value: string;
  usageLimit: string; perCustomerUsageLimit: string;
  startsAt: string; endsAt: string;
  minOrderAmount: string;
  scope: ScopeKind;
  scopeMinimum: string;
  collectionIds: string[];
  products: { id: string; name: string }[];
  tags: string[];
  /** Set when a saved discount still carries the retired
   *  `at_least_n_with_facets` condition: shown as a warning in the form and
   *  dropped on save (buildConditions only ever emits native codes). */
  legacyFacetCondition: boolean;
  enabled: boolean;
  /** undefined = not loaded from the API; the payload then leaves the stored value alone. */
  priority?: string;
  exclusionGroup?: string;
}

export function emptyForm(): FormState {
  return { id: null, code: '', type: 'percentage', value: '', usageLimit: '', perCustomerUsageLimit: '', startsAt: '', endsAt: '', minOrderAmount: '', scope: '', scopeMinimum: '1', collectionIds: [], products: [], tags: [], legacyFacetCondition: false, enabled: true, priority: '0', exclusionGroup: '' };
}

/** ISO datetime <-> the value a `<input type="datetime-local">` wants (no
 *  timezone suffix, minute precision). */
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function fromLocalInput(v: string): string | null {
  return v ? new Date(v).toISOString() : null;
}

const parseIds = (raw: string | undefined): string[] => {
  try {
    const v = JSON.parse(raw ?? '[]');
    return Array.isArray(v) ? v.map(String) : [];
  } catch { return []; }
};

/** Maps a saved discount's `conditions` array back into form state: the
 *  inverse of buildConditions(). Product scope ids come back as `{id, name}`
 *  with the id as a placeholder name; the component resolves real names via
 *  `GET /products/{id}` afterwards (no new endpoints). */
export function hydrateForm(p: PromoDetail): FormState {
  const minCond = readCondition(p.conditions, 'minimum_order_amount');
  const colCond = readCondition(p.conditions, 'at_least_n_in_collections');
  const prodCond = readCondition(p.conditions, 'at_least_n_products');
  const tagCond = readCondition(p.conditions, 'at_least_n_with_tags');
  const legacyCond = readCondition(p.conditions, 'at_least_n_with_facets');
  const f = emptyForm();
  return {
    ...f,
    id: p.id,
    code: p.code ?? '', type: p.type, value: p.type === 'percentage' ? String(p.value) : p.type === 'free_shipping' ? '' : (p.value / 100).toFixed(2),
    usageLimit: p.usageLimit != null ? String(p.usageLimit) : '', perCustomerUsageLimit: p.perCustomerUsageLimit != null ? String(p.perCustomerUsageLimit) : '',
    startsAt: toLocalInput(p.startsAt), endsAt: toLocalInput(p.endsAt),
    minOrderAmount: minCond.amount ? (Number(minCond.amount) / 100).toFixed(2) : '',
    scope: colCond.collectionIds ? 'collections' : prodCond.productIds ? 'products' : tagCond.tags ? 'tags' : '',
    scopeMinimum: colCond.minimum ?? prodCond.minimum ?? tagCond.minimum ?? '1',
    collectionIds: parseIds(colCond.collectionIds),
    products: parseIds(prodCond.productIds).map((id) => ({ id, name: id })),
    tags: parseIds(tagCond.tags),
    legacyFacetCondition: Object.keys(legacyCond).length > 0,
    enabled: p.enabled,
    priority: typeof p.priority === 'number' ? String(p.priority) : undefined,
    exclusionGroup: p.exclusionGroup !== undefined ? (p.exclusionGroup ?? '') : undefined,
  };
}

export function buildConditions(f: FormState): unknown[] | null {
  const conds: Condition[] = [];
  const minAmount = f.minOrderAmount.trim() ? Math.round(parseFloat(f.minOrderAmount) * 100) : 0;
  if (minAmount > 0) conds.push({ code: 'minimum_order_amount', args: [{ name: 'amount', value: String(minAmount) }] });
  // At most one item-scope condition per discount, emitted exactly in the
  // shape money/coupon.ts evaluates (JSON string-array arg + `minimum`).
  const minimum = String(Math.max(1, Number(f.scopeMinimum) || 1));
  if (f.scope === 'collections' && f.collectionIds.length > 0) {
    conds.push({ code: 'at_least_n_in_collections', args: [
      { name: 'collectionIds', value: JSON.stringify(f.collectionIds) },
      { name: 'minimum', value: minimum },
    ] });
  } else if (f.scope === 'products' && f.products.length > 0) {
    conds.push({ code: 'at_least_n_products', args: [
      { name: 'productIds', value: JSON.stringify(f.products.map((p) => p.id)) },
      { name: 'minimum', value: minimum },
    ] });
  } else if (f.scope === 'tags' && f.tags.length > 0) {
    conds.push({ code: 'at_least_n_with_tags', args: [
      { name: 'tags', value: JSON.stringify(f.tags) },
      { name: 'minimum', value: minimum },
    ] });
  }
  return conds.length ? conds : null;
}

/** A chosen scope with nothing selected must not save: buildConditions would
 *  silently emit no scope condition, turning the discount into a whole-order
 *  (store-wide) one. Blocks submit until the merchant picks an item or drops
 *  back to Whole order. */
export function scopeError(f: FormState): string | null {
  if (f.scope === '') return null;
  const empty =
    (f.scope === 'collections' && f.collectionIds.length === 0) ||
    (f.scope === 'products' && f.products.length === 0) ||
    (f.scope === 'tags' && f.tags.length === 0);
  return empty ? 'Select at least one collection, product or tag — or choose Whole order.' : null;
}

export function buildPayload(f: FormState) {
  const isPct = f.type === 'percentage';
  return {
    code: f.code || null,
    type: f.type,
    value: f.type === 'free_shipping' ? 0 : isPct ? Math.round(parseFloat(f.value || '0')) : Math.round(parseFloat(f.value || '0') * 100),
    usageLimit: f.usageLimit ? Number(f.usageLimit) : null,
    perCustomerUsageLimit: f.perCustomerUsageLimit ? Number(f.perCustomerUsageLimit) : null,
    startsAt: fromLocalInput(f.startsAt),
    endsAt: fromLocalInput(f.endsAt),
    conditions: buildConditions(f),
    enabled: f.enabled,
    // Only sent when the form holds a real value, so a save never resets what the API didn't tell us.
    ...(f.priority !== undefined && f.priority.trim() !== '' ? { priority: Number(f.priority) } : {}),
    ...(f.exclusionGroup !== undefined ? { exclusionGroup: f.exclusionGroup.trim() || null } : {}),
  };
}

// ── status: the ONE function behind tabs, counts, pills and the editor status line ──────────────────────────────

export type DiscountStatus = 'active' | 'scheduled' | 'expired' | 'disabled';

/** Disabled if !enabled; Scheduled if startsAt > now; Expired if endsAt <= now; else Active. Dates and enabled only. */
export function discountStatus(d: { enabled: boolean; startsAt?: string | null; endsAt?: string | null }, now: number = Date.now()): DiscountStatus {
  if (!d.enabled) return 'disabled';
  const s = d.startsAt ? Date.parse(d.startsAt) : NaN;
  const e = d.endsAt ? Date.parse(d.endsAt) : NaN;
  if (!Number.isNaN(s) && s > now) return 'scheduled';
  if (!Number.isNaN(e) && e <= now) return 'expired';
  return 'active';
}

export type TabId = DiscountStatus | 'all';
export const TABS: { id: TabId; label: string }[] = [
  { id: 'active', label: 'Active' }, { id: 'scheduled', label: 'Scheduled' }, { id: 'expired', label: 'Expired' },
  { id: 'disabled', label: 'Disabled' }, { id: 'all', label: 'All' },
];
export const PAGE_SIZE = 25;
export const SOON_MS = 7 * 864e5;

/** Counts always come from the full list, never from the current search or page. */
export function tabCounts(list: Promo[], now: number = Date.now()): Record<TabId, number> {
  const out: Record<TabId, number> = { active: 0, scheduled: 0, expired: 0, disabled: 0, all: list.length };
  for (const p of list) out[discountStatus(p, now)] += 1;
  return out;
}

export type SortKey = 'used' | 'code' | 'ends';
export function filterList(list: Promo[], tab: TabId, q: string, sort: SortKey, now: number = Date.now()): Promo[] {
  const needle = q.trim().toLowerCase();
  const out = list.filter((p) => (tab === 'all' || discountStatus(p, now) === tab) && (!needle || (p.code ?? '').toLowerCase().includes(needle)));
  const cmp: Record<SortKey, (a: Promo, b: Promo) => number> = {
    used: (a, b) => b.usedCount - a.usedCount || (a.code ?? '').localeCompare(b.code ?? ''),
    code: (a, b) => (a.code ?? '').localeCompare(b.code ?? ''),
    ends: (a, b) => (a.endsAt ? Date.parse(a.endsAt) : Infinity) - (b.endsAt ? Date.parse(b.endsAt) : Infinity),
  };
  return out.sort(cmp[sort]);
}

export function typeLabel(t: string): string { return t === 'percentage' ? 'Percentage' : t === 'free_shipping' ? 'Free shipping' : 'Fixed amount'; }

// ── validation ───────────────────────────────────────────────────────────────────────────────────────────────────

export type FieldKey = 'code' | 'value' | 'scope' | 'minOrder' | 'scopeMin' | 'limit' | 'perCust' | 'priority' | 'starts' | 'ends';
export type Errors = Partial<Record<FieldKey, string>>;

const isInt = (v: string, min: number) => /^\d+$/.test(v.trim()) && Number(v) >= min;
const isMoney = (v: string) => /^\d+(\.\d{1,2})?$/.test(v.trim());
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** `others`: codes of every discount in the store except this one, for the store-wide unique check. */
export function validateForm(f: FormState, used: number, otherCodes: (string | null)[]): Errors {
  const E: Errors = {};
  const code = f.code.trim();
  if (code && otherCodes.some((c) => c && c.toLowerCase() === code.toLowerCase())) E.code = 'A discount with that code already exists';
  if (f.type !== 'free_shipping') {
    const v = f.value.trim();
    if (f.type === 'percentage') {
      if (!isInt(v, 1) || Number(v) > 100) E.value = 'Enter a whole number from 1 to 100.';
    } else if (!isMoney(v) || !(Number(v) > 0)) E.value = 'Enter an amount above 0.';
  }
  const se = f.scope === '' ? null : scopeError(f);
  if (se) E.scope = `Pick at least one ${f.scope === 'collections' ? 'collection' : f.scope === 'products' ? 'product' : 'tag'}, or choose Everything.`;
  if (f.minOrderAmount.trim() && (!isMoney(f.minOrderAmount) || !(Number(f.minOrderAmount) > 0))) E.minOrder = 'Enter an amount above 0, or leave empty.';
  if (f.scope !== '' && !isInt(f.scopeMinimum, 1)) E.scopeMin = 'Whole number, 1 or more.';
  if (f.usageLimit.trim()) {
    if (!isInt(f.usageLimit, 1)) E.limit = 'Whole number, or leave empty for unlimited.';
    else if (Number(f.usageLimit) < used) E.limit = `Already used ${plural(used, 'time')}. The limit can't be lower.`;
  }
  if (f.perCustomerUsageLimit.trim() && !isInt(f.perCustomerUsageLimit, 1)) E.perCust = 'Whole number, or leave empty for unlimited.';
  if (f.priority !== undefined && f.priority.trim() && !isInt(f.priority, 0)) E.priority = 'Whole number, 0 or more.';
  const s = f.startsAt ? Date.parse(fromLocalInput(f.startsAt) ?? '') : null;
  const e = f.endsAt ? Date.parse(fromLocalInput(f.endsAt) ?? '') : null;
  if (f.startsAt && Number.isNaN(s)) E.starts = 'Enter a valid date and time.';
  if (f.endsAt && Number.isNaN(e)) E.ends = 'Enter a valid date and time.';
  else if (s !== null && e !== null && !Number.isNaN(s) && e <= s) E.ends = 'Must be after the start date.';
  return E;
}

// ── overlap ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ScopeSet { kind: ScopeKind; ids: string[] }

/** Scope of a saved discount, from its conditions. */
export function scopeOf(conditions: unknown): ScopeSet {
  const col = readCondition(conditions, 'at_least_n_in_collections');
  const prod = readCondition(conditions, 'at_least_n_products');
  const tag = readCondition(conditions, 'at_least_n_with_tags');
  if (col.collectionIds) return { kind: 'collections', ids: parseIds(col.collectionIds) };
  if (prod.productIds) return { kind: 'products', ids: parseIds(prod.productIds) };
  if (tag.tags) return { kind: 'tags', ids: parseIds(tag.tags) };
  return { kind: '', ids: [] };
}

export function formScope(f: FormState): ScopeSet {
  if (f.scope === 'collections') return { kind: 'collections', ids: f.collectionIds };
  if (f.scope === 'products') return { kind: 'products', ids: f.products.map((p) => p.id) };
  if (f.scope === 'tags') return { kind: 'tags', ids: f.tags };
  return { kind: '', ids: [] };
}

/** Everything meets everything. Same-kind scopes meet when they share an id. Different kinds can't be compared
 *  without product-to-collection membership, so they are not reported. */
export function scopesMeet(a: ScopeSet, b: ScopeSet): boolean {
  if (a.kind === '' || b.kind === '') return true;
  return a.kind === b.kind && a.ids.some((x) => b.ids.includes(x));
}

/** [start, end] in ms; open ends are infinite. */
export function windowOf(d: { startsAt?: string | null; endsAt?: string | null }): [number, number] {
  const s = d.startsAt ? Date.parse(d.startsAt) : NaN;
  const e = d.endsAt ? Date.parse(d.endsAt) : NaN;
  return [Number.isNaN(s) ? -Infinity : s, Number.isNaN(e) ? Infinity : e];
}
export function windowsMeet(a: [number, number], b: [number, number]): boolean { return a[0] <= b[1] && b[0] <= a[1]; }

/** Other discounts that are active or scheduled and could be live over the same dates (candidates for the detail fetch). */
export function overlapCandidates(list: Promo[], self: string | null, f: FormState, now: number = Date.now()): Promo[] {
  if (f.type === 'free_shipping') return [];
  const mine = windowOf({ startsAt: fromLocalInput(f.startsAt), endsAt: fromLocalInput(f.endsAt) });
  return list.filter((p) => p.id !== self && p.type !== 'free_shipping' && ['active', 'scheduled'].includes(discountStatus(p, now)) && windowsMeet(mine, windowOf(p)));
}
