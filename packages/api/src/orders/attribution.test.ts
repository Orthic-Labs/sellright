import { describe, expect, it } from 'vitest';
import { ATTRIBUTION_MAX_CHARS, normalizeAttribution, OrderAttributionIn, orderAttribution } from './attribution.js';

describe('order attribution', () => {
  it('accepts the allowlisted keys and refuses unknown keys, long values and control characters', () => {
    expect(OrderAttributionIn.safeParse({ utm_source: 'chatgpt', utm_medium: 'cpc', utm_campaign: 'c', utm_content: 'x', utm_term: 't', oppref: 'o' }).success).toBe(true);
    expect(OrderAttributionIn.safeParse({ fbclid: 'x' }).success).toBe(false);
    expect(OrderAttributionIn.safeParse({ utm_source: 'a'.repeat(ATTRIBUTION_MAX_CHARS + 1) }).success).toBe(false);
    expect(OrderAttributionIn.safeParse({ utm_source: 'a\u0000b' }).success).toBe(false);
  });

  it('normalizes: trims, drops empties, non-strings and unknown keys; null when nothing remains', () => {
    expect(normalizeAttribution({ utm_source: ' chatgpt ', utm_medium: '', oppref: 7, other: 'x' })).toEqual({ utm_source: 'chatgpt' });
    expect(normalizeAttribution({ utm_medium: '  ' })).toBeNull();
    expect(normalizeAttribution(null)).toBeNull();
    expect(normalizeAttribution(['utm_source'])).toBeNull();
  });

  it('reads back from order metadata, re-validating what is stored', () => {
    expect(orderAttribution({ attribution: { utm_campaign: 'rh', injected: '<x>' } })).toEqual({ utm_campaign: 'rh' });
    expect(orderAttribution({ contact: {} })).toBeNull();
    expect(orderAttribution(null)).toBeNull();
  });
});
