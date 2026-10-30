/** A2: sendApns must not hang a push pass when Apple never answers. No network: node:http2 is mocked. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { EventEmitter } from 'node:events';

const { privateKey } = generateKeyPairSync('ec', {
  namedCurve: 'prime256v1',
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const h = vi.hoisted(() => ({ sessions: [] as Array<{ destroyed: boolean; closed: boolean }> }));

vi.mock('../env.js', () => ({
  env: { APNS_KEY_P8: privateKey, APNS_KEY_ID: 'ABC123DEFG', APNS_TEAM_ID: '6KLGD3LLKF', APNS_BUNDLE_ID: 'app.test' },
}));
vi.mock('node:http2', async (original) => {
  const real = await original<typeof import('node:http2')>();
  return {
    ...real,
    connect: () => {
      const session = Object.assign(new EventEmitter(), {
        destroyed: false, closed: false,
        destroy() { session.destroyed = true; },
        close() { session.closed = true; },
        // A stream that is accepted but never answered.
        request: () => Object.assign(new EventEmitter(), { setEncoding: () => undefined, end: () => undefined }),
      });
      h.sessions.push(session);
      return session;
    },
  };
});

const { sendApns, APNS_REQUEST_DEADLINE_MS } = await import('./apns.js');

afterEach(() => { vi.useRealTimers(); h.sessions = []; });

describe('sendApns deadline (A2)', () => {
  it('rejects and destroys the session once APNS_REQUEST_DEADLINE_MS elapses', async () => {
    vi.useFakeTimers();
    const pending = sendApns({ deviceToken: 'abc', environment: 'sandbox', payload: { aps: {} } });
    const assertion = expect(pending).rejects.toThrow(/apns_deadline_exceeded/);
    await vi.advanceTimersByTimeAsync(APNS_REQUEST_DEADLINE_MS + 1);
    await assertion;
    expect(h.sessions).toHaveLength(1);
    expect(h.sessions[0]!.destroyed).toBe(true);
  });
});
