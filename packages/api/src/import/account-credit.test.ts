import { describe, expect, it } from 'vitest';
import { migrationId } from './context.js';
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
    expect(absentLine.rows[1]).toMatchObject({ allocation: '{"41":[100]}', operationalAllocation: null, orderId: null });
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
    expect(() => build([issue(), transaction()], source(), { ...target(), lines: new Map([[id('order-line', '40'), { id: id('order-line', '40'), storeId: otherStoreId, orderId: id('order', '10') }]]) })).toThrow(/Cross-store/);
    expect(() => buildCreditAccounts(ctx, [credit({ channelId: '2' })], [promotion()])).toThrow(/another source channel/);
    expect(() => build([issue(), transaction({ relatedTransactionId: '99' })])).toThrow(/Related source credit/);
    expect(() => buildCreditAccounts(ctx, [credit(), credit({ id: '2', issuanceKey: 'other' })], [promotion()])).toThrow(/Conflicting/);
    const account = { id: id('account-credit', '1'), storeId, sourceKey, sourceId: '1' };
    expect(() => assertCreditAccountMapping(ctx, [credit()], [account])).not.toThrow();
    expect(() => assertCreditAccountMapping(ctx, [credit()], [{ ...account, storeId: otherStoreId }])).toThrow(/source\/tenant/);
    expect(() => assertCreditAccountMapping(ctx, [credit()], [{ ...account, sourceKey: 'other-source' }])).toThrow(/source\/tenant/);
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
