import { describe, expect, it } from 'vitest';
import { parseOnHand, parsePercentBps, parseSignedMoney } from './page-parsers';

describe('parsePercentBps', () => {
  it('accepts plain percents', () => {
    expect(parsePercentBps('8')).toBe(800);
    expect(parsePercentBps('8.25')).toBe(825);
    expect(parsePercentBps(' 0.5 ')).toBe(50);
  });
  it('rejects anything else', () => {
    for (const bad of ['', '8,5', '-1', '1e2', '8.', '.5', '8.255', 'abc', '8%']) expect(parsePercentBps(bad)).toBeNull();
  });
});

describe('parseOnHand', () => {
  it('accepts integers of 0 or more', () => {
    expect(parseOnHand('0')).toBe(0);
    expect(parseOnHand('12')).toBe(12);
  });
  it('rejects empty, negative, fractional', () => {
    for (const bad of ['', ' ', '-3', '1.5', '1e3', 'x']) expect(parseOnHand(bad)).toBeNull();
  });
});

describe('parseSignedMoney', () => {
  it('parses signed amounts to cents', () => {
    expect(parseSignedMoney('+5.00')).toBe(500);
    expect(parseSignedMoney('-5')).toBe(-500);
    expect(parseSignedMoney('12.5')).toBe(1250);
  });
  it('rejects empty, zero and malformed', () => {
    for (const bad of ['', '+', '-', '0', '1,000', '1.234', 'abc', '--5']) expect(parseSignedMoney(bad)).toBeNull();
  });
});
