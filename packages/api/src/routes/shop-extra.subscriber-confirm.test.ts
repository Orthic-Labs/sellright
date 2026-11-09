import { describe, expect, it } from 'vitest';
import { subscriberRoutes } from './shop-extra.subscriber.js';

// The confirmation landing page is a plain GET that must never resolve a store or touch the database:
// link prefetchers hit it, and only the POST changes a subscription.
describe('GET /v1/shop/subscriber/confirm/:token', () => {
  it('returns a landing page with a POST form and performs no database work', async () => {
    const res = await subscriberRoutes.request('/v1/shop/subscriber/confirm/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const text = await res.text();
    expect(text).toContain('method="post"');
    expect(text).not.toContain('Subscription confirmed');
  });

  it('rejects a malformed token', async () => {
    const res = await subscriberRoutes.request('/v1/shop/subscriber/confirm/not-a-uuid');
    expect(res.status).toBe(400);
  });
});
