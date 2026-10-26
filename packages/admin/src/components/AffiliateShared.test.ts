import { describe, expect, it } from 'vitest';
import { affiliateDashboardLink, filterAndSort, type Aff } from './AffiliateShared';

const row = (o: Partial<Aff> & { email: string }): Aff => ({
  id: o.email, code: 'CODE', status: 'Active', earned: 0, settled: 0, unsettled: 0, orders: 0, lastSettledAt: null, ...o,
});
const ROWS: Aff[] = [
  row({ email: 'ann@x.test', code: 'ANN10', unsettled: 500, lastSettledAt: '2026-03-01T00:00:00Z' }),
  row({ email: 'bob@x.test', code: 'BOB15', unsettled: 1200, status: 'Disabled' }),
  row({ email: 'cy@x.test', code: 'CYRUS', unsettled: 0, lastSettledAt: '2026-05-01T00:00:00Z' }),
];
const emails = (r: Aff[]) => r.map((x) => x.email);

describe('affiliate list filter + sort', () => {
  it('defaults to active-only; All includes disabled', () => {
    expect(emails(filterAndSort(ROWS, { search: '', activeOnly: true, key: 'unsettled', dir: 'desc' }))).toEqual(['ann@x.test', 'cy@x.test']);
    expect(emails(filterAndSort(ROWS, { search: '', activeOnly: false, key: 'unsettled', dir: 'desc' }))).toEqual(['bob@x.test', 'ann@x.test', 'cy@x.test']);
  });

  it('searches email and code, case-insensitively', () => {
    expect(emails(filterAndSort(ROWS, { search: 'BOB', activeOnly: false, key: 'email', dir: 'asc' }))).toEqual(['bob@x.test']);
    expect(emails(filterAndSort(ROWS, { search: 'cyr', activeOnly: false, key: 'email', dir: 'asc' }))).toEqual(['cy@x.test']);
  });

  it('sorts numeric and text columns both ways, with never-settled last', () => {
    expect(emails(filterAndSort(ROWS, { search: '', activeOnly: false, key: 'email', dir: 'desc' }))).toEqual(['cy@x.test', 'bob@x.test', 'ann@x.test']);
    expect(emails(filterAndSort(ROWS, { search: '', activeOnly: false, key: 'lastSettledAt', dir: 'desc' }))).toEqual(['cy@x.test', 'ann@x.test', 'bob@x.test']);
    expect(emails(filterAndSort(ROWS, { search: '', activeOnly: false, key: 'lastSettledAt', dir: 'asc' }))).toEqual(['ann@x.test', 'cy@x.test', 'bob@x.test']);
  });
});

describe('affiliateDashboardLink', () => {
  it('puts the token in the fragment, never the query string', () => {
    const link = affiliateDashboardLink('https://shop.test', 'tok123');
    expect(link).toBe('https://shop.test/affiliate#t=tok123');
    expect(link).not.toContain('?t=');
  });
});
