import { describe, expect, it } from 'vitest';
import { cell } from './admin-reports.js';

// Security audit 2026-10-15: customers.csv / products.csv reuse the order export's formula-injection guard.
describe('admin CSV export cells', () => {
  it('neutralizes spreadsheet formulas in free-text strings', () => {
    expect(cell('=HYPERLINK("http://evil","x")')).toBe(`"'=HYPERLINK(""http://evil"",""x"")"`);
    expect(cell('+1+1')).toBe("'+1+1");
    expect(cell('-2+3')).toBe("'-2+3");
    expect(cell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(cell('\tcmd')).toBe("'\tcmd");
    // an embedded CR must be quoted, or a CR-as-record-separator reader starts a new, unguarded formula cell
    expect(cell('Alice\r=1+1')).toBe('"Alice\r=1+1"');
    expect(cell('\r=1+1')).toBe(`"'\r=1+1"`);
  });
  it('leaves ordinary text and numbers alone', () => {
    expect(cell('Alice')).toBe('Alice');
    expect(cell(-500)).toBe('-500');
    expect(cell(null)).toBe('');
    expect(cell('a,b')).toBe('"a,b"');
  });
});

describe('customers.csv serialization (through the real route)', () => {
  it('a name carrying CR + formula cannot create an unguarded cell', async () => {
    const { csv } = await import('./admin-reports.js');
    const out = csv(['email', 'firstName'], [['a@x.test', 'Alice\r=1+1'], ['b@x.test', '=cmd|calc']]);
    // the CR stays inside a quoted field (RFC 4180), so it cannot start a new record / cell
    expect(out.split('\n')[1]).toBe('a@x.test,"Alice\r=1+1"');
    expect(out.split('\n')[2]).toBe("b@x.test,'=cmd|calc");
  });
});
