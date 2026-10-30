// V21: collection pages past the first 60 products (`?page=N`). Pure; the route and its tests import it.
/** V21: products per collection page; the API caps pageSize at 100. Pages past the first are `?page=N`. */
export const COLLECTION_PAGE_SIZE = 60;
const MAX_PAGE = 10_000;

/** `?page=` as a page number: absent = 1; anything malformed or out of range = null (404, never a silent page 1). */
export function collectionPageParam(raw: string | null): number | null {
  if (raw === null) return 1;
  if (!/^[1-9]\d{0,4}$/.test(raw)) return null;
  const n = Number(raw);
  return n <= MAX_PAGE ? n : null;
}

export const collectionPageCount = (total: number, pageSize: number) => Math.max(1, Math.ceil(total / pageSize));
