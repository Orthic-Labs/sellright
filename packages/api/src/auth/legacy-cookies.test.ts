import { describe, expect, it } from 'vitest';
import { clearReadableLegacyToken, legacyCustomerToken, parseCookies } from './cookies.js';
import { customerToken } from './session.js';
const request = (headers: Record<string, string>) => ({ req: { header: (key: string) => headers[key] } });

describe('scoped legacy carrier transport', () => {
  it('reads readable bearer or unsigned transport wrapper only for bootstrap', () => {
    const wrapped = Buffer.from(JSON.stringify({ token: 'opaque_123', userId: 'untrusted' })).toString('base64');
    expect(legacyCustomerToken(request({ cookie: `__vendure_session=${encodeURIComponent(wrapped)}` }))).toBe('opaque_123');
    expect(legacyCustomerToken(request({ cookie: 'authToken=opaque_456' }))).toBe('opaque_456');
    expect(customerToken(request({ cookie: `authToken=opaque_456; __vendure_session=${wrapped}` }))).toBeNull();
  });
  it('rejects malformed cookie encoding & forged metadata without a token', () => {
    expect(parseCookies('bad=%FF; authToken=valid')).toEqual({ authToken: 'valid' });
    const wrapped = Buffer.from(JSON.stringify({ customerId: 'victim', authenticated: true })).toString('base64');
    expect(legacyCustomerToken(request({ cookie: `__vendure_session=${wrapped}` }))).toBeNull();
  });
  it('clears readable bearer without overwriting signed rollback cookie', () => {
    const writes: string[] = [];
    clearReadableLegacyToken({ ...request({ 'x-forwarded-proto': 'https' }), header: (_key, value) => { writes.push(value); } });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('authToken=;');
    expect(writes[0]).not.toContain('__vendure_session');
  });
});
