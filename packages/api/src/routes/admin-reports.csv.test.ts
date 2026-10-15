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
  });
  it('leaves ordinary text and numbers alone', () => {
    expect(cell('Alice')).toBe('Alice');
    expect(cell(-500)).toBe('-500');
    expect(cell(null)).toBe('');
    expect(cell('a,b')).toBe('"a,b"');
  });
});
