import { describe, expect, it } from 'vitest';
import { rangeFor, upsertPreset } from './export-presets';

describe('export presets', () => {
  const now = new Date('2026-10-09T15:00:00Z');
  it('computes inclusive UTC ranges', () => {
    expect(rangeFor('last7', now)).toEqual({ from: '2026-10-03', to: '2026-10-09' });
    expect(rangeFor('thisMonth', now)).toEqual({ from: '2026-10-01', to: '2026-10-09' });
    expect(rangeFor('lastMonth', now)).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(rangeFor('thisYear', now)).toEqual({ from: '2026-01-01', to: '2026-10-09' });
    expect(rangeFor('all', now)).toEqual({ from: '', to: '' });
  });
  it('replaces a preset with the same name case-insensitively', () => {
    const a = { name: 'Ship', columns: ['code'], rows: 'order' as const };
    expect(upsertPreset([a], { ...a, name: 'ship', columns: ['code', 'sku'] })).toEqual([{ name: 'ship', columns: ['code', 'sku'], rows: 'order' }]);
  });
});
