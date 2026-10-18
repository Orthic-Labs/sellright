import { describe, expect, it } from 'vitest';
import { MAX_CREDIT_CENTS } from './math.js';
import { planEditCreditFunding, planCreditUnitReturn, readCreditFundingState, type EditFundingInput, type EditFundingPosting,
  readCreditUnitReturns, readCreditRefundEvidence, creditReturnSnapshotDigest, originalCreditUnitId, importedCreditUnitId,
  type EditFundingHistoryRow, type EditFundingRedemption, type EditFundingTargetLine } from './edit-funding.js';

const ORDER = '00000000-0000-0000-0000-000000000001';
const ACCOUNT = '00000000-0000-0000-0000-000000000002';
const REDEEM = '00000000-0000-0000-0000-000000000003';
const LINE = '00000000-0000-0000-0000-000000000004';
const OTHER = '00000000-0000-0000-0000-000000000005';
const edit = (n: number) => `00000000-0000-0000-0000-${String(100 + n).padStart(12, '0')}`;
const redemption = (units = [34, 34, 33]): EditFundingRedemption => ({ id: REDEEM, orderId: ORDER, accountCreditId: ACCOUNT,
  kind: 'REDEEM', status: 'POSTED', amount: units.reduce((a, b) => a + b, 0), delta: -units.reduce((a, b) => a + b, 0), operationalAllocation: { [LINE]: units } });
const target = (caps: number[], indexes: Array<number | null> = caps.map((_, i) => i), line = LINE): EditFundingTargetLine =>
  ({ orderLineId: line, units: caps.map((maximumCredit, i) => ({ originalIndex: indexes[i]!, maximumCredit })) });
const input = (lines: EditFundingTargetLine[], history: EditFundingHistoryRow[] = [], n = 1, redeem = redemption()): EditFundingInput =>
  ({ redemption: redeem, history, historyComplete: true, editId: edit(n), lines });
function candidate(i: EditFundingInput) {
  const result = planEditCreditFunding(i);
  if (!result.ok || result.replay) throw new Error(`Expected candidate: ${JSON.stringify(result)}`);
  return result;
}
function posted(rows: EditFundingPosting[]): EditFundingHistoryRow[] {
  return rows.map(row => ({ ...row, id: row.idempotencyKey }));
}
function legacy(quantity: number, amount: number, line = LINE): EditFundingHistoryRow {
  return { id: `legacy-${line}-${quantity}`, idempotencyKey: `legacy-${line}-${quantity}`, orderId: ORDER,
    accountCreditId: ACCOUNT, relatedTransactionId: REDEEM, orderLineId: line, kind: 'RESTORE', status: 'POSTED',
    quantity, amount, delta: amount, allocation: null, operationalAllocation: null };
}

describe('immutable order-edit credit funding', () => {
  it('preserves consumed original identities without reattaching returned funding', () => {
    const returned = planCreditUnitReturn({ redemption: redemption(), history: [], historyComplete: true,
      orderLineId: LINE, originalIndexes: [0], operation: { kind: 'manual_return', id: 'consumed' } });
    if (!returned.ok || !returned.posting) throw new Error('Expected return');
    const line = target([100, 100, 100]); line.units[0]!.consumed = true;
    const result = candidate(input([line], posted([returned.posting])));
    expect(result.allocation[LINE]).toEqual([0, 34, 33]); expect(result.postings).toEqual([]);
    expect(planEditCreditFunding(input([target([100, 100, 100])], posted([returned.posting]))).ok).toBe(false);
    expect(planEditCreditFunding(input([line])).ok).toBe(false);
  });

  it('binds frozen cash-only return custody to stable ID, source & actual refund line', () => {
    const base = { version: 2 as const, redemptionId: REDEEM, snapshotHash: 'a'.repeat(64), snapshotDigest: 'b'.repeat(64),
      lines: [{ orderLineId: LINE, positions: [0, 3], originalIndexes: [0, null], creditCents: [34, 0],
        unitIds: [originalCreditUnitId(REDEEM, LINE, 0), `edit:${edit(1)}:${LINE}:0`],
        unitEconomics: [{ net: 100, gross: 100, cashRefundGross: 66 }, { net: 100, gross: 100, cashRefundGross: 100 }] }] };
    const frozen = { ...base, requestDigest: creditReturnSnapshotDigest(base) };
    const refund = { id: OTHER, state: 'Settled', metadata: { creditUnitReturns: frozen }, lines: [{ orderLineId: LINE, quantity: 2, amount: 166 }] };
    expect(readCreditRefundEvidence(refund)).toEqual(frozen);
    expect(() => readCreditRefundEvidence({ ...refund, lines: [{ orderLineId: LINE, quantity: 2, amount: 167 }] })).toThrow(/closure/);
    const foreign = { ...base, lines: [{ ...base.lines[0]!, unitIds: [originalCreditUnitId(REDEEM, OTHER, 0), base.lines[0]!.unitIds[1]!] }] };
    expect(() => readCreditUnitReturns({ creditUnitReturns: { ...foreign, requestDigest: creditReturnSnapshotDigest(foreign) } })).toThrow(/identity/);
  });

  it('decodes retained unfunded source slots without fabricating original credit indexes', () => {
    const base = { version: 2 as const, redemptionId: REDEEM, snapshotHash: 'a'.repeat(64), snapshotDigest: 'b'.repeat(64),
      lines: [{ orderLineId: LINE, positions: [3], originalIndexes: [null], creditCents: [0],
        unitIds: [importedCreditUnitId('c'.repeat(64), LINE, 3)], presentUnitIds: [], unitEconomics: [{ net: 0, gross: 0, cashRefundGross: 0 }] }] };
    const frozen = { ...base, requestDigest: creditReturnSnapshotDigest(base) };
    expect(readCreditRefundEvidence({ id: OTHER, state: 'Settled', metadata: { creditUnitReturns: frozen },
      lines: [{ orderLineId: LINE, quantity: 1, amount: 0 }] })).toEqual(frozen);
    const forged = { ...base, lines: [{ ...base.lines[0]!, originalIndexes: [0] }] };
    expect(() => readCreditUnitReturns({ creditUnitReturns: { ...forged, requestDigest: creditReturnSnapshotDigest(forged) } })).toThrow(/identity/);
    for (const presentUnitIds of [[originalCreditUnitId(REDEEM, LINE, 0)], [base.lines[0]!.unitIds[0]!, base.lines[0]!.unitIds[0]!]]) {
      const invalid = { ...base, lines: [{ ...base.lines[0]!, presentUnitIds }] };
      expect(() => readCreditUnitReturns({ creditUnitReturns: { ...invalid, requestDigest: creditReturnSnapshotDigest(invalid) } })).toThrow(/physical/);
    }
    expect(() => readCreditUnitReturns({ creditUnitReturns: { ...frozen, lines: [{ ...frozen.lines[0]!, presentUnitIds: frozen.lines[0]!.unitIds }] } })).toThrow(/digest/);
  });

  it('retains explicit detached source funding while repricing only current units', () => {
    const unchanged = candidate(input([target([100, 100, 33])]));
    expect(unchanged.postings).toEqual([]);
    const repriced = candidate(input([target([20, 20, 33])]));
    expect(repriced.allocation[LINE]).toEqual([20, 20, 33]);
    expect(repriced.postings).toHaveLength(1);
    expect(repriced.postings[0]).toMatchObject({ quantity: 0, amount: 28 });
    expect(repriced.state).toMatchObject({ retained: 73, restored: 28, redeemed: 101 });
    expect(JSON.parse(repriced.postings[0]!.allocation).units.map((unit: { index: number }) => unit.index)).toEqual([0, 1]);
  });
  it('preserves uneven original vectors & never funds new merchandise', () => {
    const i = input([target([100, 100, 100, 100], [0, 1, 2, null]), target([90], [null], OTHER)]);
    const before = structuredClone(i), result = candidate(i);
    expect(result.allocation).toEqual({ [LINE]: [34, 34, 33, 0], [OTHER]: [0] });
    expect(result.postings).toEqual([]);
    expect(result.state).toMatchObject({ redeemed: 101, restored: 0, retained: 101 });
    expect(i).toEqual(before);
  });

  it('restores only excess after ordinary repricing & cannot reborrow on price increases', () => {
    const first = candidate(input([target([20, 30, 33])]));
    expect(first.postings).toHaveLength(1);
    expect(first.postings[0]).toMatchObject({ kind: 'RESTORE', quantity: 0, amount: 18, delta: 18 });
    expect(JSON.parse(first.postings[0]!.allocation)).toMatchObject({ version: 1, cause: 'unit_correction',
      units: [{ index: 0, before: 34, after: 20 }, { index: 1, before: 34, after: 30 }] });
    const history = posted(first.postings);
    const increase = candidate(input([target([80, 80, 80])], history, 2));
    expect(increase.allocation[LINE]).toEqual([20, 30, 33]); expect(increase.postings).toEqual([]);
    const second = candidate(input([target([10, 25, 20])], history, 3));
    expect(second.postings[0]?.amount).toBe(28);
    const last = candidate(input([target([90, 90, 90])], [...history, ...posted(second.postings)], 4));
    expect(last.allocation[LINE]).toEqual([10, 25, 20]);
    expect(last.state).toMatchObject({ restored: 46, retained: 55 });
  });

  it('quantity returns restore residual original-index funding & additions remain zero', () => {
    const cut = candidate(input([target([10, 34, 33])]));
    const history = posted(cut.postings);
    const remove = candidate(input([target([34, 33, 200], [1, 2, null])], history, 2));
    expect(remove.postings[0]).toMatchObject({ quantity: 1, amount: 10 });
    expect(JSON.parse(remove.postings[0]!.allocation).units).toEqual([{ index: 0, before: 10, after: 0 }]);
    expect(remove.allocation[LINE]).toEqual([34, 33, 0]);
    const nextHistory = [...history, ...posted(remove.postings)];
    expect(candidate(input([target([100, 100, 200], [1, 2, null])], nextHistory, 3)).state).toMatchObject({ restored: 34, retained: 67 });
    expect(planEditCreditFunding(input([target([100, 34, 33])], nextHistory, 4))).toMatchObject({ ok: false, code: 'INVALID_REQUEST' });
  });

  it('accepts proven old quantity prefixes before a correction on surviving indexes', () => {
    const history = [legacy(1, 34)];
    const cut = candidate(input([target([5, 33], [1, 2])], history));
    expect(cut.postings[0]).toMatchObject({ quantity: 0, amount: 29 });
    const remove = candidate(input([target([33], [2])], [...history, ...posted(cut.postings)], 2));
    expect(remove.postings[0]).toMatchObject({ quantity: 1, amount: 5 });
    expect(remove.state).toMatchObject({ restored: 68, retained: 33 });
  });

  it('supports correction then explicit quantity return, & excludes returned indexes from later corrections', () => {
    const cut = candidate(input([target([15, 25, 33])]));
    const remove = candidate(input([target([25, 33], [1, 2])], posted(cut.postings), 2));
    const history = [...posted(cut.postings), ...posted(remove.postings)];
    // No timestamp sorting: before/after edges establish exact unit chronology.
    const next = candidate(input([target([5, 33], [1, 2])], [...history].reverse(), 3));
    expect(next.postings[0]?.amount).toBe(20);
    expect(JSON.parse(next.postings[0]!.allocation).units).toEqual([{ index: 1, before: 25, after: 5 }]);
    expect(readCreditFundingState({ redemption: redemption(), history: [...history, ...posted(next.postings)], historyComplete: true })).toMatchObject({ ok: true,
      state: { returnedIndexes: { [LINE]: [0] }, remaining: { [LINE]: [0, 5, 33] }, restored: 63, retained: 38 } });
  });

  it('tracks zero-cent returns & quantity after a correction which exhausted funding', () => {
    const redeem = redemption([0, 1, 0]);
    const cut = candidate(input([target([0, 0, 0])], [], 1, redeem));
    const remove = candidate(input([target([0], [2])], posted(cut.postings), 2, redeem));
    expect(remove.postings[0]).toMatchObject({ quantity: 2, amount: 0 });
    expect(remove.state.returnedIndexes[LINE]).toEqual([0, 1]);
    expect(readCreditFundingState({ redemption: redeem, history: [...posted(remove.postings), ...posted(cut.postings)], historyComplete: true })).toMatchObject({ ok: true,
      state: { restored: 1, retained: 0, returnedIndexes: { [LINE]: [0, 1] } } });
  });

  it('binds deterministic replay to full payload & durable complete posting receipt', () => {
    const request = input([target([10, 20, 30])]); const first = candidate(request);
    expect(candidate(structuredClone(request))).toEqual(first);
    const replay = { ...request, history: posted(first.postings), committedEdit: { editId: request.editId,
      requestDigest: first.requestDigest, postingKeys: first.postings.map(row => row.idempotencyKey) } };
    expect(planEditCreditFunding(replay)).toMatchObject({ ok: true, replay: true, postings: [] });
    expect(planEditCreditFunding({ ...replay, lines: [target([11, 20, 30])] })).toMatchObject({ ok: false, code: 'REPLAY_CONFLICT' });
    expect(planEditCreditFunding({ ...replay, history: [] })).toMatchObject({ ok: false, code: 'REPLAY_CONFLICT' });
    expect(planEditCreditFunding({ ...replay, committedEdit: undefined })).toMatchObject({ ok: false, code: 'REPLAY_CONFLICT' });
    const inert = candidate(input([target([90, 90, 90])]));
    expect(planEditCreditFunding({ ...input([target([90, 90, 90])]), committedEdit: { editId: edit(1), requestDigest: inert.requestDigest, postingKeys: [] } })).toMatchObject({ ok: true, replay: true });
  });

  it('replays prior edit after later returns without reattaching or emitting funding', () => {
    const request = input([target([10, 20, 30])]), cut = candidate(request);
    const remove = candidate(input([], posted(cut.postings), 2));
    expect(planEditCreditFunding({ ...request, history: [...posted(cut.postings), ...posted(remove.postings)],
      committedEdit: { editId: edit(1), requestDigest: cut.requestDigest, postingKeys: cut.postings.map(p => p.idempotencyKey) } })).toMatchObject({ ok: true, replay: true,
      state: { restored: 101, retained: 0 } });
  });

  it('accounts every redemption line & rejects overflow or incorrect full sums', () => {
    const redeem = redemption(); redeem.operationalAllocation![OTHER] = [9]; redeem.amount += 9; redeem.delta = -redeem.amount;
    const result = candidate(input([target([34, 34, 33])], [], 1, redeem));
    expect(result.postings[0]).toMatchObject({ orderLineId: OTHER, quantity: 1, amount: 9 });
    expect(result.state.restored + result.state.retained).toBe(110);
    expect(planEditCreditFunding(input([], [], 1, { ...redemption(), amount: 100, delta: -100 }))).toMatchObject({ ok: false, code: 'INVALID_REDEMPTION' });
    expect(planEditCreditFunding(input([], [], 1, redemption([MAX_CREDIT_CENTS, 1])))).toMatchObject({ ok: false, code: 'INVALID_REDEMPTION' });
    expect(planEditCreditFunding(input([], [legacy(1, 35)]))).toMatchObject({ ok: false, code: 'AMBIGUOUS_HISTORY' });
  });

  it('refuses ambiguous imported links, unversioned corrections & mixed prefix claims', () => {
    for (const patch of [{ relatedTransactionId: null }, { orderLineId: null }, { accountCreditId: OTHER }, { orderId: OTHER },
      { status: 'VOID' }, { delta: 0 }, { quantity: 0 }, { quantity: null }]) {
      expect(planEditCreditFunding(input([], [{ ...legacy(1, 34), ...patch }]))).toMatchObject({ ok: false, code: 'AMBIGUOUS_HISTORY' });
    }
    const cut = candidate(input([target([10, 34, 33])]));
    // Old aggregate prefix logic cannot represent a return after a correction.
    expect(planEditCreditFunding(input([], [...posted(cut.postings), legacy(1, 34)], 2))).toMatchObject({ ok: false, code: 'AMBIGUOUS_HISTORY' });
    expect(planEditCreditFunding({ ...input([]), historyComplete: false } as unknown as EditFundingInput)).toMatchObject({ ok: false, code: 'AMBIGUOUS_HISTORY' });
  });

  it('refuses overlapping monetary chains, duplicate indexes & tampered projected sums', () => {
    const cut = candidate(input([target([10, 20, 30])]));
    const rows = posted(cut.postings), row = rows[0]!;
    const envelope = JSON.parse(row.allocation!);
    envelope.units[0].before = 35;
    expect(planEditCreditFunding(input([], [{ ...row, allocation: JSON.stringify(envelope) }], 2))).toMatchObject({ ok: false, code: 'AMBIGUOUS_HISTORY' });
    expect(planEditCreditFunding(input([], [{ ...row, operationalAllocation: { [LINE]: [23, 14, 3] } }], 2))).toMatchObject({ ok: false, code: 'AMBIGUOUS_HISTORY' });
    const duplicate = { ...row, id: 'other', idempotencyKey: row.idempotencyKey };
    expect(planEditCreditFunding(input([], [row, duplicate], 2))).toMatchObject({ ok: false, code: 'AMBIGUOUS_HISTORY' });
    const independentlyCut = candidate(input([target([20, 25, 30])], [], 2));
    expect(planEditCreditFunding(input([], [...rows, ...posted(independentlyCut.postings)], 3))).toMatchObject({ ok: false, code: 'AMBIGUOUS_HISTORY' });
    const repeatedIndex = JSON.parse(row.allocation!);
    repeatedIndex.units[1].index = 0;
    expect(planEditCreditFunding(input([], [{ ...row, allocation: JSON.stringify(repeatedIndex) }], 2))).toMatchObject({ ok: false, code: 'AMBIGUOUS_HISTORY' });
    expect(planEditCreditFunding(input([target([10, 10], [0, 0])]))).toMatchObject({ ok: false, code: 'INVALID_REQUEST' });
    expect(planEditCreditFunding(input([target([10], [0], OTHER)]))).toMatchObject({ ok: false, code: 'INVALID_REQUEST' });
  });
  it('shares original-index chains across edit correction, refund & manual return', () => {
    const cut = candidate(input([target([10, 34, 33])]));
    const evidence = { redemption: redemption(), history: posted(cut.postings), historyComplete: true as const };
    const refund = planCreditUnitReturn({ ...evidence, orderLineId: LINE, originalIndexes: [2, null],
      operation: { kind: 'refund', id: edit(20) } });
    if (!refund.ok || !refund.posting) throw new Error('Expected refund posting');
    expect(refund.posting).toMatchObject({ quantity: 1, amount: 33, idempotencyKey: `refund:${edit(20)}:line:${LINE}` });
    expect(JSON.parse(refund.posting.allocation)).toMatchObject({ type: 'account_credit.unit_restore',
      operation: { kind: 'refund', id: edit(20) }, units: [{ index: 2, before: 33, after: 0 }] });
    const history = [...evidence.history, ...posted([refund.posting])];
    const manual = planCreditUnitReturn({ ...evidence, history, orderLineId: LINE, originalIndexes: [0],
      operation: { kind: 'manual_return', id: 'manual-op' } });
    if (!manual.ok || !manual.posting) throw new Error('Expected manual posting');
    expect(manual.posting).toMatchObject({ quantity: 1, amount: 10, idempotencyKey: 'manual:manual-op' });
    expect(readCreditFundingState({ ...evidence, history: [...history, ...posted([manual.posting])].reverse() })).toMatchObject({ ok: true,
      state: { remaining: { [LINE]: [0, 34, 0] }, returnedIndexes: { [LINE]: [0, 2] }, restored: 67, retained: 34 } });
    expect(planCreditUnitReturn({ ...evidence, history, orderLineId: LINE, originalIndexes: [2],
      operation: { kind: 'manual_return', id: 'double' } })).toMatchObject({ ok: false, code: 'INVALID_REQUEST' });
    expect(readCreditFundingState({ ...evidence, history: [...evidence.history,
      { ...posted([refund.posting])[0]!, refundId: edit(21) }] })).toMatchObject({ ok: false, code: 'AMBIGUOUS_HISTORY' });
    expect(readCreditFundingState({ ...evidence, history: [...evidence.history,
      { ...posted([refund.posting])[0]!, status: 'PENDING' }] })).toMatchObject({ ok: false, code: 'AMBIGUOUS_HISTORY' });
  });

  it('consumes exhausted original zero-cent units & never restores newly added units', () => {
    const redeem = redemption([0, 1, 0]);
    const result = planCreditUnitReturn({ redemption: redeem, history: [], historyComplete: true, orderLineId: LINE,
      originalIndexes: [2, null], operation: { kind: 'manual_return', id: 'zero-original' } });
    if (!result.ok || !result.posting) throw new Error('Expected zero-cent identity consumption');
    expect(result.posting).toMatchObject({ quantity: 1, amount: 0 });
    expect(readCreditFundingState({ redemption: redeem, history: posted([result.posting]), historyComplete: true })).toMatchObject({ ok: true,
      state: { returnedIndexes: { [LINE]: [2] }, retained: 1 } });
    expect(planCreditUnitReturn({ redemption: redeem, history: [], historyComplete: true, orderLineId: OTHER,
      originalIndexes: [null], operation: { kind: 'manual_return', id: 'new-only' } })).toMatchObject({ ok: true, posting: null });
  });

});
