// Node 26 ships Web Storage globals: `sessionStorage` is a real in-memory object shared by every request in the process,
// and `localStorage` warns and reads undefined. Node 24 has neither. Browser-only code here feature-detects with
// `typeof sessionStorage !== 'undefined'`, so on the server it would now write one shopper's state where the next request
// reads it. Remove both globals before any app module evaluates, so SSR behaves the same on Node 24 and Node 26.
// Imported first by the server entries; a no-op on Node 24.
export function removeServerWebStorage(target: typeof globalThis = globalThis): void {
	for (const key of ['localStorage', 'sessionStorage'] as const) {
		const descriptor = Object.getOwnPropertyDescriptor(target, key);
		if (descriptor?.configurable) delete (target as Record<string, unknown>)[key];
	}
}

if (typeof window === 'undefined') removeServerWebStorage();
