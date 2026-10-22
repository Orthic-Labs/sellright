// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { removeServerWebStorage } from './no-server-web-storage.server';

describe('removeServerWebStorage', () => {
	it('removes configurable storage globals (Node 26 shape) and leaves nothing behind', () => {
		const target = {} as typeof globalThis;
		Object.defineProperty(target, 'sessionStorage', { value: { setItem() {} }, configurable: true });
		Object.defineProperty(target, 'localStorage', { get: () => undefined, configurable: true });
		removeServerWebStorage(target);
		expect('sessionStorage' in target).toBe(false);
		expect('localStorage' in target).toBe(false);
	});

	it('is a no-op when the globals are absent (Node 24 shape)', () => {
		const target = {} as typeof globalThis;
		expect(() => removeServerWebStorage(target)).not.toThrow();
	});

	it('leaves the server process without storage globals once imported', () => {
		expect(typeof (globalThis as { sessionStorage?: unknown }).sessionStorage).toBe('undefined');
	});
});
