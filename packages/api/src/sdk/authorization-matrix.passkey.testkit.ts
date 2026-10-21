/** Passkeys (0108) — real-route enrolment helpers for the authorization matrix (design §8). Every ceremony goes
 *  through the actual Hono app with the software authenticator; nothing is written to the tables directly. */
import assert from 'node:assert/strict';
import { env } from '../env.js';
import { adminRelyingParty, adminUserHandle, customerUserHandle, relyingPartyFor } from '../auth/passkeys-core.js';
import { createSoftwareAuthenticator, type SoftwareAuthenticator } from './webauthn.testkit.js';

export type MatrixRequest = (url: string, init?: RequestInit, bindings?: Record<string, unknown>) => Promise<Response> | Response;

/** The nonce cookie the options response set (sr_pk_nonce), to be echoed on the matching verify. */
export function passkeyNonceCookie(response: Response): string {
  const m = /sr_pk_nonce=([^;]+)/.exec(response.headers.get('set-cookie') ?? '');
  assert.ok(m, 'options response sets the passkey nonce cookie');
  return `sr_pk_nonce=${m[1]}`;
}
async function expectStatus(r: Response, status: number, what: string): Promise<void> {
  if (r.status !== status) assert.fail(`${what}: expected ${status}, got ${r.status} ${await r.clone().text()}`);
}
const withCookie = (headers: Record<string, string>, cookie: string) => ({ ...headers, cookie: headers.cookie ? `${headers.cookie}; ${cookie}` : cookie });

export const adminAuthenticator = (): SoftwareAuthenticator => { const rp = adminRelyingParty(); return createSoftwareAuthenticator({ rpId: rp.rpId, origin: rp.origins[0]! }); };
export const shopAuthenticator = (): SoftwareAuthenticator => { const rp = relyingPartyFor(env.STOREFRONT_URL, 'matrix'); return createSoftwareAuthenticator({ rpId: rp.rpId, origin: rp.origins[0]! }); };

/** Native step-up through the real route (password + TOTP). */
export async function stepUp(request: MatrixRequest, headers: Record<string, string>, password: string, totp: string): Promise<void> {
  const r = await request('/v1/admin/step-up', { method: 'POST', headers, body: JSON.stringify({ password, totp }) });
  await expectStatus(r, 200, 'real step-up prerequisite');
}

/** Enrol a passkey for a stepped-up admin session through the real routes; returns the credential row id. */
export async function enrolAdminPasskey(request: MatrixRequest, headers: Record<string, string>, adminId: string, auth = adminAuthenticator(), label = 'matrix key'): Promise<{ id: string; auth: SoftwareAuthenticator }> {
  const options = await request('/v1/admin/passkeys/register/options', { method: 'POST', headers, body: '{}' });
  await expectStatus(options, 200, 'real admin register options prerequisite');
  const { options: o } = await options.json() as { options: { challenge: string } };
  const verify = await request('/v1/admin/passkeys/register/verify', { method: 'POST', headers: withCookie(headers, passkeyNonceCookie(options)),
    body: JSON.stringify({ response: auth.register({ challenge: o.challenge, userHandle: adminUserHandle(adminId) }), label }) });
  await expectStatus(verify, 200, 'real admin register verify prerequisite');
  const body = await verify.json() as { id: string };
  return { id: body.id, auth };
}

/** Discoverable admin login ceremony: options (nonce cookie) + assertion, ready to POST with any supplied headers. */
export async function adminLoginAssertion(request: MatrixRequest, auth: SoftwareAuthenticator, adminId: string, counter: number, storeSlug: string) {
  const options = await request('/v1/admin/passkeys/login/options', { method: 'POST', headers: { 'x-store-slug': storeSlug, 'content-type': 'application/json' }, body: '{}' });
  await expectStatus(options, 200, 'real admin login options prerequisite');
  const { options: o } = await options.json() as { options: { challenge: string } };
  return { cookie: passkeyNonceCookie(options), response: auth.authenticate({ challenge: o.challenge, counter, userHandle: adminUserHandle(adminId) }) };
}

/** Customer: password grant → register options → register verify through the real routes. */
export async function enrolCustomerPasskey(request: MatrixRequest, headers: Record<string, string>, password: string, storeId: string, customerId: string, auth = shopAuthenticator(), label = 'matrix key'): Promise<{ id: string; auth: SoftwareAuthenticator }> {
  const grant = await request('/v1/shop/auth/passkey/grant/password', { method: 'POST', headers, body: JSON.stringify({ password }) });
  await expectStatus(grant, 200, 'real customer grant prerequisite');
  const { grant: g } = await grant.json() as { grant: string };
  const options = await request('/v1/shop/auth/passkey/register/options', { method: 'POST', headers: withCookie(headers, passkeyNonceCookie(grant)), body: JSON.stringify({ grant: g }) });
  await expectStatus(options, 200, 'real customer register options prerequisite');
  const { options: o } = await options.json() as { options: { challenge: string } };
  const verify = await request('/v1/shop/auth/passkey/register/verify', { method: 'POST', headers: withCookie(headers, passkeyNonceCookie(options)),
    body: JSON.stringify({ response: auth.register({ challenge: o.challenge, userHandle: customerUserHandle(storeId, customerId) }), label }) });
  await expectStatus(verify, 200, 'real customer register verify prerequisite');
  const body = await verify.json() as { id: string };
  return { id: body.id, auth };
}

/** Customer management grant from the current password (real route); returns the grant and its nonce cookie. */
export async function customerPasswordGrant(request: MatrixRequest, headers: Record<string, string>, password: string): Promise<{ grant: string; cookie: string }> {
  const r = await request('/v1/shop/auth/passkey/grant/password', { method: 'POST', headers, body: JSON.stringify({ password }) });
  await expectStatus(r, 200, 'real customer grant prerequisite');
  return { grant: (await r.json() as { grant: string }).grant, cookie: passkeyNonceCookie(r) };
}

export async function customerLoginAssertion(request: MatrixRequest, auth: SoftwareAuthenticator, storeSlug: string, storeId: string, customerId: string, counter: number) {
  const options = await request('/v1/shop/auth/passkey/login/options', { method: 'POST', headers: { 'x-store-slug': storeSlug, 'content-type': 'application/json' }, body: '{}' });
  await expectStatus(options, 200, 'real customer login options prerequisite');
  const { options: o } = await options.json() as { options: { challenge: string } };
  return { cookie: passkeyNonceCookie(options), response: auth.authenticate({ challenge: o.challenge, counter, userHandle: customerUserHandle(storeId, customerId) }) };
}

export { withCookie };
