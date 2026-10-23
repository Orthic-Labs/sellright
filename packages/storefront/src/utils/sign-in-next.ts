/** Same-site path a sign-in may return to (`?next=`): a single-slash absolute path only — never a scheme, `//host` or backslash form. */
export function safeNextPath(raw: string | null | undefined): string | null {
	if (!raw || raw.length > 512 || !raw.startsWith('/') || raw.startsWith('//') || [...raw].some((ch) => ch === '\\' || ch.charCodeAt(0) < 32)) return null;
	return raw;
}

/** Where a successful sign-in goes: the validated `?next=` of the current URL, else the account home. Browser-only. */
export function signInDestination(search: string = typeof window === 'undefined' ? '' : window.location.search): string {
	return safeNextPath(new URLSearchParams(search).get('next')) ?? '/account';
}

/** Sign-in link that returns to `path` (a same-site path with optional query) afterwards. */
export const signInHref = (path: string): string => {
	const next = safeNextPath(path);
	return next ? `/sign-in?next=${encodeURIComponent(next)}` : '/sign-in';
};
