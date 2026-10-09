import { describe, expect, it, vi } from 'vitest';
vi.mock('~/utils/seo', () => ({ createSEOHead: vi.fn() }));
import { activeStepFromState, parseLineName, isOrderSettled, isOrderTerminalUnpaid, readOrderUntilSettled, resolveConfirmationEmail, sleepAbortable } from './confirmation-data';

describe('SellRight confirmation progress', () => {
  it.each([
    ['PendingPayment', 0], ['Paid', 1], ['Shipped', 2], ['PartiallyShipped', 2], ['Delivered', 3],
    ['Cancelled', 0], ['Declined', 0], ['AddingItems', 0], [undefined, 0],
  ])('maps %s to the correct step', (state, step) => {
    expect(activeStepFromState(state as string | undefined)).toBe(step);
  });
});

describe('isOrderSettled', () => {
  it.each([
    ['Paid', true], ['Shipped', true], ['PartiallyShipped', true], ['Delivered', true],
    ['PendingPayment', false], ['Cancelled', false], ['Declined', false], ['AddingItems', false], [undefined, false],
  ])('%s → %s', (state, expected) => {
    expect(isOrderSettled(state as string | undefined)).toBe(expected);
  });
});

describe('isOrderTerminalUnpaid', () => {
  it.each([
    ['Cancelled', true], ['Declined', true],
    ['Paid', false], ['PendingPayment', false], ['Shipped', false], [undefined, false],
  ])('%s → %s', (state, expected) => {
    expect(isOrderTerminalUnpaid(state as string | undefined)).toBe(expected);
  });
});

describe('parseLineName', () => {
  it('splits "<Product> / <Option>" without a stray trailing separator', () => {
    expect(parseLineName('Studio Notebook / Sage')).toEqual({ productName: 'Studio Notebook', variantLabel: 'Sage' });
  });

  it('joins multiple option segments back with " / "', () => {
    expect(parseLineName('Desk Tray / Rose / Large')).toEqual({ productName: 'Desk Tray', variantLabel: 'Rose / Large' });
  });

  it('falls back to the full variant name when there is no separator', () => {
    expect(parseLineName('Stoneware Cup')).toEqual({ productName: 'Stoneware Cup', variantLabel: '' });
  });

  it('prefers a known product name and skips the split entirely', () => {
    expect(parseLineName('Studio Notebook / Sage', 'Studio Notebook')).toEqual({ productName: 'Studio Notebook', variantLabel: '' });
  });

  it('falls back to "Product" for an empty variant name', () => {
    expect(parseLineName('')).toEqual({ productName: 'Product', variantLabel: '' });
  });
});

describe('readOrderUntilSettled (abortable receipt poll)', () => {
  const noSleep = async () => {};

  it('returns the first read when the order is already settled', async () => {
    const read = vi.fn(async () => ({ state: 'Paid' }));
    const out = await readOrderUntilSettled(read, new AbortController().signal, { sleep: noSleep });
    expect(out).toEqual({ state: 'Paid' });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('re-reads while PendingPayment, then returns the settled order', async () => {
    const states = ['PendingPayment', 'PendingPayment', 'Paid'];
    const read = vi.fn(async () => ({ state: states.shift()! }));
    const out = await readOrderUntilSettled(read, new AbortController().signal, { sleep: noSleep });
    expect(out).toEqual({ state: 'Paid' });
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('gives up after the attempt budget and returns the last (still pending) read', async () => {
    const read = vi.fn(async () => ({ state: 'PendingPayment' }));
    const out = await readOrderUntilSettled(read, new AbortController().signal, { attempts: 3, sleep: noSleep });
    expect(out).toEqual({ state: 'PendingPayment' });
    expect(read).toHaveBeenCalledTimes(4); // first read + 3 re-reads
  });

  it('stops polling and resolves null the moment the signal aborts (page unmounted)', async () => {
    const ac = new AbortController();
    const read = vi.fn(async () => ({ state: 'PendingPayment' }));
    const sleep = vi.fn(async () => { ac.abort(); });
    const out = await readOrderUntilSettled(read, ac.signal, { sleep });
    expect(out).toBeNull();
    expect(read).toHaveBeenCalledTimes(1); // no read after the abort
  });

  it('makes no request at all when already aborted, and passes the signal to read', async () => {
    const ac = new AbortController();
    ac.abort();
    const read = vi.fn(async () => ({ state: 'Paid' }));
    expect(await readOrderUntilSettled(read, ac.signal)).toBeNull();
    expect(read).not.toHaveBeenCalled();

    const live = new AbortController();
    const read2 = vi.fn(async (_s: AbortSignal) => ({ state: 'Paid' }));
    await readOrderUntilSettled(read2, live.signal);
    expect(read2).toHaveBeenCalledWith(live.signal);
  });
});

describe('sleepAbortable', () => {
  it('resolves early on abort and leaves no timer behind', async () => {
    vi.useFakeTimers();
    try {
      const ac = new AbortController();
      let resolved = false;
      const p = sleepAbortable(60_000, ac.signal).then(() => { resolved = true; });
      expect(vi.getTimerCount()).toBe(1);
      ac.abort();
      await p;
      expect(resolved).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it('resolves after the delay when not aborted', async () => {
    vi.useFakeTimers();
    try {
      const p = sleepAbortable(1500, new AbortController().signal);
      await vi.advanceTimersByTimeAsync(1500);
      await expect(p).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('resolveConfirmationEmail', () => {
  it('prefers the order contact email (where order mail is sent), then the account email', () => {
    expect(resolveConfirmationEmail({ customerEmail: 'acct@example.net', contactEmail: 'c@example.net' }, 'typed@example.net')).toBe('c@example.net');
    expect(resolveConfirmationEmail({ customerEmail: 'acct@example.net', contactEmail: null }, 'typed@example.net')).toBe('acct@example.net');
  });
  it('a guest order (no customer record) falls back to the order contact email, then the session email', () => {
    expect(resolveConfirmationEmail({ customerEmail: null, contactEmail: 'guest@example.net' }, 'typed@example.net')).toBe('guest@example.net');
    expect(resolveConfirmationEmail({ customerEmail: null }, 'typed@example.net')).toBe('typed@example.net');
  });
  it('is null when nothing names an address', () => {
    expect(resolveConfirmationEmail({ customerEmail: null }, '')).toBeNull();
    expect(resolveConfirmationEmail({}, undefined)).toBeNull();
  });
});
