import { describe, expect, it } from 'vitest';
import { inferCarrier, toCsv } from './carrier';

describe('carrier', () => {
  it('detects UPS, USPS and FedEx', () => {
    expect(inferCarrier('1Z999AA10123456784')).toBe('UPS');
    expect(inferCarrier('9400 1118 9922 3817 2000 00')).toBe('USPS');
    expect(inferCarrier('123456789012')).toBe('FedEx');
    expect(inferCarrier('hello')).toBeNull();
  });
  it('quotes csv cells', () => { expect(toCsv([['a,b', 'c"d']])).toBe('"a,b","c""d"'); });
});
