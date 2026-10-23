import { describe, expect, it } from 'vitest';
import { formatOrderCode, orderCodeCandidates, orderCodePattern, orderNumberingError, parseOrderNumber, DEFAULT_ORDER_NUMBERING } from './order-number.js';

const fmt = (prefix = '', suffix = '', minDigits = 0) => ({ prefix, suffix, minDigits });

describe('formatOrderCode', () => {
  it('defaults to a bare number from 1001', () => {
    expect(formatOrderCode(DEFAULT_ORDER_NUMBERING, DEFAULT_ORDER_NUMBERING.nextNumber)).toBe('1001');
  });
  it('applies prefix, suffix and zero padding', () => {
    expect(formatOrderCode(fmt('DD'), 30306)).toBe('DD30306');
    expect(formatOrderCode(fmt('RH', '', 6), 1)).toBe('RH000001');
    expect(formatOrderCode(fmt('#'), 1001)).toBe('#1001');
    expect(formatOrderCode(fmt('SO-', '-US', 4), 42)).toBe('SO-0042-US');
  });
  it('never truncates a number wider than the padding', () => {
    expect(formatOrderCode(fmt('RH', '', 6), 1234567)).toBe('RH1234567');
  });
});

describe('orderCodePattern / parseOrderNumber', () => {
  it('round-trips formatted codes', () => {
    for (const [f, n] of [[fmt('DD'), 30306], [fmt('RH', '', 6), 1], [fmt('#'), 1001], [fmt('A.B/', '_x', 3), 7], [fmt(), 1001]] as const) {
      expect(parseOrderNumber(f, formatOrderCode(f, n))).toBe(n);
    }
  });
  it('escapes affix punctuation literally', () => {
    expect(orderCodePattern(fmt('A.', '-Z'))).toBe('^A\\.([0-9]+)\\-Z$');
    expect(parseOrderNumber(fmt('A.'), 'AX12')).toBeNull();
  });
  it('rejects codes in another format', () => {
    expect(parseOrderNumber(fmt('DD'), 'SRA15D5DCCC0')).toBeNull();
    expect(parseOrderNumber(fmt(), 'DD30287')).toBeNull();
    expect(parseOrderNumber(fmt('DD'), 'DD')).toBeNull();
    expect(parseOrderNumber(fmt('RH', '', 6), 'RH000012')).toBe(12);
  });
});

describe('orderNumberingError', () => {
  const ok = { ...DEFAULT_ORDER_NUMBERING };
  it('accepts the default and the issue examples', () => {
    expect(orderNumberingError(ok)).toBeNull();
    expect(orderNumberingError({ ...ok, prefix: 'DD', nextNumber: 30306 })).toBeNull();
    expect(orderNumberingError({ ...ok, prefix: 'RH', minDigits: 6, nextNumber: 1 })).toBeNull();
    expect(orderNumberingError({ ...ok, prefix: '#' })).toBeNull();
  });
  it('rejects ambiguous or unsafe formats', () => {
    expect(orderNumberingError({ ...ok, prefix: 'A1' })).toMatch(/end with a digit/);
    expect(orderNumberingError({ ...ok, suffix: '1A' })).toMatch(/start with a digit/);
    expect(orderNumberingError({ ...ok, prefix: 'a b' })).toMatch(/only letters/);
    expect(orderNumberingError({ ...ok, prefix: 'X'.repeat(17) })).toMatch(/at most 16/);
    expect(orderNumberingError({ ...ok, minDigits: 13 })).toMatch(/minimum digits/);
    expect(orderNumberingError({ ...ok, nextNumber: 0 })).toMatch(/next number/);
    expect(orderNumberingError({ ...ok, nextNumber: 1.5 })).toMatch(/next number/);
  });
});

describe('orderCodeCandidates', () => {
  it('tries the typed code first, then with and without a leading #, then upper-case', () => {
    expect(orderCodeCandidates(' 1001 ')).toEqual(['1001', '#1001']);
    expect(orderCodeCandidates('#1001')).toEqual(['#1001', '1001']);
    expect(orderCodeCandidates('dd30305')).toEqual(['dd30305', '#dd30305', 'DD30305', '#DD30305']);
    expect(orderCodeCandidates('#')).toEqual([]);
  });
});
