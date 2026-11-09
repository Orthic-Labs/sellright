import { describe, expect, it } from 'vitest';
import { EDGE_VETO_HEADER, markMaintenanceResponse } from './route-cache-policy';

describe('markMaintenanceResponse (FC-2)', () => {
	it('sets 503, Retry-After 300, noindex and the edge veto', () => {
		const h = new Map<string, string>();
		let code = 200;
		markMaintenanceResponse({ headers: { set: (k, v) => void h.set(k, v) }, status: (c) => (code = c) });
		expect(code).toBe(503);
		expect(h.get('Retry-After')).toBe('300');
		expect(h.get('X-Robots-Tag')).toMatch(/noindex/);
		expect(h.get(EDGE_VETO_HEADER)).toBe('maintenance');
	});
});
