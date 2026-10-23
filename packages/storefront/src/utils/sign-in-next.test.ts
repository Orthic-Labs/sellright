import { describe, expect, it } from 'vitest';
import { safeNextPath, signInDestination, signInHref } from './sign-in-next';

describe('sign-in return path', () => {
	it('accepts only same-site absolute paths', () => {
		expect(safeNextPath('/products/x/?review=1')).toBe('/products/x/?review=1');
		for (const bad of ['//evil.com', 'https://evil.com', '/\\evil.com', 'products/x', '', null, undefined, '/a\nb']) expect(safeNextPath(bad as string)).toBeNull();
	});
	it('destination falls back to /account', () => {
		expect(signInDestination('?next=%2Fproducts%2Fx%2F%3Freview%3D1')).toBe('/products/x/?review=1');
		expect(signInDestination('?next=https%3A%2F%2Fevil.com')).toBe('/account');
		expect(signInDestination('')).toBe('/account');
	});
	it('builds an encoded sign-in link', () => {
		expect(signInHref('/products/x/?review=1')).toBe('/sign-in?next=%2Fproducts%2Fx%2F%3Freview%3D1');
		expect(signInHref('//evil.com')).toBe('/sign-in');
	});
});
