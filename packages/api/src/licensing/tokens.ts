import { createHash, randomBytes } from 'node:crypto';

export function newActivationToken(): string {
  return `sr_act_${randomBytes(32).toString('base64url')}`;
}

export function hashActivationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

const LINE_TERMINATOR = /[\n\r\u2028\u2029]/;
const isSpace = (ch: string): boolean => /\s/.test(ch);

/**
 * `Authorization: Bearer <token>` -> token, else null. Same result as `/^Bearer\s+(.+)$/i` + trim, scanned linearly
 * (that regex backtracks polynomially on long runs of whitespace; CodeQL js/polynomial-redos).
 */
export function bearerToken(header: string | undefined): string | null {
  if (!header || header.slice(0, 6).toLowerCase() !== 'bearer') return null;
  const rest = header.slice(6);
  if (!rest || !isSpace(rest[0]!)) return null;
  let i = 0;
  while (i < rest.length && isSpace(rest[i]!)) i++;
  const tail = rest.slice(i);
  if (LINE_TERMINATOR.test(tail)) return null;
  return tail.trim() || null;
}
