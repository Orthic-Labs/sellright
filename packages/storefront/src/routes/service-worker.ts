/*
 * WHAT IS THIS FILE?
 *
 * The service-worker.ts file is used to have state of the art prefetching.
 * https://qwik.builder.io/qwikcity/prefetching/overview/
 *
 * Qwik uses a service worker to speed up your site and reduce latency, ie, not used in the traditional way of offline.
 *
 * Custom caching strategy:
 * - Qwik module prefetching is built into the Qwik 2 core preloader (no service worker needed)
 * - Image caching (cache-first) — /assets/ images cached indefinitely
 *
 * NEVER cached here: documents, loader and action data, and API responses. They are sent `private, no-store`
 * and this worker only handles image requests.
 */
// Qwik 2 embeds its own preloader, so `setupServiceWorker()` is a no-op and the
// `@qwik.dev/router/service-worker` export was removed (2.0.0-beta.41). This
// file stays only for the custom image cache below; <ServiceWorkerRegister />
// in root.tsx still registers it.

// Keep this file a module (no imports left) so its top-level consts stay out of the global scope.
export {};

// v4: earlier versions matched any path containing /assets/ or /media/ and could store a document or loader data
// (for example a collection whose handle is "assets"). Bumping the name makes activation delete those entries.
const IMAGE_CACHE = 'storefront-images-v4';

// Cache-first for image assets only (safe to cache indefinitely — URLs change when images update). Cache Storage
// does not honour HTTP no-store, so this worker must never touch a document or data response: only requests the
// browser makes FOR AN IMAGE, under an asset path, are handled (CLAUDE.md "Stock Architecture (LOCKED)").
const isImageRequest = (request: { url: string; destination?: string }): boolean => {
	if (request.destination !== 'image') return false;
	try {
		const pathname = new URL(request.url).pathname;
		return pathname.includes('/assets/') || pathname.includes('/media/');
	} catch {
		return false;
	}
};

// Only an image body that the server did not mark no-store may be stored.
const isStorableImage = (response: { ok: boolean; headers: { get(name: string): string | null } }): boolean => {
	if (!response.ok) return false;
	if (!/^image\//i.test(response.headers.get('content-type') ?? '')) return false;
	return !/no-store/i.test(response.headers.get('cache-control') ?? '');
};

// In-flight fetch map to prevent duplicate concurrent requests for the same asset
const inFlightFetches = new Map<string, Promise<Response>>();

addEventListener('fetch', (event: any) => {
	if (event.request.method !== 'GET') return;

	const url = event.request.url;

	if (isImageRequest(event.request)) {
		event.respondWith(
			caches.open(IMAGE_CACHE).then(async (cache) => {
				const cached = await cache.match(event.request);
				if (cached) return cached;

				// Deduplicate concurrent fetches for the same URL
				let fetchPromise = inFlightFetches.get(url);
				if (!fetchPromise) {
					fetchPromise = fetch(event.request).then((response) => {
						if (isStorableImage(response)) {
							cache.put(event.request, response.clone());
						}
						return response;
					}).finally(() => {
						inFlightFetches.delete(url);
					});
					inFlightFetches.set(url, fetchPromise);
				}

				// Clone since the original response body may already be consumed
				return (await fetchPromise).clone();
			}).catch(() => fetch(event.request))
		);
		return;
	}
});

addEventListener('install', () => self.skipWaiting());

// Clean up old caches on activate
addEventListener('activate', (event: any) => {
	event.waitUntil(
		caches.keys().then((keys) => {
			return Promise.all(
				keys
					.filter((key) => key !== IMAGE_CACHE && key.startsWith('storefront-'))
					.map((key) => caches.delete(key))
			);
		}).then(() => self.clients.claim())
	);
});

declare const self: ServiceWorkerGlobalScope;
