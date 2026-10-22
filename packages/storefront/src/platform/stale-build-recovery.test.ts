import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STALE_BUILD_PATTERN, STALE_BUILD_RECOVERY_SOURCE } from './stale-build-recovery';

const reload = vi.fn();
function install() {
	// Run the exact inline source against this window, with location.reload observed.
	new Function('location', STALE_BUILD_RECOVERY_SOURCE)({ reload });
}
const reject = (message: string) => window.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: new TypeError(message) }));

describe('stale build recovery', () => {
	beforeEach(() => {
		reload.mockReset();
		sessionStorage.clear();
	});

	it('matches the browsers\' failed dynamic import messages and the empty loader response, nothing else', () => {
		for (const m of [
			'Failed to fetch dynamically imported module: https://x/build/q-TXyFd3NC.js',
			'error loading dynamically imported module',
			'Importing a module script failed.',
			'Loader V5WRfBpfRHA returned empty response',
		])
			expect(STALE_BUILD_PATTERN.test(m), m).toBe(true);
		expect(STALE_BUILD_PATTERN.test('Cannot read properties of undefined')).toBe(false);
	});

	it('reloads once for a stale chunk, then not again within 30 s', () => {
		install();
		reject('Failed to fetch dynamically imported module: https://x/build/q-old.js');
		reject('Failed to fetch dynamically imported module: https://x/build/q-old.js');
		expect(reload).toHaveBeenCalledTimes(1);
	});

	it('ignores unrelated errors', () => {
		install();
		reject('Network request failed');
		window.dispatchEvent(new ErrorEvent('error', { message: 'x is not a function' }));
		expect(reload).not.toHaveBeenCalled();
	});

	it('handles Qwik qerror events', () => {
		install();
		document.dispatchEvent(new CustomEvent('qerror', { detail: { error: new Error('Loader AFbMpSU14QY returned empty response') } }));
		expect(reload).toHaveBeenCalledTimes(1);
	});
});
