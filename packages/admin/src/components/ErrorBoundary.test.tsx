// @vitest-environment jsdom
// This file exercises a React class error boundary, which only catches render
// errors during the commit phase (i.e. in a real DOM host). SSR via
// renderToString does NOT trigger the catch path — verified empirically. So
// we mount via react-dom/client into a detached container and assert against
// the rendered DOM. No testing-library needed for 4 assertions.
import { describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { StrictMode, type ReactNode } from 'react';
import { AppErrorBoundary } from './ErrorBoundary.js';

/**
 * Component that throws on render — used to simulate a render error inside
 * a section so we can assert the boundary catches it without white-screening.
 */
function ThrowingChild(): ReactNode {
  throw new Error('boom — intentional render error');
}

function SafeChild(): ReactNode {
  return <span data-testid="safe-child">ok</span>;
}

function mountIntoDocument(node: ReactNode): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return { container, root };
}

function unmount(container: HTMLDivElement, root: Root) {
  act(() => {
    root.unmount();
  });
  container.remove();
}

describe('AppErrorBoundary', () => {
  it('renders children when no error is thrown', () => {
    const { container, root } = mountIntoDocument(
      <StrictMode>
        <AppErrorBoundary>
          <SafeChild />
        </AppErrorBoundary>
      </StrictMode>,
    );
    try {
      expect(container.querySelector('[data-testid="safe-child"]')?.textContent).toBe('ok');
      expect(container.querySelector('[data-testid="error-boundary-fallback"]')).toBeNull();
    } finally {
      unmount(container, root);
    }
  });

  it('catches a render error and renders the fallback UI', () => {
    // Suppress react's expected "uncaught" log so test output stays clean.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { container, root } = mountIntoDocument(
      <AppErrorBoundary>
        <ThrowingChild />
      </AppErrorBoundary>,
    );
    try {
      const fb = container.querySelector('[data-testid="error-boundary-fallback"]');
      expect(fb).not.toBeNull();
      expect(fb?.textContent).toContain('Something went wrong.');
      expect(fb?.textContent).toContain('Reload');
      expect(container.querySelector('button')?.textContent?.trim()).toBe('Reload');
    } finally {
      unmount(container, root);
      errSpy.mockRestore();
    }
  });

  it('uses a section-specific heading when sectionLabel is provided', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { container, root } = mountIntoDocument(
      <AppErrorBoundary sectionLabel="Orders">
        <ThrowingChild />
      </AppErrorBoundary>,
    );
    try {
      const fb = container.querySelector('[data-testid="error-boundary-fallback"]');
      expect(fb?.textContent).toContain('Orders failed to load.');
      expect(fb?.textContent).not.toContain('Something went wrong.');
    } finally {
      unmount(container, root);
      errSpy.mockRestore();
    }
  });

  it('logs the error to console when it fires', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { container, root } = mountIntoDocument(
      <AppErrorBoundary>
        <ThrowingChild />
      </AppErrorBoundary>,
    );
    try {
      // React itself logs the error twice (componentDidCatch + act warnings).
      // Our reporter logs once. Total >= 1.
      expect(errSpy).toHaveBeenCalled();
      const messages = errSpy.mock.calls.map((args) => String(args[0] ?? ''));
      expect(messages.some((m) => m.includes('[ErrorBoundary]'))).toBe(true);
      expect(container.querySelector('[data-testid="error-boundary-fallback"]')).not.toBeNull();
    } finally {
      unmount(container, root);
      errSpy.mockRestore();
    }
  });
});