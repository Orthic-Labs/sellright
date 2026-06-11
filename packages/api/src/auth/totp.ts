/**
 * RFC 6238 TOTP (admin 2FA) — HMAC-SHA1, 30s step, 6 digits. No dependency.
 * Compatible with Google Authenticator / Authy / 1Password.
 */
import { createHmac, randomBytes } from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Generate a new base32 secret (160-bit). */
export function newTotpSecret(): string {
  const buf = randomBytes(20);
  let bits = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}

function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = '';
  for (const ch of clean) {
    const v = B32.indexOf(ch);
    if (v < 0) continue;
    bits += v.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function hotp(secret: Buffer, counter: number): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', secret).update(buf).digest();
  const offset = hmac[hmac.length - 1]! & 0xf;
  const code = ((hmac[offset]! & 0x7f) << 24) | ((hmac[offset + 1]! & 0xff) << 16) | ((hmac[offset + 2]! & 0xff) << 8) | (hmac[offset + 3]! & 0xff);
  return (code % 1_000_000).toString().padStart(6, '0');
}

/**
 * Verify a 6-digit code, allowing ±1 step (clock drift). WP9.2: when `actorId`
 * is provided, the (actorId, step) of the most recently-accepted code is
 * remembered in-process and a second submit of the same code within the window
 * is rejected. This kills replay attacks without DB writes on the hot path
 * (acceptable: a server restart only widens the window to 90s, not 0).
 */
const recentByActor = new Map<string, { step: number; at: number }>();
const REPLAY_TTL_MS = 5 * 60 * 1000;

export function verifyTotp(secretB32: string, code: string, actorId?: string): boolean {
  if (!/^\d{6}$/.test(code.trim())) return false;
  const secret = base32Decode(secretB32);
  const step = Math.floor(Date.now() / 30000);
  for (let w = -1; w <= 1; w++) {
    if (hotp(secret, step + w) !== code.trim()) continue;
    if (actorId) {
      const prev = recentByActor.get(actorId);
      const now = Date.now();
      // Opportunistic GC to keep the map bounded.
      if (recentByActor.size > 1000) {
        for (const [k, v] of recentByActor) if (now - v.at > REPLAY_TTL_MS) recentByActor.delete(k);
      }
      if (prev && now - prev.at < REPLAY_TTL_MS && prev.step === step + w) return false; // replay
      recentByActor.set(actorId, { step: step + w, at: now });
    }
    return true;
  }
  return false;
}

/** otpauth:// URI for QR / manual entry. */
export function otpauthUri(secretB32: string, account: string, issuer = 'SellRight'): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
