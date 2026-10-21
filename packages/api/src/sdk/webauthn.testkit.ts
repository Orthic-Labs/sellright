/**
 * Software WebAuthn authenticator for tests. ES256, "none" attestation.
 * Self-contained: node:crypto only, minimal CBOR encoder.
 */
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';

export type CborValue = number | string | Uint8Array | CborValue[] | Map<number | string, CborValue>;

function head(major: number, n: number): Uint8Array {
  const m = major << 5;
  if (n < 24) return Uint8Array.of(m | n);
  if (n < 0x100) return Uint8Array.of(m | 24, n);
  if (n < 0x10000) return Uint8Array.of(m | 25, n >> 8, n & 0xff);
  return Uint8Array.of(m | 26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
}

export function encodeCbor(v: CborValue): Uint8Array {
  const parts: Uint8Array[] = [];
  if (typeof v === 'number') {
    parts.push(v >= 0 ? head(0, v) : head(1, -1 - v));
  } else if (typeof v === 'string') {
    const b = Buffer.from(v, 'utf8');
    parts.push(head(3, b.length), b);
  } else if (v instanceof Uint8Array) {
    parts.push(head(2, v.length), v);
  } else if (Array.isArray(v)) {
    parts.push(head(4, v.length), ...v.map(encodeCbor));
  } else {
    parts.push(head(5, v.size));
    for (const [k, val] of v) parts.push(encodeCbor(k), encodeCbor(val));
  }
  return Buffer.concat(parts);
}

export interface AuthenticatorFlags {
  up?: boolean;
  uv?: boolean;
  be?: boolean;
  bs?: boolean;
}

export interface SoftwareAuthenticator {
  readonly credentialId: string;
  readonly publicKeyCose: Uint8Array;
  register(input: {
    challenge: string;
    /** utf8 string, or the raw handle bytes (the engine's handles are sha256 bytes). */
    userHandle?: string | Uint8Array;
    origin?: string;
    rpId?: string;
    flags?: AuthenticatorFlags;
    counter?: number;
  }): RegistrationResponseJSON;
  authenticate(input: {
    challenge: string;
    counter: number;
    /** utf8 string, or the raw handle bytes (the engine's handles are sha256 bytes). */
    userHandle?: string | Uint8Array;
    origin?: string;
    rpId?: string;
    flags?: AuthenticatorFlags;
  }): AuthenticationResponseJSON;
}

const b64u = (b: Uint8Array | string): string => Buffer.from(b as Uint8Array).toString('base64url');
const sha256 = (b: Uint8Array | string): Buffer => createHash('sha256').update(b).digest();

function flagByte(f: AuthenticatorFlags | undefined, at: boolean): number {
  const up = f?.up ?? true;
  const uv = f?.uv ?? true;
  const be = f?.be ?? true;
  const bs = f?.bs ?? true;
  return (up ? 0x01 : 0) | (uv ? 0x04 : 0) | (be ? 0x08 : 0) | (bs ? 0x10 : 0) | (at ? 0x40 : 0);
}

function counterBytes(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}

export function createSoftwareAuthenticator(opts: {
  rpId: string;
  origin: string;
  flags?: AuthenticatorFlags;
}): SoftwareAuthenticator {
  const { privateKey, publicKey }: { privateKey: KeyObject; publicKey: KeyObject } =
    generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const x = Buffer.from(jwk.x as string, 'base64url');
  const y = Buffer.from(jwk.y as string, 'base64url');
  const publicKeyCose = encodeCbor(
    new Map<number | string, CborValue>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, x],
      [-3, y],
    ]),
  );
  const credentialIdBytes = randomBytes(32);
  const credentialId = b64u(credentialIdBytes);

  const clientData = (type: string, challenge: string, origin: string): Buffer =>
    Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }), 'utf8');

  return {
    credentialId,
    publicKeyCose,
    register(input) {
      const rpId = input.rpId ?? opts.rpId;
      const origin = input.origin ?? opts.origin;
      const idLen = Buffer.alloc(2);
      idLen.writeUInt16BE(credentialIdBytes.length);
      const authData = Buffer.concat([
        sha256(rpId),
        Buffer.of(flagByte(input.flags ?? opts.flags, true)),
        counterBytes(input.counter ?? 0),
        Buffer.alloc(16),
        idLen,
        credentialIdBytes,
        publicKeyCose,
      ]);
      const attestationObject = encodeCbor(
        new Map<number | string, CborValue>([
          ['fmt', 'none'],
          ['attStmt', new Map()],
          ['authData', authData],
        ]),
      );
      return {
        id: credentialId,
        rawId: credentialId,
        type: 'public-key',
        authenticatorAttachment: 'platform',
        clientExtensionResults: {},
        response: {
          clientDataJSON: b64u(clientData('webauthn.create', input.challenge, origin)),
          attestationObject: b64u(attestationObject),
          transports: ['internal'],
        },
      };
    },
    authenticate(input) {
      const rpId = input.rpId ?? opts.rpId;
      const origin = input.origin ?? opts.origin;
      const authData = Buffer.concat([
        sha256(rpId),
        Buffer.of(flagByte(input.flags ?? opts.flags, false)),
        counterBytes(input.counter),
      ]);
      const cd = clientData('webauthn.get', input.challenge, origin);
      const signature = sign('sha256', Buffer.concat([authData, sha256(cd)]), {
        key: privateKey,
        dsaEncoding: 'der',
      });
      return {
        id: credentialId,
        rawId: credentialId,
        type: 'public-key',
        authenticatorAttachment: 'platform',
        clientExtensionResults: {},
        response: {
          clientDataJSON: b64u(cd),
          authenticatorData: b64u(authData),
          signature: b64u(signature),
          ...(input.userHandle !== undefined ? { userHandle: b64u(input.userHandle) } : {}),
        },
      };
    },
  };
}
