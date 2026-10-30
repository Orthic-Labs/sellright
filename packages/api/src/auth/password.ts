import { argon2, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { compare as compareBcrypt } from 'bcryptjs';

const scryptA = promisify(scrypt);

// OWASP Argon2id baseline: 19 MiB, 2 passes, p=1. Keep these constants
// centralized so a future work-factor increase can use passwordNeedsRehash()
// without changing the stored format.
const ARGON2_VERSION = 19;
const ARGON2_MEMORY_KIB = 19_456;
const ARGON2_PASSES = 2;
const ARGON2_PARALLELISM = 1;
const ARGON2_TAG_LENGTH = 32;
const SALT_LENGTH = 16;

// Defensive parser caps. Stored hashes are database input; do not allow a
// malformed row to request unbounded memory/CPU during login.
const MAX_MEMORY_KIB = 65_536;
const MAX_PASSES = 10;
const MAX_PARALLELISM = 8;
const MIN_TAG_LENGTH = 16;
const MAX_TAG_LENGTH = 64;

const LEGACY_SCRYPT_KEYLEN = 64;

function argon2id(message: string, nonce: Buffer, memory: number, passes: number, parallelism: number, tagLength: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2(
      'argon2id',
      { message, nonce, memory, passes, parallelism, tagLength },
      (error, derivedKey) => error ? reject(error) : resolve(derivedKey),
    );
  });
}

const phcBase64 = (value: Buffer): string => value.toString('base64').replace(/=+$/u, '');

function parsePhcBase64(value: string): Buffer | null {
  if (!/^[A-Za-z0-9+/]+$/u.test(value)) return null;
  const decoded = Buffer.from(value, 'base64');
  return phcBase64(decoded) === value ? decoded : null;
}

type ParsedArgon2 = {
  memory: number;
  passes: number;
  parallelism: number;
  salt: Buffer;
  expected: Buffer;
};

function parseArgon2(stored: string): ParsedArgon2 | null {
  const match = /^\$argon2id\$v=(\d+)\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/u.exec(stored);
  if (!match) return null;

  const version = Number(match[1]);
  const memory = Number(match[2]);
  const passes = Number(match[3]);
  const parallelism = Number(match[4]);
  const salt = parsePhcBase64(match[5]!);
  const expected = parsePhcBase64(match[6]!);

  if (
    version !== ARGON2_VERSION ||
    !Number.isSafeInteger(memory) || memory < 8 * parallelism || memory > MAX_MEMORY_KIB ||
    !Number.isSafeInteger(passes) || passes < 1 || passes > MAX_PASSES ||
    !Number.isSafeInteger(parallelism) || parallelism < 1 || parallelism > MAX_PARALLELISM ||
    !salt || salt.length < 8 || salt.length > 64 ||
    !expected || expected.length < MIN_TAG_LENGTH || expected.length > MAX_TAG_LENGTH
  ) return null;

  return { memory, passes, parallelism, salt, expected };
}

/**
 * Native SellRight password format: standard PHC-style Argon2id string.
 * Node's built-in Argon2 implementation keeps the auth path dependency-free.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await argon2id(
    password,
    salt,
    ARGON2_MEMORY_KIB,
    ARGON2_PASSES,
    ARGON2_PARALLELISM,
    ARGON2_TAG_LENGTH,
  );
  return `$argon2id$v=${ARGON2_VERSION}$m=${ARGON2_MEMORY_KIB},t=${ARGON2_PASSES},p=${ARGON2_PARALLELISM}$${phcBase64(salt)}$${phcBase64(derived)}`;
}

async function verifyLegacyScrypt(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  if (!/^[0-9a-f]+$/iu.test(saltHex) || !/^[0-9a-f]+$/iu.test(hashHex)) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  if (salt.length === 0 || expected.length !== LEGACY_SCRYPT_KEYLEN) return false;
  const derived = (await scryptA(password, salt, LEGACY_SCRYPT_KEYLEN)) as Buffer;
  return timingSafeEqual(derived, expected);
}

/** Vendure customer hashes only; cap work factors before invoking bcrypt. */
export function isLegacyBcryptHash(stored: string): boolean {
  const match = /^\$2[aby]\$(\d{2})\$[./A-Za-z0-9]{53}$/.exec(stored);
  return !!match && Number(match[1]) >= 4 && Number(match[1]) <= 14;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;

  try {
    if (isLegacyBcryptHash(stored)) return compareBcrypt(password, stored.replace(/^\$2y\$/, '$2b$'));
    const parsed = parseArgon2(stored);
    if (parsed) {
      const derived = await argon2id(
        password,
        parsed.salt,
        parsed.memory,
        parsed.passes,
        parsed.parallelism,
        parsed.expected.length,
      );
      return timingSafeEqual(derived, parsed.expected);
    }

    // Transitional compatibility for hashes created by SellRight before the
    // Argon2id switch. This is not a Vendure compatibility path; successful
    // logins should immediately be rehashed by the caller.
    if (stored.startsWith('scrypt$')) return verifyLegacyScrypt(password, stored);
    return false;
  } catch {
    // Authentication must fail closed for malformed hashes or crypto failures.
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/** Constant-time behaviour for unknown accounts (P1a): run one full Argon2id
 *  verification against a throwaway hash so "no such admin" costs the same as
 *  "wrong password" and response timing does not reveal which e-mails exist.
 *  Always resolves false. */
export async function verifyPasswordAgainstDummy(password: string): Promise<false> {
  dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
  await verifyPassword(password, await dummyHash);
  return false;
}

/** True when a successful login should replace the stored hash. */
export function passwordNeedsRehash(stored: string | null): boolean {
  if (!stored) return false;
  const parsed = parseArgon2(stored);
  if (!parsed) return stored.startsWith('scrypt$') || isLegacyBcryptHash(stored);
  return parsed.memory !== ARGON2_MEMORY_KIB ||
    parsed.passes !== ARGON2_PASSES ||
    parsed.parallelism !== ARGON2_PARALLELISM ||
    parsed.expected.length !== ARGON2_TAG_LENGTH;
}

/** Issue #333 review: ONE minimum for every admin password a person chooses (invite accept, staff create, reset, change). */
export const ADMIN_PASSWORD_MIN = 10;

// ── bounded verification (P8 / G6) ───────────────────────────────────────────
// Each verification is expensive (Argon2id 19 MiB on the libuv pool; legacy bcrypt on the event loop). A credential
// flood used to queue them without bound behind every other pool task. Public sign-in paths go through this gate:
// at most VERIFY_MAX_CONCURRENT run at once per process, at most VERIFY_MAX_QUEUED wait, and anything beyond that is
// refused immediately ('busy') so the route can answer 503 + Retry-After instead of stalling the whole process.
// 'busy' is NEVER a wrong password: callers must not record an authentication failure for it.
const VERIFY_MAX_CONCURRENT = 4;
const VERIFY_MAX_QUEUED = 64;
let verifyActive = 0;
const verifyWaiters: Array<() => void> = [];

function releaseVerifySlot(): void {
  const next = verifyWaiters.shift();
  if (next) next(); // hand the slot over; verifyActive is unchanged
  else verifyActive--;
}

/** verifyPassword behind a bounded per-process admission gate. Resolves 'busy' (no verification ran) when saturated. */
export async function verifyPasswordBounded(password: string, stored: string | null): Promise<boolean | 'busy'> {
  if (!stored) return false;
  if (verifyActive >= VERIFY_MAX_CONCURRENT) {
    if (verifyWaiters.length >= VERIFY_MAX_QUEUED) return 'busy';
    await new Promise<void>((resolve) => verifyWaiters.push(resolve));
  } else {
    verifyActive++;
  }
  try {
    return await verifyPassword(password, stored);
  } finally {
    releaseVerifySlot();
  }
}

/** Test-only: current gate occupancy. */
export function _passwordVerifyGateForTest(): { active: number; queued: number; maxConcurrent: number; maxQueued: number } {
  return { active: verifyActive, queued: verifyWaiters.length, maxConcurrent: VERIFY_MAX_CONCURRENT, maxQueued: VERIFY_MAX_QUEUED };
}
