import { describe, expect, it } from 'vitest';
import { appKeyHeaderNames, deviceHeaderName, firstHeader, licenseHeaderName } from './app-headers.js';

// No env overrides here — these assert the DEFAULTS reproduce SellRight's
// historical literal header names exactly, so an unconfigured deployment's
// headers are unchanged by this seam.

describe('default header names (env unset)', () => {
  it('appKeyHeaderNames defaults to the historical x-viewright-app, x-app-key order', () => {
    expect(appKeyHeaderNames()).toEqual(['x-viewright-app', 'x-app-key']);
  });

  it('deviceHeaderName defaults to x-viewright-device', () => {
    expect(deviceHeaderName()).toBe('x-viewright-device');
  });

  it('licenseHeaderName defaults to x-viewright-license', () => {
    expect(licenseHeaderName()).toBe('x-viewright-license');
  });
});

describe('firstHeader', () => {
  function ctxWith(headers: Record<string, string>) {
    return { req: { header: (k: string) => headers[k] } };
  }

  it('returns the first present header value across the candidate list', () => {
    const c = ctxWith({ 'x-app-key': 'fallback', 'x-viewright-app': 'primary' });
    expect(firstHeader(c, appKeyHeaderNames())).toBe('primary');
  });

  it('falls through to a later header when an earlier one is absent', () => {
    const c = ctxWith({ 'x-app-key': 'fallback' });
    expect(firstHeader(c, appKeyHeaderNames())).toBe('fallback');
  });

  it('returns undefined when none of the candidates are present', () => {
    const c = ctxWith({});
    expect(firstHeader(c, appKeyHeaderNames())).toBeUndefined();
  });

  it('skips an empty-string header value', () => {
    const c = ctxWith({ 'x-viewright-app': '', 'x-app-key': 'fallback' });
    expect(firstHeader(c, appKeyHeaderNames())).toBe('fallback');
  });
});
