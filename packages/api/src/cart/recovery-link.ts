/** Signed, expiring abandoned-cart recovery links.
 *
 *  The email carries `cartId` (an internal uuid, never the bearer cart token),
 *  an expiry and an HMAC over `storeId:cartId:exp`. Only the API route that
 *  verifies the signature (routes/cart-recover.ts) ever reveals the cart token,
 *  and only to a browser that presented a valid, unexpired link. */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from '../env.js';

export const RECOVERY_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

let secret: string | undefined;
/** Same fallback chain as the contact-form confirm link; last resort is a
 *  per-process random key (links die on restart — better than a public default). */
const secretResolver = (): string =>
  (secret ??=
    env.CONTACT_FORM_SECRET ?? env.LICENSING_HMAC_SECRET ?? env.COOKIE_SECRET ?? env.DOWNLOAD_URL_SECRET ??
    randomBytes(32).toString('hex'));

const sign = (storeId: string, cartId: string, exp: number, key: string): string =>
  createHmac('sha256', key).update(`cart-recover:${storeId}:${cartId}:${exp}`).digest('hex');

export function signRecovery(storeId: string, cartId: string, exp: number, key = secretResolver()): string {
  return sign(storeId, cartId, exp, key);
}

export function buildRecoveryUrl(storefrontUrl: string, storeId: string, cartId: string, now = Date.now(), key = secretResolver()): string {
  const exp = now + RECOVERY_LINK_TTL_MS;
  return `${storefrontUrl.replace(/\/+$/, '')}/v1/shop/cart/recover/${cartId}?exp=${exp}&sig=${sign(storeId, cartId, exp, key)}`;
}

export type RecoveryVerdict = 'ok' | 'invalid' | 'expired';

export function verifyRecovery(storeId: string, cartId: string, expRaw: string, sig: string, now = Date.now(), key = secretResolver()): RecoveryVerdict {
  const exp = Number(expRaw);
  if (!Number.isSafeInteger(exp) || !/^[0-9a-f]{64}$/.test(sig)) return 'invalid';
  const a = Buffer.from(sig, 'hex');
  const b = Buffer.from(sign(storeId, cartId, exp, key), 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return 'invalid'; // signature before expiry: no oracle on unsigned input
  return now > exp ? 'expired' : 'ok';
}
