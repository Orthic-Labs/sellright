import type { RequestEventBase } from '@qwik.dev/router';
import { timingSafeEqual } from 'node:crypto';

export const CACHE_ADMIN_TOKEN_HEADER = 'x-cache-admin-token';

/** Constant-time compare — same rule as the real API route
 * (packages/api/src/routes/admin-cache.ts). Different lengths short-circuit
 * before ever calling timingSafeEqual, which throws on mismatched buffer
 * lengths. */
function tokenMatches(expected: string, provided: string | null): boolean {
	if (!provided) return false;
	const a = Buffer.from(expected, 'utf8');
	const b = Buffer.from(provided, 'utf8');
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}

// Security audit 2026-11-02: /cache-admin/* is reachable from the public internet behind one shared header token, so
// wrong guesses are counted per client IP in a sliding window and a client over the budget is refused BEFORE the
// token is compared. In-process (the storefront is a single Node process per site); bounded so it cannot grow without limit.
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 10;
const MAX_TRACKED_IPS = 5000;
const failures = new Map<string, number[]>();

function recentFailures(ip: string, now: number): number[] {
	const kept = (failures.get(ip) ?? []).filter((t) => now - t < FAILURE_WINDOW_MS);
	if (kept.length) failures.set(ip, kept);
	else failures.delete(ip);
	return kept;
}

function recordFailure(ip: string, now: number): void {
	const kept = recentFailures(ip, now);
	kept.push(now);
	failures.set(ip, kept);
	if (failures.size > MAX_TRACKED_IPS) {
		for (const key of failures.keys()) {
			if (recentFailures(key, now).length === 0) failures.delete(key);
			if (failures.size <= MAX_TRACKED_IPS) break;
		}
		// still over (a flood of distinct IPs all inside the window): drop the oldest-inserted entries
		while (failures.size > MAX_TRACKED_IPS) {
			const oldest = failures.keys().next().value;
			if (oldest === undefined) break;
			failures.delete(oldest);
		}
	}
}

/** Test seam. */
export function _resetCacheAdminFailuresForTest(): void {
	failures.clear();
}

/**
 * `ip` is the caller's address as resolved by the deployment (utils/sellright-visitor-ip.server.ts resolveVisitorIp);
 * when it cannot be resolved all such callers share one bucket, which fails safe.
 */
export const requireCacheAdminToken = (request: RequestEventBase['request'], ip: string | undefined = undefined, now: number = Date.now()) => {
	const expectedToken = process.env.CACHE_ADMIN_TOKEN;
	const providedToken = request.headers.get(CACHE_ADMIN_TOKEN_HEADER);

	if (!expectedToken) {
		return { ok: false, status: 503, error: 'CACHE_ADMIN_TOKEN is not configured' };
	}

	const who = ip ?? 'unknown';
	if (recentFailures(who, now).length >= MAX_FAILURES) {
		return { ok: false, status: 429, error: 'Too many failed attempts' };
	}

	if (!tokenMatches(expectedToken, providedToken)) {
		recordFailure(who, now);
		return { ok: false, status: 403, error: 'Forbidden' };
	}

	return { ok: true, status: 200, error: '' };
};
