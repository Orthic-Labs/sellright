/**
 * SR-CLIENT-1: unit coverage for the structured error envelope
 * (`{ error: { code, message, param?, requestId? } }`) that replaced the old
 * bare `{ error: string }` shape app-wide. No DB needed — pure functions
 * plus a couple of full-app smoke checks via `app.request()`.
 */
import { describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { requestIdMiddleware } from './request-id.js';
import { apiErrorSchema, errJson, errorEnvelope, slugifyCode } from './api-error.js';

describe('slugifyCode', () => {
  it('upper-snake-cases a plain message', () => {
    expect(slugifyCode('order not found')).toBe('ORDER_NOT_FOUND');
  });

  it('strips punctuation but keeps underscores and digits', () => {
    expect(slugifyCode("cart is empty, invalid, or already checked out")).toBe('CART_IS_EMPTY_INVALID_OR_ALREADY_CHECKED_OUT');
    expect(slugifyCode('step_up_required')).toBe('STEP_UP_REQUIRED');
    expect(slugifyCode('rate limited (429)')).toBe('RATE_LIMITED_429');
  });

  it('collapses runs of whitespace to a single underscore', () => {
    expect(slugifyCode('too   many    spaces')).toBe('TOO_MANY_SPACES');
  });

  it('caps at 64 chars so an interpolated message never produces an unbounded code', () => {
    const long = 'x'.repeat(100);
    expect(slugifyCode(long).length).toBe(64);
  });

  it('falls back to ERROR for a message with nothing sluggable', () => {
    expect(slugifyCode('★★★')).toBe('ERROR');
  });

  it('is deterministic for the same input', () => {
    expect(slugifyCode('same message')).toBe(slugifyCode('same message'));
  });
});

/** Minimal app carrying just the request-id middleware, so `errorEnvelope`/
 *  `errJson`'s requestId lookup has something real to read from `c.var`. */
function appWithRoute(handler: (c: import('hono').Context) => Response | Promise<Response>) {
  const app = new OpenAPIHono();
  app.use('*', requestIdMiddleware());
  app.get('/t', handler as never);
  return app;
}

describe('errorEnvelope', () => {
  it('builds { error: { code, message } } with no extra fields', async () => {
    const app = appWithRoute((c) => c.json(errorEnvelope(c, 'NOT_FOUND', 'not found')));
    const res = await app.request('/t');
    const body = await res.json();
    expect(body).toEqual({
      error: { code: 'NOT_FOUND', message: 'not found', requestId: expect.any(String) },
    });
  });

  it('includes param when given', async () => {
    const app = appWithRoute((c) => c.json(errorEnvelope(c, 'INVALID', 'bad field', { param: 'email' })));
    const res = await app.request('/t');
    const body = (await res.json()) as { error: { param?: string } };
    expect(body.error.param).toBe('email');
  });

  it('spreads extra fields as TOP-LEVEL siblings of error, never nested inside it', async () => {
    const app = appWithRoute((c) => c.json(errorEnvelope(c, 'OUT_OF_STOCK', 'unavailable', { extra: { skus: ['A', 'B'] } })));
    const res = await app.request('/t');
    const body = (await res.json()) as { error: unknown; skus: string[] };
    expect(body.skus).toEqual(['A', 'B']);
    expect(body.error).not.toHaveProperty('skus');
  });

  it('carries the SAME requestId the request-id middleware attaches to the response header', async () => {
    const app = appWithRoute((c) => c.json(errorEnvelope(c, 'X', 'x')));
    const res = await app.request('/t');
    const body = (await res.json()) as { error: { requestId?: string } };
    expect(body.error.requestId).toBe(res.headers.get('x-request-id'));
  });
});

describe('errJson', () => {
  it('sends the envelope at the given status code', async () => {
    const app = appWithRoute((c) => errJson(c, 404, 'NOT_FOUND', 'nope'));
    const res = await app.request('/t');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error).toMatchObject({ code: 'NOT_FOUND', message: 'nope' });
  });

  it('round-trips extra fields alongside the envelope at a non-2xx status', async () => {
    const app = appWithRoute((c) => errJson(c, 409, 'CART_STALE', 'cart changed', { extra: { revision: 3 } }));
    const res = await app.request('/t');
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: unknown; revision: number };
    expect(body.revision).toBe(3);
  });
});

describe('apiErrorSchema', () => {
  it('validates a well-formed envelope', () => {
    const schema = apiErrorSchema();
    const parsed = schema.safeParse({ error: { code: 'X', message: 'y' } });
    expect(parsed.success).toBe(true);
  });

  it('accepts optional param/requestId', () => {
    const schema = apiErrorSchema();
    const parsed = schema.safeParse({ error: { code: 'X', message: 'y', param: 'p', requestId: 'r' } });
    expect(parsed.success).toBe(true);
  });

  it('rejects the OLD bare-string error shape', () => {
    const schema = apiErrorSchema();
    const parsed = schema.safeParse({ error: 'plain string' });
    expect(parsed.success).toBe(false);
  });

  it('rejects a missing code or message', () => {
    const schema = apiErrorSchema();
    expect(schema.safeParse({ error: { message: 'y' } }).success).toBe(false);
    expect(schema.safeParse({ error: { code: 'X' } }).success).toBe(false);
  });
});
