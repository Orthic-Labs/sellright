/*
 * WHAT IS THIS FILE?
 *
 * The service-worker.ts file is used to have state of the art prefetching.
 * https://qwik.builder.io/qwikcity/prefetching/overview/
 *
 * Qwik uses a service worker to speed up your site and reduce latency, ie, not used in the traditional way of offline.
 *
 * Custom caching strategy:
 * - Qwik prefetching (built-in) — handles JS/CSS module prefetch
 * - Image caching (cache-first) — /assets/ images cached indefinitely
 *
 * NOT cached here (handled by in-memory caches + SSE invalidation instead):
 * - GraphQL API responses — productCache + queryDeduplication handle this with SSE invalidation
 * - Page HTML — routeLoader$ with staleWhileRevalidate HTTP headers handles this
 */
import { setupServiceWorker } from '@qwik.dev/router/service-worker';

// Qwik's built-in module prefetching
setupServiceWorker();

const IMAGE_CACHE = 'damned-designs-images-v3';

// Cache-first for image assets (safe to cache indefinitely — URLs change when images update)
const isImageRequest = (url: string): boolean => {
	try {
		const pathname = new URL(url).pathname;
		return pathname.includes('/assets/') || pathname.includes('/media/');
	} catch {
		return false;
	}
};

// In-flight fetch map to prevent duplicate concurrent requests for the same asset
const inFlightFetches = new Map<string, Promise<Response>>();

addEventListener('fetch', (event: any) => {
	if (event.request.method !== 'GET') return;

	const url = event.request.url;

	if (isImageRequest(url)) {
		event.respondWith(
			caches.open(IMAGE_CACHE).then(async (cache) => {
				const cached = await cache.match(event.request);
				if (cached) return cached;

				// Deduplicate concurrent fetches for the same URL
				let fetchPromise = inFlightFetches.get(url);
				if (!fetchPromise) {
					fetchPromise = fetch(event.request).then((response) => {
						if (response.ok) {
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
					.filter((key) => key !== IMAGE_CACHE && key.startsWith('damned-designs-'))
					.map((key) => caches.delete(key))
			);
		}).then(() => self.clients.claim())
	);
});

declare const self: ServiceWorkerGlobalScope;
