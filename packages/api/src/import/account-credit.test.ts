import { describe, expect, it } from 'vitest';
import { migrationId } from './context.js';
import { digest } from './artifacts.js';
import { buildImportedEditBasis } from './history.js';
import { assertCreditAccountMapping, buildCreditAccounts, buildCreditTransactions, parseCreditAllocation, validateCreditHistory,
  type SourceCredit, type SourceCreditPromotion, type SourceCreditTransaction, type CreditSourceGraph, type CreditTargetGraph } from './account-credit.js';
import { assertSourceSchema, OPTIONAL_SOURCE_TABLES, REQUIRED_SOURCE_COLUMNS } from './source-schema.js';

const storeId = '11111111-1111-4111-8111-111111111111';
const otherStoreId = '22222222-2222-4222-8222-222222222222';
const sourceKey = 'synthetic-credit';
const id = (entity: string, source: unknown) => migrationId(storeId, sourceKey, entity, source);
const ctx = { storeId, sourceKey, channelId: 1, currency: 'USD', id };
const credit = (overrides: Partial<SourceCredit> = {}): SourceCredit => ({ id: '1', promotionId: '5', channelId: '1',
  emailNormalized: 'private-issuance@example.test', issuanceKey: 'synthetic-issuance', currency: 'USD', initialAmount: 1000,
  balance: 900, disabled: false, sourceRecord: '{"id":1,"balance":900,"opaque":900719925474099312345}',
  sourceCreatedAt: '2020-02-03 12:04:05.123456', sourceUpdatedAt: '2020-02-04 12:04:05.654321', ...overrides });
const promotion = (overrides: Partial<SourceCreditPromotion> = {}): SourceCreditPromotion => ({ id: '5', code: 'CREDIT-SYNTHETIC', enabled: true,
  deletedAt: null, startsAt: null, endsAt: null, usageLimit: null, perCustomerUsageLimit: null, priority: 10,
  conditions: '[{"code":"account_credit_eligible","args":[]}]', actions: '[{"code":"account_credit_discount","args":[]}]',
  sourceRecord: '{"id":5,"opaque":900719925474099312345}', ...overrides });
const transaction = (overrides: Partial<SourceCreditTransaction> = {}): SourceCreditTransaction => ({ id: '2', accountCreditId: '1',
  kind: 'REDEEM', status: 'POSTED', amount: 100, delta: -100, balanceAfter: 900, relatedTransactionId: '1', idempotencyKey: 'redeem:synthetic',
  reason: 'Synthetic settlement', actor: null, orderId: '10', orderCode: 'SYNTHETIC', refundId: null, orderLineId: null, quantity: null,
  allocation: '{ "40": [60, 40] }', sourceRecord: '{"id":2,"opaque":900719925474099312345}',
  sourceCreatedAt: '2020-02-04 12:04:05.123456', sourceUpdatedAt: '2020-02-04 12:04:05.654321', ...overrides });
const issue = () => transaction({ id: '1', kind: 'ISSUE', amount: 1000, delta: 1000, balanceAfter: 1000,
  relatedTransactionId: null, idempotencyKey: 'issue:synthetic', orderId: null, orderCode: null, allocation: null });
const source = (): CreditSourceGraph => ({ orders: new Map([['10', { selected: true, hasChannel: true }]]),
  lines: new Map([['40', '10']]), refunds: new Map([['50', '10']]) });
const target = (): CreditTargetGraph => ({ orders: new Map([[id('order', '10'), { id: id('order', '10'), storeId }]]),
  lines: new Map([[id('order-line', '40'), { id: id('order-line', '40'), storeId, orderId: id('order', '10') }]]),
  refunds: new Map([[id('refund', '50'), { id: id('refund', '50'), storeId, orderId: id('order', '10') }]]) });
const build = (transactions = [issue(), transaction()], src = source(), dst = target()) => buildCreditTransactions(ctx, [credit()], transactions, src, dst);

function quarantinedMetadata() {
  const capture = buildImportedEditBasis({ ...ctx, channelId: '1',
    orders: [{ id: '10', selected: true, sourceRecord: '{"id":10,"exact":900719925474099312345}',
      subTotal: '100', subTotalWithTax: '100', shipping: '0', shippingWithTax: '0' }],
    lines: [{ id: '40', orderId: '10', shippingLineId: null, sourceRecord: '{"id":40,"orderId":10,"shippingLineId":null}' }],
    shippingLines: [], shippingMethods: [], surcharges: [],
    channels: [{ id: '1', sourceRecord: '{"id":1,"defaultCurrencyCode":"USD","pricesIncludeTax":false,"defaultTaxZoneId":null}' }],
    orderChannels: [{ orderId: '10', channelId: '1', sourceRecord: '{"orderId":10,"channelId":1}' }],
    targetOrders: [{ id: id('order', '10'), storeId, metadata: { vendure: { id: 10, sourceKey, chargeProjectionV1: { status: 'unresolved' } } } }],
    targetLines: [{ id: id('order-line', '40'), storeId, orderId: id('order', '10'), metadata: { vendure: { id: 40 } } }],
  })[0]!;
  return { vendure: { id: 10, sourceKey, retainedHistoryV1: capture.retainedHistoryV1!,
    financialReconciliationV1: capture.financialReconciliationV1! } };
}
function quarantinedTarget(metadata: unknown = quarantinedMetadata()): CreditTargetGraph {
  return { ...target(), orders: new Map([[id('order', '10'), { id: id('order', '10'), storeId, currency: 'USD', metadata }]]) };
}

describe('monetary credit import', () => {
  it('retains 142 accounts/promotions & 168 historical rows, including 9 zero balances & soft deletion', () => {
    const credits: SourceCredit[] = [], promos: SourceCreditPromotion[] = [], transactions: SourceCreditTransaction[] = [];
    for (let index = 0; index < 142; index++) {
      const key = String(index + 1), zero = index < 9;
      credits.push(credit({ id: key, promotionId: key, issuanceKey: 'issue-' + key, initialAmount: 100, balance: zero ? 0 : 100 }));
      promos.push(promotion({ id: key, code: 'CODE-' + key, deletedAt: index === 0 ? '2020-04-01 12:00:00' : null }));
      transactions.push(transaction({ id: String(transactions.length + 1), accountCreditId: key, kind: 'ISSUE', amount: 100, delta: 100,
        balanceAfter: 100, relatedTransactionId: null, idempotencyKey: 'issue-' + key, orderId: null, allocation: null }));
      if (zero) transactions.push(transaction({ id: String(transactions.length + 1), accountCreditId: key, amount: 100, delta: -100,
        balanceAfter: 0, relatedTransactionId: null, idempotencyKey: 'redeem-' + key, allocation: '{"40":[100]}' }));
    }
    for (let index = 0; index < 17; index++) transactions.push(transaction({ id: String(transactions.length + 1), kind: 'DISABLE',
      amount: 0, delta: 0, balanceAfter: 0, relatedTransactionId: null, idempotencyKey: 'status-' + index, orderId: null, allocation: null }));
    const accounts = buildCreditAccounts(ctx, credits, promos);
    expect(accounts.accountRows).toHaveLength(142);
    expect(accounts.accountRows.filter(row => row.balance === 0)).toHaveLength(9);
    expect(accounts.promotionRows.filter(row => row.enabled)).toHaveLength(141);
    expect(accounts.promotionRows[0]).toMatchObject({ type: 'account_credit', value: 0, enabled: false });
    expect(accounts.accountRows.filter(row => row.balance! > 0)).toHaveLength(133);
    expect(buildCreditTransactions(ctx, credits, transactions, source(), target()).rows).toHaveLength(168);
  });

  it('preserves exact private text, normalized issuance email, source time & dynamic coupon identity without inventing restrictions', () => {
    const result = buildCreditAccounts(ctx, [credit()], [promotion()]);
    expect(result.accountRows[0]).toMatchObject({ balance: 900, initialAmount: 1000, sourceRecord: credit().sourceRecord,
      sourcePromotionRecord: promotion().sourceRecord, emailNormalized: credit().emailNormalized, sourceCreatedAt: credit().sourceCreatedAt });
    expect(result.promotionRows[0]).toMatchObject({ code: promotion().code, type: 'account_credit', value: 0, conditions: [],
      startsAt: null, endsAt: null, usageLimit: null, perCustomerUsageLimit: null, priority: 10 });
    const history = build().rows[1]!;
    expect(history).toMatchObject({ allocation: '{ "40": [60, 40] }', sourceRecord: transaction().sourceRecord,
      sourceCreatedAt: transaction().sourceCreatedAt, operationalAllocation: { [id('order-line', '40')]: [60, 40] } });
  });

  it('uses exact delta sums & allocation amounts, rejects unsafe numeric transport', () => {
    expect(() => validateCreditHistory([credit({ balance: 901 })], [issue(), transaction()])).toThrow(/historical deltas/);
    expect(() => build([issue(), transaction({ allocation: '{"40":[59,40]}' })])).toThrow(/redemption amount/);
    expect(() => parseCreditAllocation('{"40":[9007199254740993]}')).toThrow(/allocation/);
    expect(() => buildCreditAccounts(ctx, [credit({ balance: Number.MAX_SAFE_INTEGER })], [promotion()])).toThrow(/Invalid source credit/);
    expect(() => build([issue(), transaction({ status: 'UNKNOWN' })])).toThrow(/Invalid source credit transaction/);
  });

  it('keeps proven absent original order refs private & blocks incomplete or wrong-order operational allocation maps', () => {
    const orphan = build([issue(), transaction({ orderId: '99', allocation: null, kind: 'ADJUST' })]);
    expect(orphan.rows[1]).toMatchObject({ sourceOrderId: '99', orderId: null });
    expect(orphan.exclusions[0]).toMatchObject({ blocking: false, detail: expect.stringContaining('source_order_absent') });
    const absentLine = build([issue(), transaction({ allocation: '{"41":[100]}' })]);
    expect(absentLine.rows[1]).toMatchObject({ allocation: '{"41":[100]}', operationalAllocation: null, orderId: id('order', '10') });
    expect(absentLine.exclusions[0]).toMatchObject({ blocking: true, detail: expect.stringContaining('source_allocation_line_absent') });
    const wrongOrder = build([issue(), transaction()], { ...source(), lines: new Map([['40', '11']]) });
    expect(wrongOrder.rows[1]!.operationalAllocation).toBeNull();
    const uncapturedButPresent = build([issue(), transaction({ allocation: '{"999":[100]}' })],
      { ...source(), lines: new Map([['999', '10']]) },
      { ...target(), lines: new Map([[id('order-line', '999'), { id: id('order-line', '999'), storeId, orderId: id('order', '10') }]]) });
    expect(uncapturedButPresent.rows[1]!.operationalAllocation).toEqual({ [id('order-line', '999')]: [100] });
  });

  it('refuses wrong-store native links, source channel collisions & source related-link account mismatches', () => {
    expect(() => build([issue(), transaction()], source(), { ...target(), orders: new Map([[id('order', '10'), { id: id('order', '10'), storeId: otherStoreId }]]) })).toThrow(/Cross-store/);
    expect(() => build([issue(), transaction()], source(), { ...target(), orders: new Map([[id('order', '10'), { id: id('order', '11'), storeId }]]) })).toThrow(/wrong-order/);
    expect(() => build([issue(), transaction()], source(), { ...target(), lines: new Map([[id('order-line', '40'), { id: id('order-line', '40'), storeId: otherStoreId, orderId: id('order', '10') }]]) })).toThrow(/Cross-store/);
    expect(() => buildCreditAccounts(ctx, [credit({ channelId: '2' })], [promotion()])).toThrow(/another source channel/);
    expect(() => build([issue(), transaction({ relatedTransactionId: '99' })])).toThrow(/Related source credit/);
    expect(() => buildCreditAccounts(ctx, [credit(), credit({ id: '2', issuanceKey: 'other' })], [promotion()])).toThrow(/Conflicting/);
    const account = { id: id('account-credit', '1'), storeId, sourceKey, sourceId: '1' };
    expect(() => assertCreditAccountMapping(ctx, [credit()], [account])).not.toThrow();
    expect(() => assertCreditAccountMapping(ctx, [credit()], [{ ...account, storeId: otherStoreId }])).toThrow(/source\/tenant/);
    expect(() => assertCreditAccountMapping(ctx, [credit()], [{ ...account, sourceKey: 'other-source' }])).toThrow(/source\/tenant/);
  });

  it('retains a proven historical absent allocation only under full financial quarantine without inventing restoration units', () => {
    const historical = transaction({ allocation: '{ "41": [60, 40] }' });
    const metadata = quarantinedMetadata(), before = structuredClone(metadata);
    const result = build([issue(), historical], source(), quarantinedTarget(metadata));
    expect(result.rows[1]).toMatchObject({ amount: 100, delta: -100, balanceAfter: 900,
      orderId: id('order', '10'), sourceOrderId: '10', sourceId: '2',
      allocation: historical.allocation, operationalAllocation: null, orderLineId: null, refundId: null,
      sourceRecord: historical.sourceRecord, relatedTransactionId: id('account-credit-transaction', '1'),
      sourceDigest: digest({ format: 'retained-pg-jsonb-text-v1', transaction: historical.sourceRecord }) });
    expect(result.rows.reduce((total, row) => total + row.delta!, 0)).toBe(credit().balance);
    expect(result.exclusions).toEqual([expect.objectContaining({ blocking: false,
      reason: 'CREDIT_ALLOCATION_LINE_ABSENT', reviewRequired: true,
      sourceValues: [JSON.stringify({ sourceId: '2', sourceOrderId: '10', missingSourceLineIds: ['41'] })] })]);
    expect(metadata).toEqual(before);
    expect(metadata.vendure.retainedHistoryV1.sourceOrderRecord).toContain('900719925474099312345');
    expect(metadata.vendure.financialReconciliationV1.sourceDigest).toBe(metadata.vendure.retainedHistoryV1.sourceDigest);
  });

  it('retains exact unlinked posted debits when parent & every allocation line are globally absent', () => {
    const transactions = [issue(), transaction({ amount: 500, delta: -500, balanceAfter: 500, orderId: '99', allocation: '{ "41": [500] }' }),
      transaction({ id: '3', amount: 500, delta: -500, balanceAfter: 0, orderId: '100', allocation: '{"42":[250,250]}',
        relatedTransactionId: '2', sourceRecord: '{"id":3,"opaque":900719925474099312345}' })];
    const src = source(), dst = target(), before = structuredClone({ src, dst });
    const result = buildCreditTransactions(ctx, [credit({ balance: 0 })], transactions, src, dst);
    expect(result.rows.map(row => row.delta)).toEqual([1000, -500, -500]);
    expect(result.rows.map(row => row.balanceAfter)).toEqual([1000, 500, 0]);
    expect(result.rows.reduce((total, row) => total + row.delta!, 0)).toBe(0);
    for (const [index, row] of result.rows.slice(1).entries()) {
      const raw = transactions[index + 1]!;
      expect(row).toMatchObject({ sourceOrderId: raw.orderId, sourceId: raw.id,
        orderId: null, refundId: null, orderLineId: null, operationalAllocation: null,
        allocation: raw.allocation, sourceRecord: raw.sourceRecord,
        relatedTransactionId: id('account-credit-transaction', raw.relatedTransactionId),
        sourceDigest: digest({ format: 'retained-pg-jsonb-text-v1', transaction: raw.sourceRecord }) });
    }
    expect(result.exclusions).toHaveLength(4);
    expect(result.exclusions.every(row => row.blocking === false)).toBe(true);
    expect(result.exclusions).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'SOURCE_ORDER_ABSENT', reviewRequired: true,
        sourceValues: [JSON.stringify({ sourceId: '2', sourceOrderId: '99' })] }),
      expect.objectContaining({ reason: 'CREDIT_ALLOCATION_LINE_ABSENT', reviewRequired: true,
        sourceValues: [JSON.stringify({ sourceId: '3', sourceOrderId: '100', missingSourceLineIds: ['42'] })] }),
    ]));
    expect({ src, dst }).toEqual(before);
  });

  it('does not waive unresolved, present or partially mapped references for unlinked credit history', () => {
    const historical = transaction({ orderId: '99', allocation: '{"41":[100]}' });
    const cases = [
      { tx: historical, src: { ...source(), lines: new Map([['41', null]]) }, dst: target() },
      { tx: historical, src: { ...source(), lines: new Map([['41', '10']]) }, dst: target() },
      { tx: historical, src: { ...source(), orders: new Map([['99', { selected: true, hasChannel: true }]]) }, dst: target() },
      { tx: historical, src: { ...source(), orders: new Map([['99', { selected: false, hasChannel: true }]]) }, dst: target() },
      { tx: historical, src: source(), dst: { ...target(), orders: new Map([[id('order', '99'), { id: id('order', '99'), storeId: otherStoreId }]]) } },
      ...[{ quantity: 1 }, { status: 'PENDING' }, { kind: 'RESERVE', status: 'PENDING' },
        { orderId: null }, { orderLineId: '41' }, { refundId: '50' }]
        .map(change => ({ tx: { ...historical, ...change }, src: source(), dst: target() })),
    ];
    for (const { tx, src, dst } of cases) {
      const result = build([issue(), tx], src, dst);
      expect(result.exclusions.some(row => row.blocking === true)).toBe(true);
      expect(result.exclusions).not.toContainEqual(expect.objectContaining({ reason: 'CREDIT_ALLOCATION_LINE_ABSENT' }));
      expect(result.rows[1]!.operationalAllocation).toBeNull();
    }
    const wrongDelta = buildCreditTransactions(ctx, [credit({ balance: 901 })], [issue(), { ...historical, delta: -99 }], source(), target());
    expect(wrongDelta.exclusions.some(row => row.blocking === true)).toBe(true);
    const zeroDebit = buildCreditTransactions(ctx, [credit({ balance: 1000 })],
      [issue(), { ...historical, amount: 0, delta: 0, balanceAfter: 1000, allocation: '{"41":[0]}' }], source(), target());
    expect(zeroDebit.exclusions.some(row => row.blocking === true)).toBe(true);
    for (const account of [credit({ channelId: '2' }), credit({ currency: 'EUR' })]) {
      const result = buildCreditTransactions(ctx, [account], [issue(), historical], source(), target());
      expect(result.exclusions.some(row => row.blocking === true)).toBe(true);
    }
    expect(() => build([issue(), { ...historical, allocation: '{"41":[99]}' }])).toThrow(/redemption amount/);
    expect(() => build([issue(), { ...historical, relatedTransactionId: '99' }])).toThrow(/Related source credit/);
  });

  it('does not turn unknown allocation or parent evidence into a retained historical exception', () => {
    const metadata = quarantinedMetadata(), parent = metadata.vendure;
    const invalidParents: unknown[] = [undefined,
      { vendure: { ...parent, editBasisV1: {} } },
      { vendure: { ...parent, sourceKey: 'another-source' } },
      { vendure: { ...parent, retainedHistoryV1: { ...parent.retainedHistoryV1, sourceOrderRecord: '{"id":10}' } } },
      { vendure: { ...parent, financialReconciliationV1: { ...parent.financialReconciliationV1, sourceDigest: '0'.repeat(64) } } },
      { vendure: { ...parent, financialReconciliationV1: { ...parent.financialReconciliationV1, status: 'resolved' } } },
    ];
    for (const invalid of invalidParents) {
      const result = build([issue(), transaction({ allocation: '{"41":[100]}' })], source(), quarantinedTarget(invalid ?? {}));
      expect(result.rows[1]).toMatchObject({ orderId: id('order', '10'), operationalAllocation: null });
      expect(result.exclusions.some(row => row.blocking === true)).toBe(true);
      expect(result.exclusions).not.toContainEqual(expect.objectContaining({ reason: 'CREDIT_ALLOCATION_LINE_ABSENT' }));
    }
    for (const src of [
      { ...source(), lines: new Map([['41', null]]) },
      { ...source(), lines: new Map([['41', '11']]) },
      { ...source(), lines: new Map([['41', '10']]) },
    ]) {
      const result = build([issue(), transaction({ allocation: '{"41":[100]}' })], src, quarantinedTarget());
      expect(result.exclusions.some(row => row.blocking === true)).toBe(true);
      expect(result.rows[1]!.operationalAllocation).toBeNull();
    }
    const mixed = build([issue(), transaction({ allocation: '{"41":[50],"40":[50]}' })],
      { ...source(), lines: new Map([['40', '11']]) }, quarantinedTarget());
    expect(mixed.exclusions.some(row => row.blocking === true)).toBe(true);
    expect(mixed.exclusions).not.toContainEqual(expect.objectContaining({ reason: 'CREDIT_ALLOCATION_LINE_ABSENT' }));
  });

  it('keeps status, raw references, channel, currency & exact money requirements on retained credit history', () => {
    for (const change of [{ status: 'PENDING' }, { kind: 'ADJUST' }, { orderLineId: '41' }, { refundId: '50' }]) {
      const result = build([issue(), transaction({ allocation: '{"41":[100]}', ...change })], source(), quarantinedTarget());
      expect(result.exclusions.some(row => row.blocking === true)).toBe(true);
      expect(result.exclusions).not.toContainEqual(expect.objectContaining({ reason: 'CREDIT_ALLOCATION_LINE_ABSENT' }));
    }
    for (const account of [credit({ channelId: '2' }), credit({ currency: 'EUR' })]) {
      const result = buildCreditTransactions(ctx, [account], [issue(), transaction({ allocation: '{"41":[100]}' })], source(), quarantinedTarget());
      expect(result.exclusions.some(row => row.blocking === true)).toBe(true);
    }
    const wrongCurrency = quarantinedTarget();
    const parent = wrongCurrency.orders.get(id('order', '10'))!;
    const result = build([issue(), transaction({ allocation: '{"41":[100]}' })], source(),
      { ...wrongCurrency, orders: new Map([[parent.id, { ...parent, currency: 'EUR' }]]) });
    expect(result.exclusions.some(row => row.blocking === true)).toBe(true);
    expect(() => build([issue(), transaction({ allocation: '{"41":[99]}' })], source(), quarantinedTarget())).toThrow(/redemption amount/);
    expect(() => build([issue(), transaction({ delta: -99, allocation: '{"41":[100]}' })], source(), quarantinedTarget())).toThrow(/historical deltas/);
    expect(() => build([issue(), transaction({ relatedTransactionId: '99', allocation: '{"41":[100]}' })], source(), quarantinedTarget())).toThrow(/Related source credit/);
  });

  it('keeps currency private truth, disables deleted promos, retains related links & stable source identities', () => {
    const result = buildCreditAccounts(ctx, [credit({ currency: 'EUR' })], [promotion({ deletedAt: '2020-04-01 12:00:00' })]);
    expect(result.accountRows[0]!.currency).toBe('EUR');
    expect(result.exclusions[0]!.blocking).toBe(true);
    expect(result.promotionRows[0]!.enabled).toBe(false);
    expect(build().rows[1]!.relatedTransactionId).toBe(id('account-credit-transaction', '1'));
    expect(build()).toEqual(build());
    const changedSource = buildCreditAccounts(ctx, [credit({ sourceRecord: credit().sourceRecord + ' ' })], [promotion()]);
    expect(changedSource.accountRows[0]!.sourceDigest).not.toBe(buildCreditAccounts(ctx, [credit()], [promotion()]).accountRows[0]!.sourceDigest);
    expect(migrationId(otherStoreId, sourceKey, 'account-credit', '1')).not.toBe(id('account-credit', '1'));
    expect(migrationId(storeId, 'other-source', 'account-credit', '1')).not.toBe(id('account-credit', '1'));
  });

  it('requires complete paired source balance/history schemas when plugin exists', () => {
    const columns = new Map(Object.entries(REQUIRED_SOURCE_COLUMNS).map(([table, names]) => [table, new Set(names)]));
    columns.set('account_credit', new Set(OPTIONAL_SOURCE_TABLES.account_credit));
    expect(() => assertSourceSchema(columns)).toThrow(/both be present/);
    columns.set('account_credit_transaction', new Set(OPTIONAL_SOURCE_TABLES.account_credit_transaction));
    expect(() => assertSourceSchema(columns)).not.toThrow();
    columns.get('account_credit_transaction')!.delete('allocation');
    expect(() => assertSourceSchema(columns)).toThrow(/allocation/);
  });
});
