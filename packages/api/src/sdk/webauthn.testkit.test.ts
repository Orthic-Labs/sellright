import { describe, expect, it } from 'vitest';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { createSoftwareAuthenticator, encodeCbor } from './webauthn.testkit.js';

const RP = 'example.test';
const ORIGIN = 'https://example.test';

async function regOptions() {
  return generateRegistrationOptions({
    rpName: 't',
    rpID: RP,
    userName: 'u',
    userID: new Uint8Array(32),
    attestationType: 'none',
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  });
}

const verifyReg = (response: any, challenge: string) =>
  verifyRegistrationResponse({
    response,
    expectedChallenge: challenge,
    expectedOrigin: ORIGIN,
    expectedRPID: RP,
    requireUserVerification: true,
  });

async function enrolled() {
  const auth = createSoftwareAuthenticator({ rpId: RP, origin: ORIGIN });
  const options = await regOptions();
  const v = await verifyReg(auth.register({ challenge: options.challenge }), options.challenge);
  expect(v.verified).toBe(true);
  return { auth, credential: v.registrationInfo!.credential };
}

async function verifyAuth(auth: ReturnType<typeof createSoftwareAuthenticator>, mutate?: (r: any) => void, input: any = {}) {
  const options = await generateAuthenticationOptions({ rpID: RP, userVerification: 'required' });
  const response: any = auth.authenticate({ challenge: options.challenge, counter: 1, ...input });
  mutate?.(response);
  return verifyAuthenticationResponse({
    response,
    expectedChallenge: options.challenge,
    expectedOrigin: ORIGIN,
    expectedRPID: RP,
    requireUserVerification: true,
    credential: { id: auth.credentialId, publicKey: auth.publicKeyCose as Uint8Array<ArrayBuffer>, counter: 0, transports: ['internal'] },
  });
}

const failed = async (p: Promise<{ verified: boolean }>) => {
  try {
    return !(await p).verified;
  } catch {
    return true;
  }
};

describe('webauthn testkit', () => {
  it('encodes CBOR basics', () => {
    expect(Buffer.from(encodeCbor(new Map<number | string, any>([[1, 2], [-1, -7]]))).toString('hex')).toBe('a201022026');
  });

  it('registration round trip', async () => {
    const auth = createSoftwareAuthenticator({ rpId: RP, origin: ORIGIN });
    const options = await regOptions();
    const v = await verifyReg(auth.register({ challenge: options.challenge, userHandle: options.user.id }), options.challenge);
    expect(v.verified).toBe(true);
    expect(v.registrationInfo!.credential.id).toBe(auth.credentialId);
    expect(v.registrationInfo!.credential.counter).toBe(0);
    expect(v.registrationInfo!.credentialDeviceType).toBe('multiDevice');
    expect(v.registrationInfo!.credentialBackedUp).toBe(true);
  });

  it('authentication round trip', async () => {
    const { auth } = await enrolled();
    const v = await verifyAuth(auth);
    expect(v.verified).toBe(true);
    expect(v.authenticationInfo.newCounter).toBe(1);
  });

  describe('negative cases', () => {
    it('registration: wrong origin', async () => {
      const auth = createSoftwareAuthenticator({ rpId: RP, origin: ORIGIN });
      const o = await regOptions();
      expect(await failed(verifyReg(auth.register({ challenge: o.challenge, origin: 'https://evil.test' }), o.challenge))).toBe(true);
    });
    it('registration: wrong rpId', async () => {
      const auth = createSoftwareAuthenticator({ rpId: RP, origin: ORIGIN });
      const o = await regOptions();
      expect(await failed(verifyReg(auth.register({ challenge: o.challenge, rpId: 'evil.test' }), o.challenge))).toBe(true);
    });
    it('registration: UV off', async () => {
      const auth = createSoftwareAuthenticator({ rpId: RP, origin: ORIGIN });
      const o = await regOptions();
      expect(await failed(verifyReg(auth.register({ challenge: o.challenge, flags: { uv: false } }), o.challenge))).toBe(true);
    });
    it('registration: UP off', async () => {
      const auth = createSoftwareAuthenticator({ rpId: RP, origin: ORIGIN });
      const o = await regOptions();
      expect(await failed(verifyReg(auth.register({ challenge: o.challenge, flags: { up: false } }), o.challenge))).toBe(true);
    });
    it('authentication: wrong origin', async () => {
      const { auth } = await enrolled();
      expect(await failed(verifyAuth(auth, undefined, { origin: 'https://evil.test' }))).toBe(true);
    });
    it('authentication: wrong rpId', async () => {
      const { auth } = await enrolled();
      expect(await failed(verifyAuth(auth, undefined, { rpId: 'evil.test' }))).toBe(true);
    });
    it('authentication: UV off', async () => {
      const { auth } = await enrolled();
      expect(await failed(verifyAuth(auth, undefined, { flags: { uv: false } }))).toBe(true);
    });
    it('authentication: UP off', async () => {
      const { auth } = await enrolled();
      expect(await failed(verifyAuth(auth, undefined, { flags: { up: false } }))).toBe(true);
    });
    it('authentication: tampered signature', async () => {
      const { auth } = await enrolled();
      const flip = (r: any) => {
        const sig = Buffer.from(r.response.signature, 'base64url');
        sig[sig.length - 1] = (sig[sig.length - 1] ?? 0) ^ 0xff;
        r.response.signature = sig.toString('base64url');
      };
      expect(await failed(verifyAuth(auth, flip))).toBe(true);
    });
  });
});
