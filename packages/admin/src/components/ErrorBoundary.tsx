import { ErrorBoundary as ReactErrorBoundary, type FallbackProps } from 'react-error-boundary';
import type { ReactNode } from 'react';

/**
 * Shared fallback renderer for both root and section boundaries.
 * Optional `sectionLabel` produces a friendlier heading so a per-section
 * failure says "Orders failed to load" instead of the generic root copy.
 */
function DefaultFallback({ error, resetErrorBoundary, sectionLabel }: FallbackProps & { sectionLabel?: string }) {
  const heading = sectionLabel
    ? `${sectionLabel} failed to load.`
    : 'Something went wrong.';
  return (
    <div
      role="alert"
      aria-live="assertive"
      className="p-6 m-4 border border-red-200 bg-red-50 rounded-lg max-w-2xl"
      data-testid="error-boundary-fallback"
    >
      <h2 className="text-lg font-semibold text-red-800 mb-2">{heading}</h2>
      <p className="text-sm text-red-700 mb-4">
        The rest of the admin is still available. Reload this section to retry.
      </p>
      {import.meta.env.DEV && error instanceof Error && (
        <pre className="text-xs text-red-900 bg-red-100 p-2 rounded mb-4 overflow-auto max-h-40">
          {error.message}
          {error.stack ? `\n${error.stack.split('\n').slice(0, 5).join('\n')}` : ''}
        </pre>
      )}
      <button
        type="button"
        onClick={resetErrorBoundary}
        className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-500"
      >
        Reload
      </button>
    </div>
  );
}

/**
 * Reports the error to console (always) and to Sentry if the global is present.
 * Kept as a module-level helper so the section and root boundaries share one path.
 */
function reportError(error: unknown, info: { componentStack?: string | null }) {
  // eslint-disable-next-line no-console
  console.error('[ErrorBoundary]', error, info?.componentStack ?? '');
  const sentry = (globalThis as { Sentry?: { captureException: (e: unknown) => void } }).Sentry;
  if (sentry && typeof sentry.captureException === 'function') {
    try {
      sentry.captureException(error);
    } catch {
      // never let reporting crash the boundary itself
    }
  }
}

interface AppErrorBoundaryProps {
  children: ReactNode;
  /** Optional section label — when provided, the fallback says "X failed to load". */
  sectionLabel?: string;
}

/**
 * Single boundary implementation used at BOTH the root and per-section level.
 * Per-section usage isolates failures: an error in /admin/orders no longer
 * white-screens /admin/products because the boundary above only the broken
 * section tripped. The root boundary is the last-resort catch-all.
 */
export function AppErrorBoundary({ children, sectionLabel }: AppErrorBoundaryProps) {
  return (
    <ReactErrorBoundary
      FallbackComponent={(props) => <DefaultFallback {...props} sectionLabel={sectionLabel} />}
      onError={reportError}
    >
      {children}
    </ReactErrorBoundary>
  );
}