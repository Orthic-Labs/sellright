import { describe, expect, it } from 'vitest';
import { parseSummary } from './tracking';

describe('parseSummary (#376)', () => {
  it('says which columns were read and what was left out', () => {
    expect(parseSummary({ titleSkipped: true, header: ['Owner', 'OrderId', 'shpack_trackingid'], columns: { order: 'OrderId', tracking: 'shpack_trackingid', carrier: null }, skipped: { blank: 3, amazon: 1, duplicate: 2 } }))
      .toBe('Order numbers from "OrderId", tracking from "shpack_trackingid", carrier detected from the number. The title line was skipped. Left out: 3 without an order or tracking number, 1 Amazon order, 2 repeated.');
    expect(parseSummary({ titleSkipped: false, header: null, columns: { order: 'column 1', tracking: 'column 2', carrier: 'column 3' }, skipped: { blank: 0, amazon: 0, duplicate: 0 } }))
      .toBe('Order numbers from "column 1", tracking from "column 2", carrier from "column 3".');
  });
});
