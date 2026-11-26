/**
 * Query string for GET /v1/admin/inventory.
 * The API rejects an empty value for an optional filter ("invalid request"), so a filter that is off is left out.
 */
export function inventoryQuery(q: string, lowStock: boolean, page: number): string {
  const params = new URLSearchParams({ page: String(page), pageSize: '50' });
  if (q) params.set('q', q);
  if (lowStock) params.set('lowStock', '1');
  return params.toString();
}
