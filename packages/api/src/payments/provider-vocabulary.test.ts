import { describe, expect, it } from 'vitest';
import { TERMINAL_PROVIDER_STATUSES } from './provider-observation.js';
import { nmiObservedLabel } from './nmi-query.js';
import { sezzleObservedStatus } from './sezzle.js';

/** Pins the strings the writers emit to MAINTENANCE-INVENTORY 4.6 (rightsuite.__terminal_status). */
describe('provider_status vocabulary (4.6)', () => {
  it('terminal sets equal the 4.6 table', () => {
    expect(TERMINAL_PROVIDER_STATUSES).toEqual({
      'stripe/intent': ['succeeded', 'canceled'], 'nmi/charge': ['settled', 'failed'], 'sezzle/session': ['captured', 'declined'],
    });
  });
  it('every terminal label the writers can emit is in the set, and nothing else is', () => {
    expect(nmiObservedLabel({ state: 'Settled' })).toBe('settled');
    expect(nmiObservedLabel({ state: 'Failed' })).toBe('failed');
    expect(nmiObservedLabel({ state: 'Pending', metadata: { reason: 'amount_or_action_mismatch' } })).toBe('unresolved:amount_or_action_mismatch');
    const emitted = new Set([
      sezzleObservedStatus({ checkout_status: 'denied' }, { amount: 1, currency: 'USD' }),
      sezzleObservedStatus({ authorization: { approved: true, captures: [{ uuid: 'c', amount: { amount_in_cents: 1, currency: 'USD' } }] } }, { amount: 1, currency: 'USD' }),
    ]);
    expect([...emitted].sort()).toEqual([...TERMINAL_PROVIDER_STATUSES['sezzle/session']].sort());
  });
});
