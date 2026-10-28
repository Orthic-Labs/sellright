/**
 * #406 product editor model: staged edits, validation, save plan, option grid. Pure functions, no React.
 * Edit keys: `_title` | `_desc` | `_status` for the product, `<variantId>.<field>` for variants where field is
 * price | sale | oh | active | pre | pre_price | pre_label | pre_date. Money fields are decimal strings.
 */
import type { ProductDetail, VariantRow } from '../../api';

export type PreDraft = { price: string; label: string; date: string };
export type EditVal = string | boolean | PreDraft | null;
export type Edits = Record<string, EditVal>;

export const GROUP_THRESHOLD = 12;

export const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
export const fmt2 = (cents: number) => (cents / 100).toFixed(2);
export const toCents = (s: string) => Math.round(parseFloat(s) * 100);
export const isMoney = (s: string) => /^\d+(\.\d{1,2})?$/.test(s.trim());
export const isInt = (s: string) => /^\d+$/.test(s.trim());
/** datetime-local value (UTC, matching the API's ISO instant). */
export const dateInput = (iso: string | null | undefined) => (iso ? new Date(iso).toISOString().slice(0, 16) : '');
export const dateToIso = (local: string) => new Date(`${local}Z`).toISOString();

export function basePre(v: VariantRow): PreDraft | null {
  if (!v.isPreOrder) return null;
  return { price: fmt2(v.preOrderPrice ?? v.price), label: v.shipDateLabel ?? '', date: dateInput(v.shipDate) };
}

const splitKey = (k: string): [string, string] => { const i = k.indexOf('.'); return [k.slice(0, i), k.slice(i + 1)]; };
export const variantOf = (p: ProductDetail, id: string) => p.variants.find((v) => v.id === id);

export function baseValue(p: ProductDetail, key: string): EditVal | undefined {
  if (key === '_title') return p.name;
  if (key === '_desc') return p.description ?? '';
  if (key === '_status') return p.status;
  const [vid, f] = splitKey(key);
  const v = variantOf(p, vid);
  if (!v) return undefined;
  switch (f) {
    case 'price': return fmt2(v.price);
    case 'sale': return v.salePrice != null ? fmt2(v.salePrice) : '';
    case 'oh': return String(v.onHand);
    case 'active': return v.enabled;
    case 'pre': return basePre(v);
    case 'pre_price': return basePre(v)?.price ?? '';
    case 'pre_label': return basePre(v)?.label ?? '';
    case 'pre_date': return basePre(v)?.date ?? '';
    default: return undefined;
  }
}

/** Only edits that differ from the loaded server copy count; edits for removed variants are dropped. */
export function effective(p: ProductDetail, edits: Edits): Edits {
  const out: Edits = {};
  for (const [k, val] of Object.entries(edits)) {
    const base = baseValue(p, k);
    if (base === undefined) continue;
    if (JSON.stringify(base) !== JSON.stringify(val)) out[k] = val;
  }
  return out;
}

export const hasEdit = (edits: Edits, key: string) => Object.prototype.hasOwnProperty.call(edits, key);

export function curPre(v: VariantRow, edits: Edits): PreDraft | null {
  const k = `${v.id}.pre`;
  const P = hasEdit(edits, k) ? (edits[k] as PreDraft | null) : basePre(v);
  if (!P) return null;
  const r = { ...P };
  if (hasEdit(edits, `${v.id}.pre_price`)) r.price = edits[`${v.id}.pre_price`] as string;
  if (hasEdit(edits, `${v.id}.pre_label`)) r.label = edits[`${v.id}.pre_label`] as string;
  if (hasEdit(edits, `${v.id}.pre_date`)) r.date = edits[`${v.id}.pre_date`] as string;
  return r;
}

export function curField(p: ProductDetail, edits: Edits, vid: string, f: 'price' | 'sale' | 'oh'): string;
export function curField(p: ProductDetail, edits: Edits, vid: string, f: 'active'): boolean;
export function curField(p: ProductDetail, edits: Edits, vid: string, f: string): EditVal {
  const k = `${vid}.${f}`;
  return hasEdit(edits, k) ? edits[k]! : (baseValue(p, k) ?? '');
}

export const curStock = (p: ProductDetail, edits: Edits, v: VariantRow): number => {
  const oh = curField(p, edits, v.id, 'oh');
  return isInt(oh) ? Number(oh) : 0;
};
export const availableOf = (p: ProductDetail, edits: Edits, v: VariantRow) => curStock(p, edits, v) - v.allocated;

export type VariantErrors = Partial<Record<'price' | 'sale' | 'oh' | 'pre_price' | 'pre_label' | 'pre_date', string>>;

/** Validates only what the person touched, so a legacy value never blocks an unrelated save. `edits` must be effective. */
export function variantErrors(p: ProductDetail, edits: Edits, v: VariantRow, now = Date.now()): VariantErrors {
  const e: VariantErrors = {};
  const edited = (f: string) => hasEdit(edits, `${v.id}.${f}`);
  const price = curField(p, edits, v.id, 'price');
  const sale = curField(p, edits, v.id, 'sale');
  const oh = curField(p, edits, v.id, 'oh');
  if (edited('price') && (!isMoney(price) || !(Number(price) > 0))) e.price = 'Enter a price above 0, like 40.00.';
  if (edited('sale') || edited('price')) {
    if (sale !== '' && (!isMoney(sale) || !(Number(sale) > 0))) e.sale = 'Enter an amount, or leave empty.';
    else if (sale !== '' && !e.price && isMoney(price) && Number(sale) >= Number(price)) e.sale = 'Must be lower than the price.';
  }
  if (edited('oh') && !isInt(oh)) e.oh = 'Whole number, 0 or more.';
  const touchedPre = ['pre', 'pre_price', 'pre_label', 'pre_date'].some(edited);
  const pr = curPre(v, edits);
  if (touchedPre && pr) {
    if (!isMoney(pr.price) || !(Number(pr.price) > 0)) e.pre_price = 'Enter a price above 0.';
    if (!pr.label.trim()) e.pre_label = "Customers see this; it can't be empty.";
    if (!pr.date) e.pre_date = 'Enter a ship date.';
    else {
      const t = new Date(`${pr.date}Z`).getTime();
      if (Number.isNaN(t)) e.pre_date = 'Enter a valid date and time.';
      else if (edited('pre_date') && t < now) e.pre_date = 'That date has passed.';
    }
  }
  return e;
}

export type VariantPlan = { id: string; sku: string; patch: Record<string, unknown>; onHand?: number; keys: string[] };
export type ProductPlan = { body: Record<string, unknown>; keys: string[] };

/** What to send for a set of (already validated, effective) edits. */
export function buildPlan(p: ProductDetail, edits: Edits): { product: ProductPlan | null; variants: VariantPlan[] } {
  const body: Record<string, unknown> = {};
  const pkeys: string[] = [];
  if (hasEdit(edits, '_title')) { body.name = (edits['_title'] as string).trim(); pkeys.push('_title'); }
  if (hasEdit(edits, '_desc')) { body.description = edits['_desc'] as string; pkeys.push('_desc'); }
  if (hasEdit(edits, '_status')) { body.status = edits['_status'] as string; pkeys.push('_status'); }
  const variants: VariantPlan[] = [];
  for (const v of p.variants) {
    const keys = Object.keys(edits).filter((k) => k.startsWith(`${v.id}.`));
    if (!keys.length) continue;
    const edited = (f: string) => hasEdit(edits, `${v.id}.${f}`);
    const patch: Record<string, unknown> = {};
    if (edited('price')) patch.price = toCents(curField(p, edits, v.id, 'price'));
    if (edited('sale')) { const s = curField(p, edits, v.id, 'sale'); patch.salePrice = s === '' ? null : toCents(s); }
    if (edited('active')) patch.enabled = curField(p, edits, v.id, 'active');
    if (['pre', 'pre_price', 'pre_label', 'pre_date'].some(edited)) {
      const pr = curPre(v, edits);
      if (!pr) patch.isPreOrder = false;
      else {
        patch.isPreOrder = true;
        patch.preOrderPrice = toCents(pr.price);
        patch.shipDateLabel = pr.label.trim() || null;
        patch.shipDate = pr.date ? dateToIso(pr.date) : null;
      }
    }
    const plan: VariantPlan = { id: v.id, sku: v.sku, patch, keys };
    if (edited('oh')) plan.onHand = Number(curField(p, edits, v.id, 'oh'));
    variants.push(plan);
  }
  return { product: pkeys.length ? { body, keys: pkeys } : null, variants };
}

// ── option grid (grouping + "not offered") ───────────────────────────────────
export type OptGroup = { id: string; name: string; position: number; options: { id: string; value: string; position: number }[] };
export type Cell = { a: string; b: string; aId: string; bId: string };
export type Grid = { first: OptGroup; second: OptGroup; cells: Map<string, Cell>; grouped: boolean };

/** Two option groups with every variant resolved to one value in each. Grouped by the first option above GROUP_THRESHOLD variants. */
export function buildGrid(groups: OptGroup[], variants: VariantRow[]): Grid | null {
  if (groups.length !== 2 || !variants.length) return null;
  const [first, second] = groups as [OptGroup, OptGroup];
  const cells = new Map<string, Cell>();
  for (const v of variants) {
    const ids = v.optionIds ?? [];
    const a = first.options.find((o) => ids.includes(o.id));
    const b = second.options.find((o) => ids.includes(o.id));
    if (!a || !b) return null;
    cells.set(v.id, { a: a.value, b: b.value, aId: a.id, bId: b.id });
  }
  return { first, second, cells, grouped: variants.length > GROUP_THRESHOLD };
}

export function orderedVariants(p: ProductDetail, grid: Grid | null): VariantRow[] {
  if (!grid) return p.variants;
  const ai = (v: VariantRow) => grid.first.options.findIndex((o) => o.id === grid.cells.get(v.id)!.aId);
  const bi = (v: VariantRow) => grid.second.options.findIndex((o) => o.id === grid.cells.get(v.id)!.bId);
  return [...p.variants].sort((x, y) => ai(x) - ai(y) || bi(x) - bi(y));
}

export function missingCombos(grid: Grid, variants: VariantRow[], onlyFirstId?: string) {
  const have = new Set(variants.map((v) => { const c = grid.cells.get(v.id)!; return `${c.aId}|${c.bId}`; }));
  const out: { a: OptGroup['options'][number]; b: OptGroup['options'][number] }[] = [];
  for (const a of grid.first.options) {
    if (onlyFirstId && a.id !== onlyFirstId) continue;
    for (const b of grid.second.options) if (!have.has(`${a.id}|${b.id}`)) out.push({ a, b });
  }
  return out;
}
