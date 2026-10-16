import { describe, expect, it } from 'vitest';
import { nextSort, waitlistQuery } from './waitlist';

describe('waitlist helpers', () => {
  it('builds the query with optional dates', () => {
    expect(waitlistQuery({ from: '', to: '', groupBy: 'variant', sort: 'pending', dir: 'desc' })).toBe('groupBy=variant&sort=pending&dir=desc');
    expect(waitlistQuery({ from: '2026-10-01', to: '2026-10-09', groupBy: 'product', sort: 'total', dir: 'asc' })).toBe('from=2026-10-01&to=2026-10-09&groupBy=product&sort=total&dir=asc');
  });
  it('flips direction on the active column and picks a sensible default on a new one', () => {
    expect(nextSort({ sort: 'pending', dir: 'desc' }, 'pending')).toEqual({ sort: 'pending', dir: 'asc' });
    expect(nextSort({ sort: 'pending', dir: 'asc' }, 'pending')).toEqual({ sort: 'pending', dir: 'desc' });
    expect(nextSort({ sort: 'pending', dir: 'desc' }, 'product')).toEqual({ sort: 'product', dir: 'asc' });
    expect(nextSort({ sort: 'product', dir: 'asc' }, 'total')).toEqual({ sort: 'total', dir: 'desc' });
  });
});
