import { describe, expect, it } from 'vitest';
import { withPreset } from './seo';

describe('withPreset (FC-8)', () => {
	it('adds preset to a bare URL', () => {
		expect(withPreset('https://x.test/assets/a.jpg', 'xl')).toBe('https://x.test/assets/a.jpg?preset=xl');
	});
	it('keeps an existing query string and replaces an existing preset', () => {
		expect(withPreset('https://x.test/assets/a.jpg?v=2', 'xl')).toBe('https://x.test/assets/a.jpg?v=2&preset=xl');
		expect(withPreset('https://x.test/assets/a.jpg?preset=small&v=2', 'xl')).toBe('https://x.test/assets/a.jpg?preset=xl&v=2');
	});
	it('handles a relative URL', () => {
		expect(withPreset('/assets/a.jpg?v=2', 'xl')).toBe('/assets/a.jpg?v=2&preset=xl');
	});
});
