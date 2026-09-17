import { createHash, timingSafeEqual } from 'node:crypto';

const SHA256_HEX = /^[0-9a-f]{64}$/i;

/** Validate the dedicated release service credential without accepting admin sessions. */
export function isReleaseServiceToken(authorization: string | undefined, expectedSha256: string | undefined): boolean {
  if (!authorization || !expectedSha256 || !SHA256_HEX.test(expectedSha256)) return false;
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  const token = match?.[1]?.trim();
  if (!token) return false;
  const actual = createHash('sha256').update(token).digest();
  const expected = Buffer.from(expectedSha256, 'hex');
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}
