import { eq } from 'drizzle-orm';
import * as s from '../db/schema.js';
import type { ImportContext } from './context.js';
import type { ShippingCalculator } from '../shipping/calculator.js';

type Operation = { code: string; args: Array<{ name: string; value: string }> };
function operation(raw: unknown): Operation {
  const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!value || typeof value.code !== 'string' || !Array.isArray(value.args)) throw new Error('Invalid source operation');
  return value;
}
function number(value: string | undefined, fallback = 0) {
  const n = value == null || value === '' ? fallback : Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error('Invalid shipping amount');
  return n;
}
export function mapShipping(checkerRaw: unknown, calculatorRaw: unknown, pricesIncludeTax: boolean): ShippingCalculator {
  const checker = operation(checkerRaw), calculator = operation(calculatorRaw);
  if (calculator.code !== 'default-shipping-calculator') throw new Error('Unsupported shipping calculator');
  const check = Object.fromEntries(checker.args.map(arg => [arg.name, arg.value]));
  const calc = Object.fromEntries(calculator.args.map(arg => [arg.name, arg.value]));
  const taxSetting = calc.includesTax ?? 'auto';
  if (!['include', 'exclude', 'auto'].includes(taxSetting)) throw new Error('Invalid shipping tax setting');
  const result: ShippingCalculator = {
    flat: number(calc.rate), taxRate: Math.round(number(calc.taxRate) * 100),
    taxInclusive: taxSetting === 'include' || (taxSetting === 'auto' && pricesIncludeTax),
    subtotalBasis: 'discounted_with_tax',
  };
  if (!Number.isSafeInteger(result.flat)) throw new Error('Shipping rate must be integer cents');
  if (checker.code === 'custom-shipping-eligibility') {
    result.requireCountry = true;
    result.countries = (check.countries ?? '').split(',').map(code => code.trim().toUpperCase()).filter(Boolean);
    if (result.countries.some(code => !/^[A-Z]{2}$/.test(code))) throw new Error('Invalid country code');
    result.exclude = check.exclude === 'true';
    if (check.minAmount != null && check.minAmount !== '') result.min = Math.round(number(check.minAmount) * 100);
    if (check.maxAmount != null && check.maxAmount !== '') result.max = Math.round(number(check.maxAmount) * 100);
  } else if (checker.code === 'default-shipping-eligibility-checker') result.min = number(check.orderMinimum);
  else throw new Error('Unsupported shipping eligibility checker: ' + checker.code);
  return result;
}

export async function importSettings(ctx: ImportContext) {
  const { tx, q, storeId } = ctx;
  const [store] = await tx.select().from(s.store).where(eq(s.store.id, storeId)).limit(1);
  if (!store) throw new Error('Store is missing');
  const methods = await q(`SELECT m.*, t.name FROM shipping_method m JOIN shipping_method_translation t
    ON t."baseId"=m.id AND t."languageCode"='en' WHERE m."deletedAt" IS NULL ORDER BY m.id`);
  for (const method of methods) await tx.insert(s.shippingMethod).values({
    id: ctx.id('shipping-method', method.id), storeId, code: method.code, name: method.name,
    calculator: mapShipping(method.checker, method.calculator, store.taxInclusive), enabled: true,
  });
  if (!methods.length) throw new Error('No physical shipping methods in source');
  const rates = await q('SELECT * FROM tax_rate WHERE enabled=true ORDER BY id');
  // DD uses Vendure DefaultTaxZoneStrategy: channel default zone, not ship-to country.
  const [channel] = await q('SELECT "defaultTaxZoneId" FROM channel WHERE id=$1', [ctx.channelId]);
  const categories = await q('SELECT DISTINCT "taxCategoryId" FROM product_variant WHERE "deletedAt" IS NULL');
  const effective = categories.map(category => {
    const matches = rates.filter(rate => rate.zoneId === channel?.defaultTaxZoneId && rate.categoryId === category.taxCategoryId);
    if (matches.some(rate => rate.customerGroupId != null) || matches.length > 1) throw new Error('Unsupported source tax rule');
    const rate = Number(matches[0]?.value ?? 0);
    if (!Number.isFinite(rate) || rate < 0) throw new Error('Invalid source tax rate');
    return Math.round(rate * 100);
  });
  if (new Set(effective).size > 1) throw new Error('Product-specific tax rates require explicit mapping');
  await tx.update(s.store).set({ taxRate: effective[0] ?? 0 }).where(eq(s.store.id, storeId));
  const locations = await q('SELECT * FROM stock_location ORDER BY id');
  for (const [index, location] of locations.entries()) await tx.insert(s.location).values({
    id: ctx.id('location', location.id), storeId, code: 'vendure-' + location.id,
    name: location.name, isDefault: index === 0, enabled: true });
  const variantIds = new Set((await tx.select({ id: s.productVariant.id }).from(s.productVariant)).map(row => row.id));
  for (const level of await q('SELECT * FROM stock_level ORDER BY id')) {
    const variantId = ctx.id('variant', level.productVariantId);
    if (variantIds.has(variantId)) await tx.insert(s.stockLocation).values({
      storeId, variantId, locationId: ctx.id('location', level.stockLocationId), onHand: level.stockOnHand });
  }
}
