/** URL-safe slug from a name. Shared by admin-created records (products,
 *  collections) and the migration importer's synthetic coupon-eligibility
 *  collections (import/catalog.ts). */
export function slugify(input: string): string {
  return input.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'item';
}
