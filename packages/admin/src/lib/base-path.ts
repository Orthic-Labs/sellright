/**
 * Sub-path mount support (VITE_ADMIN_BASE_PATH, e.g. '/admin' when the SPA is
 * served under a storefront's origin). React Router's basename covers
 * <Link>/navigate(); full-page navigations (location.assign) and pathname
 * checks must go through these helpers or they escape the mount.
 */
export const ADMIN_BASE: string =
  (import.meta.env.VITE_ADMIN_BASE_PATH as string | undefined)?.replace(/\/+$/, '') || '';

/** App path ('/login') → browser URL path ('/admin/login' under a mount). */
export function appHref(path: string): string {
  return `${ADMIN_BASE}${path.startsWith('/') ? path : `/${path}`}`;
}

/** Current browser path with the mount prefix removed ('/admin/login' → '/login'). */
export function currentAppPath(pathname: string = location.pathname): string {
  if (!ADMIN_BASE) return pathname;
  if (pathname === ADMIN_BASE) return '/';
  return pathname.startsWith(`${ADMIN_BASE}/`) ? pathname.slice(ADMIN_BASE.length) : pathname;
}
