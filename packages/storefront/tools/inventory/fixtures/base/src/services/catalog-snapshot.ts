export const SNAPSHOT_MAX_AGE_MS = 300000;
export class CatalogSnapshotError extends Error {}
export async function readCatalogSnapshot(name: string): Promise<unknown> {
	if (!name) throw new CatalogSnapshotError('missing name');
	return JSON.parse(name);
}
