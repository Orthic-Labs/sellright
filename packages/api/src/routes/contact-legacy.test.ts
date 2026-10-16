import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { legacyContactBinding, legacyContactMarkerId, verifyLegacyContact, LEGACY_CONTACT_MAX_AGE_MS } from './contact-legacy.js';

const STORE = 'dddddddd-dddd-dddd-dddd-dddddddddddc';
const OTHER = 'dddddddd-dddd-dddd-dddd-dddddddddddb';
const NOW = 1_800_000_000_000;
const binding = { secret: 'original-legacy-fixture-secret', issuedBefore: NOW };
const submission = { name: 'Ada', email: 'ada@example.com', subject: 'Order question', message: 'Where is my order?' };
function signed(value: unknown = submission, ts = NOW, secret = binding.secret) {
  const data = Buffer.from(JSON.stringify(value)).toString('base64url');
  return { data, ts: String(ts), sig: createHmac('sha256', secret).update(`${data}:${ts}`).digest('hex') };
}

describe('legacy contact compatibility binding & verifier', () => {
  it('uses only an exact UUID binding & fails closed on absent/malformed config', () => {
    const config = JSON.stringify({ [STORE]: binding });
    expect(legacyContactBinding(STORE, config)).toEqual(binding);
    expect(legacyContactBinding(OTHER, config)).toBeNull();
    for (const raw of ['', '{', '[]', 'null', JSON.stringify({ '*': binding }), JSON.stringify({ [STORE]: { secret: '', issuedBefore: NOW } }),
      JSON.stringify({ [STORE]: { ...binding, issuedBefore: '1800000000000' } }), JSON.stringify({ [STORE]: { ...binding, extra: true } })]) {
      expect(legacyContactBinding(STORE, raw)).toBeNull();
    }
    expect(verifyLegacyContact(signed(), null, NOW)).toEqual({ ok: false, status: 403 });
  });

  it('accepts original payload & retains legacy email/subject lengths beyond native form limits', () => {
    expect(verifyLegacyContact(signed(), binding, NOW)).toEqual({ ok: true, submission });
    const legacy = { ...submission, subject: 's'.repeat(700), email: `${'a'.repeat(350)}@example.com` };
    expect(verifyLegacyContact(signed(legacy), binding, NOW)).toEqual({ ok: true, submission: legacy });
  });

  it('rejects the whole map when tenants share an effective HMAC key', () => {
    const input = signed();
    for (const otherSecret of [binding.secret, `${binding.secret}\0`]) {
      const config = JSON.stringify({ [STORE]: binding, [OTHER]: { ...binding, secret: otherSecret } });
      for (const storeId of [STORE, OTHER]) {
        const resolved = legacyContactBinding(storeId, config);
        expect(resolved).toBeNull();
        expect(verifyLegacyContact(input, resolved, NOW)).toEqual({ ok: false, status: 403 });
      }
    }
  });

  it('rejects cross-tenant keys, data/signature tampering & malformed inputs', () => {
    const input = signed();
    expect(verifyLegacyContact(input, { ...binding, secret: 'other-store-key' }, NOW)).toEqual({ ok: false, status: 403 });
    expect(verifyLegacyContact({ ...input, data: signed({ ...submission, email: 'attacker@example.com' }).data }, binding, NOW)).toEqual({ ok: false, status: 403 });
    expect(verifyLegacyContact({ ...input, sig: '0'.repeat(64) }, binding, NOW)).toEqual({ ok: false, status: 403 });
    for (const bad of [{ ...input, sig: input.sig.toUpperCase() }, { ...input, sig: 'x' }, { ...input, ts: '1.5' }, { ...input, ts: '9007199254740992' }, { ...input, data: '=' }]) {
      expect(verifyLegacyContact(bad, binding, NOW)).toEqual({ ok: false, status: 400 });
    }
    for (const bad of [null, [], { ...submission, name: ' ' }, { ...submission, name: 'x'.repeat(201) }, { ...submission, message: 'x'.repeat(5001) }, { ...submission, email: 'invalid' }, { ...submission, subject: '' }]) {
      expect(verifyLegacyContact(signed(bad), binding, NOW)).toEqual({ ok: false, status: 400 });
    }
  });

  it('authenticates before JSON decode & rejects signed malformed encoding/payload', () => {
    for (const data of [Buffer.from('{').toString('base64url'), Buffer.from([0xff]).toString('base64url'), 'Zh']) {
      const sig = createHmac('sha256', binding.secret).update(`${data}:${NOW}`).digest('hex');
      expect(verifyLegacyContact({ data, ts: String(NOW), sig }, binding, NOW)).toEqual({ ok: false, status: 400 });
    }
  });

  it('enforces 24h age, five-minute future allowance, issuance freeze & fixed sunset', () => {
    expect(verifyLegacyContact(signed(submission, NOW - LEGACY_CONTACT_MAX_AGE_MS), binding, NOW).ok).toBe(true);
    expect(verifyLegacyContact(signed(submission, NOW - LEGACY_CONTACT_MAX_AGE_MS - 1), binding, NOW)).toEqual({ ok: false, status: 410 });
    expect(verifyLegacyContact(signed(submission, NOW + 1), binding, NOW)).toEqual({ ok: false, status: 410 });
    expect(verifyLegacyContact(signed(submission, NOW), binding, NOW - 300_000).ok).toBe(true);
    expect(verifyLegacyContact(signed(submission, NOW), binding, NOW - 300_001)).toEqual({ ok: false, status: 410 });
    expect(verifyLegacyContact(signed(), binding, NOW + LEGACY_CONTACT_MAX_AGE_MS).ok).toBe(true);
    expect(verifyLegacyContact(signed(), binding, NOW + LEGACY_CONTACT_MAX_AGE_MS + 1)).toEqual({ ok: false, status: 410 });
  });

  it('gives marker transfer & handler one permanent tenant-namespaced dedupe key', () => {
    const { sig } = signed();
    expect(legacyContactMarkerId(STORE, sig)).toBe(`legacy-contact:${STORE}:${sig}`);
    expect(legacyContactMarkerId(STORE, sig)).not.toBe(legacyContactMarkerId(OTHER, sig));
    expect(() => legacyContactMarkerId('*', sig)).toThrow();
    expect(() => legacyContactMarkerId(STORE, 'bad')).toThrow();
  });
});
