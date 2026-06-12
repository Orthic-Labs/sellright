import { createHash, randomBytes } from 'node:crypto';

export function newActivationToken(): string {
  return `sr_act_${randomBytes(32).toString('base64url')}`;
}

export function hashActivationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function bearerToken(header: string | undefined): string | null {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? '');
  return match?.[1]?.trim() || null;
}
