import { describe, expect, it } from 'vitest';
import { assertNotReserved, assertNotReservedTopic, hasReservedCanaryKeys, ReservedMarkerError, CANARY_TOPIC } from './marker.js';
import { validateCanaryRequest, readCanaryConfig, canaryRetryAfter, recordCanaryEmit } from './health-canary.js';
import { enqueueEmail } from '../email/outbox.js';
import { enqueuePush } from '../push/outbox.js';
import { emitEvent } from '../webhooks/emit.js';
import { HttpError } from '../routes/admin-helpers.js';

// Guards throw before the transaction is touched, so a stub tx is enough.
const deadTx = {} as never;
const STORE = 'dddddddd-0000-0000-0000-00000000c001';
const EMAIL = { to: 'x@example.com', from: 'a@example.com', subject: 's', html: 'h', text: 't' };

describe('canary reserved marker', () => {
  it('detects canary keys in payloads', () => {
    expect(hasReservedCanaryKeys({ canary: true })).toBe(true);
    expect(hasReservedCanaryKeys({ marker: 'health.canary' })).toBe(true);
    expect(hasReservedCanaryKeys({ marker: 'other' })).toBe(false);
    expect(hasReservedCanaryKeys(EMAIL)).toBe(false);
    expect(hasReservedCanaryKeys(null)).toBe(false);
  });

  it('refuses reserved payloads on non-canary paths and allows the internal path', () => {
    expect(() => assertNotReserved('x', { canary: true }, false)).toThrow(ReservedMarkerError);
    expect(() => assertNotReserved('x', { canary: true }, true)).not.toThrow();
    expect(() => assertNotReservedTopic('x', CANARY_TOPIC, false)).toThrow(ReservedMarkerError);
    expect(() => assertNotReservedTopic('x', 'order.paid', false)).not.toThrow();
  });

  it('public email enqueue rejects a payload carrying the marker', async () => {
    await expect(enqueueEmail(deadTx, STORE, { kind: 'contact_ack', recipient: 'x@example.com', payload: { ...EMAIL, canary: true } as never })).rejects.toBeInstanceOf(ReservedMarkerError);
  });

  it('public push enqueue rejects the reserved topic', async () => {
    await expect(enqueuePush(deadTx, STORE, { topic: CANARY_TOPIC, payload: {} })).rejects.toBeInstanceOf(ReservedMarkerError);
  });

  it('merchant webhook emit rejects the reserved topic and marker payloads', async () => {
    await expect(emitEvent(deadTx, STORE, CANARY_TOPIC, {})).rejects.toBeInstanceOf(ReservedMarkerError);
    await expect(emitEvent(deadTx, STORE, 'order.paid', { canary: true })).rejects.toBeInstanceOf(ReservedMarkerError);
  });
});

describe('validateCanaryRequest', () => {
  it('rejects bad slot, empty/duplicate channels, and kinds without email', () => {
    expect(() => validateCanaryRequest({ slot: -1, channels: ['email'] })).toThrow(HttpError);
    expect(() => validateCanaryRequest({ slot: 1.5, channels: ['email'] })).toThrow(HttpError);
    expect(() => validateCanaryRequest({ slot: 1, channels: [] })).toThrow(HttpError);
    expect(() => validateCanaryRequest({ slot: 1, channels: ['email', 'email'] })).toThrow(HttpError);
    expect(() => validateCanaryRequest({ slot: 1, channels: ['webhook'], kinds: ['password_reset'] })).toThrow(HttpError);
    expect(() => validateCanaryRequest({ slot: 1, channels: ['email', 'push'], kinds: ['password_reset'] })).not.toThrow();
  });
});

describe('readCanaryConfig', () => {
  it('reads only health.canary.* strings and ignores blanks', () => {
    expect(readCanaryConfig({ health: { canary: { email: ' c@x.io ', webhookUrl: '', pushToken: 'tok', pushEnvironment: 'sandbox', extra: 1 } } }))
      .toEqual({ email: 'c@x.io', webhookUrl: undefined, pushToken: 'tok', pushEnvironment: 'sandbox' });
    expect(readCanaryConfig(null)).toEqual({});
    expect(readCanaryConfig({ health: { canary: { email: 42 } } })).toEqual({});
  });
});

describe('canary rate budget (1 per channel per minute per store)', () => {
  it('blocks a second emit on the same channel and store, not other channels or stores', async () => {
    const other = 'dddddddd-0000-0000-0000-00000000c002';
    expect(await canaryRetryAfter(STORE, ['email'])).toBe(0);
    await recordCanaryEmit(STORE, ['email']);
    expect(await canaryRetryAfter(STORE, ['email'])).toBeGreaterThan(0);
    expect(await canaryRetryAfter(STORE, ['webhook'])).toBe(0);
    expect(await canaryRetryAfter(other, ['email'])).toBe(0);
  });
});
