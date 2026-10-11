/**
 * Stale sr_cart recovery: the 30-day cookie can outlive the server-side
 * cart (server TTL/eviction). A 404 on a token-bearing call means the token
 * is stale — the caller drops it, mints a fresh cart seeded from local
 * lines, and retries the op exactly once. Same retry-once shape as the
 * 409 revision conflict path, extracted so it's unit-testable without a
 * DOM/cookie environment.
 */
export async function withStaleCartRetry<T>(opts: {
	/** Attempt the op; re-evaluates the cart token on each call. */
	run: () => Promise<T>;
	/** True when the thrown error is the API's cart-not-found (404). */
	isStaleCart: (error: unknown) => boolean;
	/** Clear the stale token and create a fresh cart seeded from local lines. */
	recreateCart: () => Promise<void>;
}): Promise<T> {
	try {
		return await opts.run();
	} catch (error) {
		if (!opts.isStaleCart(error)) throw error;
		await opts.recreateCart();
		return opts.run();
	}
}
