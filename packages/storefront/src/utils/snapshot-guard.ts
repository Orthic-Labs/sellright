// The snapshot guard's path test (pure: the express entry cannot be imported by tests, it starts a server). A build-time
// document (.html/.htm, optionally .gz/.br) is never a storefront URL: no route ends in .html, and a stale prerendered copy
// would carry build-time availability. The entry answers a document shape with a plain no-store 404 BEFORE the static
// handlers and the canonicalisation redirect, on the DECODED, normalised path (the static handler decodes before it opens a
// file, so `index%2ehtml` must be judged as `index.html`, not given a cacheable 301). Route-data shapes (q-data*, q-loader*)
// are what real client navigations request: they pass to the router (live data) and are never served from disk.
import { posix } from 'node:path';

const SNAPSHOT_DOCUMENT = /\.html?(\.(gz|br))?$/i;
const SNAPSHOT_DATA = /(^|\/)q-(data|loader)[^/]*\.json(\.(gz|br))?$/i;

export function snapshotShape(rawPath: string): 'document' | 'data' | null {
	let decoded: string;
	try {
		decoded = decodeURIComponent(rawPath);
	} catch {
		return 'document';
	}
	const normalized = posix.normalize(decoded.replace(/\\/g, '/')).replace(/\/+$/, '');
	if (SNAPSHOT_DOCUMENT.test(normalized)) return 'document';
	return SNAPSHOT_DATA.test(normalized) ? 'data' : null;
}
