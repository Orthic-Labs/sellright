/**
 * Full-page navigations (`location.assign`) bypass React Router's
 * `basename`, so an admin mounted under a sub-path (VITE_ADMIN_BASE_PATH,
 * e.g. `/admin` on a storefront's own domain) must prefix them itself —
 * otherwise a logout or an expired session lands on the storefront's
 * `/login` 404 instead of the admin's login screen.
 */
export function adminBasePath(): string {
  const raw = (import.meta.env.VITE_ADMIN_BASE_PATH as string | undefined) ?? '';
  return raw.replace(/\/+$/, '');
}

/** An in-app path (`/login`, `/orders/X`) as a full URL path under the mount. */
export function adminHref(path: string): string {
  return `${adminBasePath()}${path.startsWith('/') ? path : `/${path}`}`;
}

/** The in-app path of the current page (mount prefix stripped). */
export function currentAdminPath(): string {
  const base = adminBasePath();
  const p = location.pathname;
  return base && (p === base || p.startsWith(`${base}/`)) ? p.slice(base.length) || '/' : p;
}

/** Screens that render without a session: the 401 from the initial /me probe must not bounce the visitor to /login. */
export function isPublicAdminPath(): boolean {
  const p = currentAdminPath();
  return p === '/login' || p === '/accept-invite';
}
