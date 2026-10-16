import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export const LEGACY_CONTACT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SIGNATURE = /^[0-9a-f]{64}$/;
const Binding = z.object({
  secret: z.string().min(1),
  issuedBefore: z.number().int().positive().max(Number.MAX_SAFE_INTEGER - LEGACY_CONTACT_MAX_AGE_MS),
}).strict();
const Bindings = z.record(z.string().regex(UUID), Binding);

/** Server-only, exact tenant binding. No global signing-key fallback is valid here. */
export function legacyContactBinding(storeId: string, raw = process.env.LEGACY_CONTACT_COMPAT_JSON): z.infer<typeof Binding> | null {
  if (!UUID.test(storeId) || !raw) return null;
  try {
    const parsed = Bindings.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    // Legacy signatures carry no tenant ID. Shared effective HMAC keys would
    // let one store's link authorize delivery in another store. Reject the
    // entire map, including keys equivalent after HMAC's zero-padding/UTF-8
    // conversion, rather than trusting deployment key uniqueness.
    const keys = new Set<string>();
    for (const binding of Object.values(parsed.data)) {
      const fingerprint = createHmac('sha256', binding.secret).update('sellright:legacy-contact:tenant-key-uniqueness').digest('hex');
      if (keys.has(fingerprint)) return null;
      keys.add(fingerprint);
    }
    return Object.hasOwn(parsed.data, storeId) ? parsed.data[storeId]! : null;
  } catch { return null; }
}

/** Shared with the cutover marker importer: verified Redis signatures claim this exact key before opening traffic. */
export function legacyContactMarkerId(storeId: string, signature: string): string {
  if (!UUID.test(storeId) || !SIGNATURE.test(signature)) throw new Error('Invalid legacy contact marker');
  return `legacy-contact:${storeId}:${signature}`;
}

// Source legacy fields have no subject/email length cap. Transport URL limits
// remain authoritative; imposing the native form's caps would strand old links.
const Submission = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/),
  subject: z.string().trim().min(1),
  message: z.string().trim().min(1).max(5000),
}).strict();

export type LegacyContactSubmission = z.infer<typeof Submission>;
export type LegacyContactResult =
  | { ok: true; submission: LegacyContactSubmission }
  | { ok: false; status: 400 | 403 | 410 };

export function verifyLegacyContact(
  input: { data: string; ts: string; sig: string },
  binding: z.infer<typeof Binding> | null,
  now = Date.now(),
): LegacyContactResult {
  if (!binding) return { ok: false, status: 403 };
  if (!/^\d{1,16}$/.test(input.ts) || !SIGNATURE.test(input.sig) || !/^[A-Za-z0-9_-]+$/.test(input.data)) {
    return { ok: false, status: 400 };
  }
  const ts = Number(input.ts);
  if (!Number.isSafeInteger(ts) || ts <= 0) return { ok: false, status: 400 };
  // Authenticate untouched query values before attempting JSON/UTF-8 decoding.
  const expected = createHmac('sha256', binding.secret).update(`${input.data}:${input.ts}`).digest();
  if (!timingSafeEqual(Buffer.from(input.sig, 'hex'), expected)) return { ok: false, status: 403 };
  if (ts > binding.issuedBefore || now > binding.issuedBefore + LEGACY_CONTACT_MAX_AGE_MS ||
      now - ts > LEGACY_CONTACT_MAX_AGE_MS || ts - now > 5 * 60 * 1000) {
    return { ok: false, status: 410 };
  }
  try {
    const bytes = Buffer.from(input.data, 'base64url');
    if (bytes.toString('base64url') !== input.data) return { ok: false, status: 400 };
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const submission = Submission.safeParse(JSON.parse(decoded));
    return submission.success ? { ok: true, submission: submission.data } : { ok: false, status: 400 };
  } catch { return { ok: false, status: 400 }; }
}
