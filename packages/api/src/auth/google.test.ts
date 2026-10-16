import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { googleAuthoritativeForEmail, verifyGoogleIdToken } from './google.js';

const CLIENT = 'client-id-1';
const id = (email: string, over: Partial<{ emailVerified: boolean; hostedDomain: string | null }> = {}) =>
  ({ email, emailVerified: true, hostedDomain: null, ...over });

describe('googleAuthoritativeForEmail', () => {
  it('is authoritative for gmail.com and googlemail.com', () => {
    expect(googleAuthoritativeForEmail(id('a@gmail.com'))).toBe(true);
    expect(googleAuthoritativeForEmail(id('a@googlemail.com'))).toBe(true);
  });
  it('is authoritative for a Workspace address whose hd equals the email domain', () => {
    expect(googleAuthoritativeForEmail(id('a@corp.example', { hostedDomain: 'corp.example' }))).toBe(true);
  });
  it('is not authoritative for a non-Google-hosted address without hd', () => {
    expect(googleAuthoritativeForEmail(id('a@corp.example'))).toBe(false);
  });
  it('is not authoritative when hd names a different domain', () => {
    expect(googleAuthoritativeForEmail(id('a@corp.example', { hostedDomain: 'other.example' }))).toBe(false);
    expect(googleAuthoritativeForEmail(id('a@evil-gmail.com'))).toBe(false);
    expect(googleAuthoritativeForEmail(id('a@gmail.com.evil.example'))).toBe(false);
  });
  it('is never authoritative when the email is unverified', () => {
    expect(googleAuthoritativeForEmail(id('a@gmail.com', { emailVerified: false }))).toBe(false);
    expect(googleAuthoritativeForEmail(id('a@corp.example', { emailVerified: false, hostedDomain: 'corp.example' }))).toBe(false);
  });
});

describe('verifyGoogleIdToken', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const respond = (payload: Record<string, unknown>, status = 200) => {
    fetchMock = vi.fn(async () => new Response(JSON.stringify(payload), { status }));
    vi.stubGlobal('fetch', fetchMock);
  };
  beforeEach(() => respond({}));
  afterEach(() => vi.unstubAllGlobals());

  it('keeps the hd claim (lower-cased) and the verified flag', async () => {
    respond({ aud: CLIENT, sub: 's1', email: 'A@Corp.Example', email_verified: 'true', hd: 'Corp.Example' });
    expect(await verifyGoogleIdToken('x'.repeat(30), CLIENT)).toMatchObject({ sub: 's1', email: 'a@corp.example', emailVerified: true, hostedDomain: 'corp.example' });
  });
  it('reports no hosted domain for a consumer token', async () => {
    respond({ aud: CLIENT, sub: 's1', email: 'a@gmail.com', email_verified: true });
    expect((await verifyGoogleIdToken('x'.repeat(30), CLIENT))?.hostedDomain).toBeNull();
  });
  it('rejects a wrong audience and a non-200 response', async () => {
    respond({ aud: 'other', sub: 's1', email: 'a@gmail.com', email_verified: true });
    expect(await verifyGoogleIdToken('x'.repeat(30), CLIENT)).toBeNull();
    respond({}, 400);
    expect(await verifyGoogleIdToken('x'.repeat(30), CLIENT)).toBeNull();
  });
});
