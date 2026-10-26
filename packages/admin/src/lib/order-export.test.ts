import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, EXPORT_COLUMNS, exportQuery, moveColumn, normalizePresets, normalizeSettings } from './order-export';

describe('order export settings (#381)', () => {
  it('defaults: open orders, one row per line item, XLSX, every previous-admin column in order', () => {
    expect(DEFAULT_SETTINGS.statuses).toEqual(['PaymentAuthorized', 'Processing', 'Pre-ordered', 'PartiallyShipped', 'Modifying', 'ArrangingAdditionalPayment']);
    expect([DEFAULT_SETTINGS.rows, DEFAULT_SETTINGS.format]).toEqual(['line', 'xlsx']);
    expect(DEFAULT_SETTINGS.columns.map((c) => c.key)).toEqual(EXPORT_COLUMNS.map((c) => c.key));
    expect(EXPORT_COLUMNS).toHaveLength(23);
  });

  it('restores a saved value safely: unknown entries dropped, new columns appended, order kept', () => {
    const s = normalizeSettings({ statuses: ['Shipped', 'Bogus'], fromDate: '2026-10-01', toDate: 'nope', rows: 'order', format: 'csv',
      columns: [{ key: 'email', on: true }, { key: 'orderCode', on: false }, { key: 'bogus', on: true }] });
    expect(s.statuses).toEqual(['Shipped']);
    expect([s.fromDate, s.toDate, s.rows, s.format]).toEqual(['2026-10-01', '', 'order', 'csv']);
    expect(s.columns.slice(0, 3)).toEqual([{ key: 'email', on: true }, { key: 'orderCode', on: false }, { key: 'orderStatus', on: true }]);
    expect(s.columns).toHaveLength(23);
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(normalizePresets([{ name: ' Picking ', settings: { rows: 'line' } }, { name: '' }, 5])).toEqual([{ name: 'Picking', settings: normalizeSettings({ rows: 'line' }) }]);
  });

  it('moves columns and builds the count / download query', () => {
    const cols = moveColumn(DEFAULT_SETTINGS.columns, 1, -1);
    expect(cols.slice(0, 2).map((c) => c.key)).toEqual(['orderStatus', 'orderCode']);
    expect(moveColumn(cols, 0, -1)).toBe(cols);
    const s = { ...DEFAULT_SETTINGS, statuses: ['Shipped'], fromDate: '2026-10-01', columns: [{ key: 'email', on: true }, { key: 'sku', on: false }, { key: 'orderCode', on: true }] };
    expect(exportQuery(s, false)).toBe('statuses=Shipped&fromDate=2026-10-01');
    expect(exportQuery(s, true)).toBe('statuses=Shipped&fromDate=2026-10-01&rows=line&format=xlsx&columns=email%2CorderCode');
  });
});
