import { describe, expect, it, vi } from 'vitest';

vi.mock('../db/client.js', () => ({ withStore: vi.fn() }));

const { admitFeedBuild, FEED_MAX_CONCURRENT } = await import('./feeds.js');

describe('G3 feed build admission', () => {
  it('admits one build per store and at most FEED_MAX_CONCURRENT overall, releasing idempotently', () => {
    expect(FEED_MAX_CONCURRENT).toBe(2);
    const a = admitFeedBuild('store-a');
    expect(a).toBeTypeOf('function');
    expect(admitFeedBuild('store-a')).toBeNull();
    const b = admitFeedBuild('store-b');
    expect(b).toBeTypeOf('function');
    expect(admitFeedBuild('store-c')).toBeNull();
    a!(); a!();
    const c = admitFeedBuild('store-c');
    expect(c).toBeTypeOf('function');
    expect(admitFeedBuild('store-d')).toBeNull();
    b!(); c!();
    expect(admitFeedBuild('store-a')).toBeTypeOf('function');
  });
});
