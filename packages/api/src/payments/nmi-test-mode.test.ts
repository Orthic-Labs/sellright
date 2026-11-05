import { describe, expect, it } from 'vitest';
import { isNmiTestCard, nmiQueryShowsTestCard, nmiTestModeMark, NMI_TEST_CARDS } from './nmi-test-mode.js';
import { verifyNmiQuery } from './nmi-query.js';
import type { GatewayAccount } from './gateway-account.js';

// #378: DD30349 settled on NMI with 4111 1111 1111 1111 while the NMI account was in test mode but SellRight was configured live.
const live: GatewayAccount = { accountId: 'dd_nmi_live', storeId: 'dd', method: 'nmi', mode: 'live', securityKey: 'k', nmiEnvironment: 'production' };
const query = { account: live, orderReference: 'DD30349-abcd1234', providerRef: '12726027518', amount: 1234, currency: 'USD' };
const xml = (card: string) => '<nm_response><transaction><transaction_id>12726027518</transaction_id><order_id>DD30349-abcd1234</order_id>' +
  `<currency>USD</currency><condition>pendingsettlement</condition>${card}<action><action_type>sale</action_type>` +
  '<amount>12.34</amount><success>1</success></action></transaction></nm_response>';

describe('NMI test card detection (#378)', () => {
  it('recognises every documented NMI test card by BIN + last 4', () => {
    for (const { pan } of NMI_TEST_CARDS) {
      expect(isNmiTestCard(pan.slice(0, 6), pan.slice(-4))).toBe(true);
      expect(isNmiTestCard(pan.slice(0, 8), pan.slice(-4))).toBe(true);
    }
  });

  it('never classifies an ordinary card as test on a BIN or last-4 coincidence alone', () => {
    expect(isNmiTestCard('411111', '4242')).toBe(false); // test BIN, other tail
    expect(isNmiTestCard('424242', '1111')).toBe(false); // test tail, other BIN
    expect(isNmiTestCard('453201', '1111')).toBe(false);
    expect(isNmiTestCard('4111', '1111')).toBe(false); // BIN too short to prove anything
    expect(isNmiTestCard('41111x', '1111')).toBe(false);
  });

  it('reads Query API card fields: cc_bin, a partly masked number, a fully masked prefix', () => {
    expect(nmiQueryShowsTestCard({ ccBin: '411111', ccNumber: '4xxxxxxxxxxx1111' })).toBe(true);
    expect(nmiQueryShowsTestCard({ ccNumber: '411111******1111' })).toBe(true);
    expect(nmiQueryShowsTestCard({ ccNumber: '4xxxxxxxxxxx1111' })).toBe(false); // no BIN available
    expect(nmiQueryShowsTestCard({ ccBin: '453201', ccNumber: '4xxxxxxxxxxx1111' })).toBe(false);
    expect(nmiQueryShowsTestCard({})).toBe(false);
  });

  it('marks a settled live-account charge made with the test card as test mode', () => {
    const result = verifyNmiQuery(xml('<cc_bin>411111</cc_bin><cc_number>4xxxxxxxxxxx1111</cc_number>'), query);
    expect(result).toMatchObject({ state: 'Settled', providerRef: '12726027518', metadata: { testMode: { detected: true, source: 'query:documented-test-card' } } });
    expect(nmiTestModeMark(result.metadata)).toEqual({ detected: true, source: 'query:documented-test-card' });
  });

  it('leaves a real card, and a response with no card fields, unmarked', () => {
    for (const card of ['<cc_bin>453201</cc_bin><cc_number>4xxxxxxxxxxx1111</cc_number>', '<cc_bin>411111</cc_bin><cc_number>4xxxxxxxxxxx4242</cc_number>', '']) {
      const result = verifyNmiQuery(xml(card), query);
      expect(result.state).toBe('Settled');
      expect(result.metadata).not.toHaveProperty('testMode');
      expect(nmiTestModeMark(result.metadata)).toBeNull();
    }
  });

  it('ignores a malformed or unsourced test mark', () => {
    for (const metadata of [null, {}, { testMode: {} }, { testMode: { detected: 'yes', source: 'x' } }, { testMode: { detected: true } }]) {
      expect(nmiTestModeMark(metadata)).toBeNull();
    }
  });
});
