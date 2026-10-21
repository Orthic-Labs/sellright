/**
 * Passkeys (WebAuthn) — shared core. Design: docs/plans/2026-10-21-passkeys-and-federated-signin.md (revision 14).
 *
 * What lives here: relying-party identity (never from request headers), challenge/nonce/handle derivations, the
 * thin wrappers over @simplewebauthn/server with the engine's fixed options (resident key + user verification
 * required, attestation 'none', explicit origin array), the counter rule, and the nine rate-limit buckets of §8.
 * Everything that touches a table lives in passkeys-admin.ts / passkeys-shop.ts, which implement the contract
 * branches (§7) over the per-owner security epoch (§4).
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransport,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { env } from '../env.js';
import { rateLimitBackend } from './rate-limit-backend.js';

export const passkeysEnabled = (): boolean => env.PASSKEYS_ENABLED === '1';

/** Ceremony challenge rows and management grants live this long; a browser that takes longer starts again. */
export const CHALLENGE_TTL_SECONDS = 5 * 60;
/** Mailbox management proof (customer_token kind passkey_manage). */
export const MAILBOX_TTL_MINUTES = 15;
export const MAX_PASSKEYS_PER_OWNER = 10;
/** Same window as routes/admin-helpers.ts requireStepUp; re-read from the locked session row inside transactions. */
export const STEP_UP_WINDOW_SECONDS = 5 * 60;
export const LABEL_MAX = 64;
/** Body caps (§7): the credential id and each response field. */
export const CREDENTIAL_ID_MAX = 1024;
export const RESPONSE_FIELD_MAX = 16 * 1024;

export const sha256hex = (v: string | Uint8Array): string => createHash('sha256').update(v).digest('hex');
export const b64url = (buf: Uint8Array): string => Buffer.from(buf).toString('base64url');
/** Browser-binding nonce: set as an HttpOnly cookie on the options response, its sha256 stored on the challenge row. */
export const newNonce = (): string => randomBytes(32).toString('base64url');

export interface RelyingParty {
  rpId: string;
  rpName: string;
  /** Exactly the configured origin and its www/bare twin; nothing is matched by suffix. */
  origins: string[];
}

/** rpID = registrable host of the surface with a leading `www.` stripped; origins = the configured origin and its
 *  www/bare twin. Derived from configuration only (ADMIN_PUBLIC_URL / STOREFRONT_URL / the store's storefront URL). */
export function relyingPartyFor(surfaceUrl: string, rpName: string): RelyingParty {
  const u = new URL(surfaceUrl);
  const host = u.hostname.toLowerCase();
  const bare = host.startsWith('www.') ? host.slice(4) : host;
  const port = u.port ? `:${u.port}` : '';
  const single = bare === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(bare) || bare.includes(':');
  const origins = single ? [`${u.protocol}//${host}${port}`] : [`${u.protocol}//${bare}${port}`, `${u.protocol}//www.${bare}${port}`];
  return { rpId: bare, rpName, origins };
}

export const adminRelyingParty = (): RelyingParty => relyingPartyFor(env.ADMIN_PUBLIC_URL ?? env.STOREFRONT_URL, 'SellRight Admin');

/** Opaque, stable user handles (§7): the authenticator returns them on discoverable login and they must match. */
export const adminUserHandle = (adminId: string): Uint8Array => new Uint8Array(createHash('sha256').update(`sellright-admin:${adminId}`).digest());
export const customerUserHandle = (storeId: string, customerId: string): Uint8Array =>
  new Uint8Array(createHash('sha256').update(`sellright-customer:${storeId}:${customerId}`).digest());

export interface StoredCredential {
  credentialId: string;
  publicKey: Buffer;
  counter: number;
  transports: string[];
}

export async function registrationOptions(i: {
  rp: RelyingParty; userHandle: Uint8Array; userName: string; exclude: ReadonlyArray<Pick<StoredCredential, 'credentialId' | 'transports'>>;
}): Promise<PublicKeyCredentialCreationOptionsJSON> {
  return generateRegistrationOptions({
    rpName: i.rp.rpName,
    rpID: i.rp.rpId,
    userName: i.userName,
    userID: new Uint8Array(i.userHandle),
    attestationType: 'none',
    excludeCredentials: i.exclude.map((e) => ({ id: e.credentialId, transports: e.transports as AuthenticatorTransport[] })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  });
}

export async function authenticationOptions(i: {
  rp: RelyingParty; allow: ReadonlyArray<Pick<StoredCredential, 'credentialId' | 'transports'>>;
}): Promise<PublicKeyCredentialRequestOptionsJSON> {
  return generateAuthenticationOptions({
    rpID: i.rp.rpId,
    userVerification: 'required',
    allowCredentials: i.allow.map((e) => ({ id: e.credentialId, transports: e.transports as AuthenticatorTransport[] })),
  });
}

/** The challenge the browser actually signed (base64url, as the options carried it), or null when the client data
 *  is not what a WebAuthn client produces. Its sha256 is the challenge row key. */
export function clientDataChallenge(response: { response: { clientDataJSON: string } }): string | null {
  try {
    const raw = response.response.clientDataJSON;
    if (typeof raw !== 'string' || raw.length > RESPONSE_FIELD_MAX) return null;
    const j = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { challenge?: unknown };
    return typeof j.challenge === 'string' && j.challenge.length >= 16 && j.challenge.length <= 256 ? j.challenge : null;
  } catch {
    return null;
  }
}

export interface VerifiedRegistration {
  credentialId: string;
  publicKey: Buffer;
  counter: number;
  transports: string[];
  deviceType: 'singleDevice' | 'multiDevice';
  backedUp: boolean;
  aaguid: string | null;
}

export async function verifyRegistration(i: { rp: RelyingParty; response: RegistrationResponseJSON; expectedChallenge: string }): Promise<VerifiedRegistration | null> {
  try {
    const r = await verifyRegistrationResponse({
      response: i.response,
      expectedChallenge: i.expectedChallenge,
      expectedOrigin: i.rp.origins,
      expectedRPID: i.rp.rpId,
      requireUserVerification: true,
    });
    if (!r.verified || !r.registrationInfo) return null;
    const info = r.registrationInfo;
    return {
      credentialId: info.credential.id,
      publicKey: Buffer.from(info.credential.publicKey),
      counter: info.credential.counter,
      transports: info.credential.transports ?? [],
      deviceType: info.credentialDeviceType,
      backedUp: info.credentialBackedUp,
      aaguid: info.aaguid ?? null,
    };
  } catch {
    return null;
  }
}

export async function verifyAuthentication(i: {
  rp: RelyingParty; response: AuthenticationResponseJSON; expectedChallenge: string; credential: StoredCredential;
}): Promise<{ newCounter: number } | null> {
  try {
    const r = await verifyAuthenticationResponse({
      response: i.response,
      expectedChallenge: i.expectedChallenge,
      expectedOrigin: i.rp.origins,
      expectedRPID: i.rp.rpId,
      requireUserVerification: true,
      credential: {
        id: i.credential.credentialId,
        publicKey: new Uint8Array(i.credential.publicKey),
        counter: i.credential.counter,
        transports: i.credential.transports as AuthenticatorTransport[],
      },
    });
    if (!r.verified) return null;
    return { newCounter: r.authenticationInfo.newCounter };
  } catch {
    return null;
  }
}

/** Counter rule (§7): strictly increasing, or an authenticator that never counts (stored 0 and new 0). */
export const counterAcceptable = (stored: number, next: number): boolean => next > stored || (stored === 0 && next === 0);

/** Decoded userHandle of an assertion (base64url) or null. */
export const assertionUserHandle = (response: AuthenticationResponseJSON): string | null =>
  typeof response.response.userHandle === 'string' ? response.response.userHandle : null;

// ── Rate limits (§8) — attempt-counted, consumed BEFORE any transaction (the limiter uses its own connection) ──
const MIN15 = 15 * 60 * 1000;
const H1 = 60 * 60 * 1000;
const consume = (bucket: string, key: string, windowMs: number, max: number): Promise<number> => rateLimitBackend().consume(bucket, key, windowMs, max);

/** Each returns retry-after seconds (0 = admitted and counted). */
export const budgets = {
  adminOptions: (ip: string) => consume('pk-admin-options', ip, MIN15, 60),
  adminVerify: (ip: string) => consume('pk-admin-verify', ip, MIN15, 30),
  adminCredential: (credentialId: string) => consume('pk-admin-cred', sha256hex(credentialId), H1, 10),
  adminSession: (sessionHash: string) => consume('pk-admin-session', sessionHash, MIN15, 20),
  shopOptions: (storeId: string, ip: string) => consume('pk-shop-options', `${storeId}|${ip}`, MIN15, 60),
  shopVerify: (storeId: string, ip: string) => consume('pk-shop-verify', `${storeId}|${ip}`, MIN15, 30),
  shopCredential: (storeId: string, credentialId: string) => consume('pk-shop-cred', `${storeId}|${sha256hex(credentialId)}`, H1, 10),
  shopSession: (sessionHash: string) => consume('pk-shop-session', sessionHash, MIN15, 20),
  shopMail: (storeId: string, customerId: string) => consume('pk-shop-mail', `${storeId}|${customerId}`, H1, 3),
};

/** Public row shape for list/registration responses — never key material. */
export interface PasskeySummary {
  id: string;
  label: string;
  deviceType: string;
  backedUp: boolean;
  createdAt: Date;
  lastUsedAt: Date | null;
}
