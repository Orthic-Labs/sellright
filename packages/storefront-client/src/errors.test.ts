import { describe, expect, it } from 'vitest';
import { ApiError, unknownApiError } from './errors.js';

describe('ApiError', () => {
  it('exposes status/code/message/param/requestId from a well-formed envelope', () => {
    const err = new ApiError(400, { error: { code: 'INVALID', message: 'bad field', param: 'email', requestId: 'r1' } });
    expect(err.status).toBe(400);
    expect(err.code).toBe('INVALID');
    expect(err.message).toBe('bad field');
    expect(err.param).toBe('email');
    expect(err.requestId).toBe('r1');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ApiError');
  });

  it('keeps sibling fields (cart-conflict revision/cart, pay state) on .body', () => {
    const err = new ApiError(409, {
      error: { code: 'CART_STALE', message: 'cart changed' },
      code: 'stale',
      revision: 4,
      cart: { token: 't' },
    });
    expect(err.body.revision).toBe(4);
    expect(err.body.code).toBe('stale'); // business code, distinct from error.code
    expect(err.body.cart).toEqual({ token: 't' });
  });

  it('isEnvelope distinguishes the structured shape from arbitrary JSON', () => {
    expect(ApiError.isEnvelope({ error: { code: 'X', message: 'y' } })).toBe(true);
    expect(ApiError.isEnvelope({ error: 'plain string' })).toBe(false);
    expect(ApiError.isEnvelope({ error: { code: 'X' } })).toBe(false); // missing message
    expect(ApiError.isEnvelope(null)).toBe(false);
    expect(ApiError.isEnvelope('not an object')).toBe(false);
  });
});

describe('unknownApiError', () => {
  it('passes through a well-formed envelope unchanged', () => {
    const err = unknownApiError(404, { error: { code: 'NOT_FOUND', message: 'nope' } });
    expect(err.code).toBe('NOT_FOUND');
    expect(err.message).toBe('nope');
  });

  it('falls back to a generic UNKNOWN_ERROR for a non-envelope body (proxy error page)', () => {
    const err = unknownApiError(502, '<html>Bad Gateway</html>');
    expect(err.status).toBe(502);
    expect(err.code).toBe('UNKNOWN_ERROR');
  });

  it('falls back to a generic UNKNOWN_ERROR for an undefined/empty body', () => {
    const err = unknownApiError(500, undefined);
    expect(err.code).toBe('UNKNOWN_ERROR');
  });
});
