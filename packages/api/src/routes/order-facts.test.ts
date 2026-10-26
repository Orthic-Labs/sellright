import { describe, expect, it } from 'vitest';
import { cardFactsFromMetadata, summarizeOrderForList, type OrderFulfillmentFact, type OrderLineFact } from './order-facts.js';

describe('cardFactsFromMetadata', () => {
  it('reads brand + last4 from metadata.card and ignores everything else', () => {
    expect(cardFactsFromMetadata({ card: { brand: 'Visa', last4: '1234' }, avs: 'Y', cvv: 'M', authCode: 'X' })).toEqual({ cardBrand: 'Visa', cardLast4: '1234' });
  });
  it('accepts the pre-SellRight public.{cardType,last4} pair on imported payments', () => {
    expect(cardFactsFromMetadata({ public: { cardType: 'Mastercard', last4: '9999' } })).toEqual({ cardBrand: 'Mastercard', cardLast4: '9999' });
  });
  it('never exposes more than four digits, a placeholder, or half a pair', () => {
    expect(cardFactsFromMetadata({ card: { brand: 'Visa', last4: '411111111111' } })).toEqual({ cardBrand: null, cardLast4: null });
    expect(cardFactsFromMetadata({ public: { cardType: 'Credit Card', last4: 'xxxx' } })).toEqual({ cardBrand: null, cardLast4: null });
    expect(cardFactsFromMetadata({ card: { last4: '1234' } })).toEqual({ cardBrand: null, cardLast4: null });
    expect(cardFactsFromMetadata(null)).toEqual({ cardBrand: null, cardLast4: null });
    expect(cardFactsFromMetadata('4111111111111111')).toEqual({ cardBrand: null, cardLast4: null });
  });
});

const line = (over: Partial<OrderLineFact>): OrderLineFact => ({
  sku: 'S', name: 'N', productName: null, quantity: 1, unitPrice: 100, lineTotal: 100, image: null, isPreOrder: false, shipDate: null, shipDateLabel: null, productSlug: null, ...over,
});
const ful = (over: Partial<OrderFulfillmentFact>): OrderFulfillmentFact => ({ state: 'Shipped', trackingCode: null, carrier: null, updatedAt: null, ...over });

describe('summarizeOrderForList', () => {
  it('is empty for a plain, unshipped order', () => {
    expect(summarizeOrderForList([line({})], [])).toEqual({ trackingCode: null, carrier: null, isPreOrder: false, shipDate: null, shipDateLabel: null });
  });
  it('takes the newest fulfilment that has a tracking code (input is newest first)', () => {
    expect(summarizeOrderForList([], [ful({}), ful({ trackingCode: 'T2', carrier: 'FedEx' }), ful({ trackingCode: 'T1', carrier: 'UPS' })]))
      .toMatchObject({ trackingCode: 'T2', carrier: 'FedEx' });
  });
  it('uses the LATEST pre-order ship date and dedupes the labels', () => {
    const out = summarizeOrderForList([
      line({ isPreOrder: true, shipDate: '2027-01-01T00:00:00.000Z', shipDateLabel: 'Early 2027' }),
      line({ isPreOrder: true, shipDate: '2027-05-01T00:00:00.000Z', shipDateLabel: 'Early 2027' }),
      line({ isPreOrder: false, shipDate: '2030-01-01T00:00:00.000Z' }),
    ], []);
    expect(out).toMatchObject({ isPreOrder: true, shipDate: '2027-05-01T00:00:00.000Z', shipDateLabel: 'Early 2027' });
  });
});
