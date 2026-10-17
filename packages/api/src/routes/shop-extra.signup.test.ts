import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  existing: null as null | { id: string; status: string; token: string; lastSentAt: Date | null; meta: unknown },
  inserted: [] as Record<string, unknown>[],
  updated: [] as Record<string, unknown>[],
  send: vi.fn(),
}));
vi.mock('./shop-extra.subscriber.js', () => ({ sendSubscriberConfirmation: state.send }));
vi.mock('../db/client.js', () => ({
  withStore: async (_id: string, fn: (tx: unknown) => unknown) => {
    let selects = 0;
    const tx = {
      execute: vi.fn(),
      select: () => {
        selects += 1;
        const first = selects === 1;
        return { from: () => ({ where: () => first ? Promise.resolve([{ n: 0 }]) : { limit: async () => state.existing ? [state.existing] : [] } }) };
      },
      insert: () => ({ values: (value: Record<string, unknown>) => {
        state.inserted.push(value);
        return { onConflictDoNothing: () => ({ returning: async () => [{ id: 'new-1', token: 'token-1' }] }) };
      } }),
      update: () => ({ set: (value: Record<string, unknown>) => {
        state.updated.push(value);
        return { where: async () => undefined };
      } }),
    };
    return fn(tx);
  },
}));
import { persistSubscriberSignup } from './shop-extra.signup.js';
const store = { id: 'store-1', name: 'Store', currency: 'USD' };
const signup = { email: ' User@Example.COM ', kind: 'waitlist' as const, topic: 'viewright', source: 'import' as const };

beforeEach(() => {
  state.existing = null;
  state.inserted.length = 0;
  state.updated.length = 0;
  state.send.mockReset();
});

describe('one subscriber/outbox owner for legacy compatibility', () => {
  it('inert imports create pending rows, no send timestamp, no email', async () => {
    expect(await persistSubscriberSignup(store, signup, 'import')).toEqual({ existed: false, enqueued: false });
    expect(state.inserted[0]).toMatchObject({ email: 'user@example.com', status: 'pending', lastSentAt: null });
    expect(state.inserted[0]).not.toHaveProperty('confirmedAt');
    expect(state.send).not.toHaveBeenCalled();
  });
  it.each(['pending', 'confirmed', 'unsubscribed', 'bounced'])('legacy duplicates preserve %s consent & original record without mail', async (status) => {
    state.existing = { id: 'existing-1', status, token: 'old', lastSentAt: null, meta: { legacyKvOriginal: { signed_up_at: 'original' }, biggest_frustration: 'old answer' } };
    expect(await persistSubscriberSignup(store, { ...signup, meta: { current_tool: 'new tool' } }, 'legacy')).toEqual({ existed: true, enqueued: false });
    expect(state.inserted).toEqual([]);
    expect(state.updated[0]?.meta).toEqual({ legacyKvOriginal: { signed_up_at: 'original' }, biggest_frustration: 'old answer', current_tool: 'new tool' });
    expect(state.updated[0]).not.toHaveProperty('status');
    expect(state.updated[0]).not.toHaveProperty('unsubscribedAt');
    expect(state.updated[0]).not.toHaveProperty('lastSentAt');
    expect(state.send).not.toHaveBeenCalled();
  });
  it('rerun imports retain existing metadata & consent while attaching original KV record', async () => {
    state.existing = { id: 'existing-1', status: 'unsubscribed', token: 'old', lastSentAt: null, meta: { survey: 'current' } };
    await persistSubscriberSignup(store, { ...signup, meta: { survey: 'stale', legacyKvOriginal: { signed_up_at: 'original' } } }, 'import');
    expect(state.updated[0]?.meta).toEqual({ survey: 'current', legacyKvOriginal: { signed_up_at: 'original' } });
    expect(state.updated[0]).not.toHaveProperty('status');
    expect(state.send).not.toHaveBeenCalled();
  });
  it('new online legacy signup enqueues through canonical outbox owner', async () => {
    expect(await persistSubscriberSignup(store, signup, 'legacy')).toEqual({ existed: false, enqueued: true });
    expect(state.send).toHaveBeenCalledTimes(1);
    expect(state.send.mock.calls[0]?.[2]).toMatchObject({ email: 'user@example.com', kind: 'waitlist', topic: 'viewright', token: 'token-1' });
  });
  it('canonical signup still reconsents unsubscribed row & enqueues confirmation', async () => {
    state.existing = { id: 'existing-1', status: 'unsubscribed', token: 'old', lastSentAt: null, meta: {} };
    expect(await persistSubscriberSignup(store, signup)).toEqual({ existed: true, enqueued: true });
    expect(state.updated[0]).toMatchObject({ status: 'pending', unsubscribedAt: null });
    expect(state.send).toHaveBeenCalledTimes(1);
  });
});
