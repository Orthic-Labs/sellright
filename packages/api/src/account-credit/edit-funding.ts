/** Pure immutable-redemption accounting. Posting & locking belong to callers. */
import { createHash } from 'node:crypto';
import { MAX_CREDIT_CENTS } from './math.js';

export interface EditFundingRedemption {
  id: string; orderId: string | null; accountCreditId: string;
  kind: string; status: string; amount: number; delta: number;
  operationalAllocation: Record<string, number[]> | null;
}
export interface EditFundingHistoryRow {
  id: string; idempotencyKey: string; orderId: string | null; accountCreditId: string;
  relatedTransactionId: string | null; orderLineId: string | null; refundId?: string | null;
  kind: string; status: string; quantity: number | null; amount: number; delta: number;
  allocation: string | null; operationalAllocation: Record<string, number[]> | null;
}
export interface EditFundingUnitChange {
  /** Index in original POSTED REDEEM native-line vector, never current position. */
  index: number; before: number; after: number;
}
/** Persist JSON in RESTORE.allocation; never replace REDEEM's source TEXT/vector.
 * operationalAllocation is { [orderLineId]: units.map(u => u.before - u.after) }.
 * Quantity returns consume indexes permanently, including zero-cent indexes.
 * Monetary corrections retain indexes & use quantity=0, even when exhausting one.
 */
export interface EditFundingEnvelope {
  version: 1; type: 'account_credit.edit_restore'; cause: 'quantity_return' | 'unit_correction';
  redemptionId: string; orderId: string; accountCreditId: string; orderLineId: string;
  editId: string; requestDigest: string; units: EditFundingUnitChange[];
}
export interface UnitRestoreEnvelope {
  version: 1; type: 'account_credit.unit_restore'; cause: 'quantity_return';
  redemptionId: string; orderId: string; accountCreditId: string; orderLineId: string;
  operation: { kind: 'refund' | 'manual_return'; id: string }; units: EditFundingUnitChange[];
}
type RestorationEnvelope = EditFundingEnvelope | UnitRestoreEnvelope;
export interface EditFundingPosting {
  refundId?: string | null;
  kind: 'RESTORE'; status: 'POSTED'; relatedTransactionId: string; orderId: string;
  accountCreditId: string; orderLineId: string; quantity: number; amount: number; delta: number;
  idempotencyKey: string; allocation: string; operationalAllocation: Record<string, number[]>;
}
export interface EditFundingTargetLine {
  orderLineId: string;
  /** Ordinary pricing runs first. Cap uses original redemption's monetary basis.
   * New merchandise has originalIndex=null, so it always receives zero funding.
   * Caller preserves these identities across quantity increases & later edits.
   */
  units: Array<{ originalIndex: number | null; maximumCredit: number; consumed?: boolean; unitId?: string }>;
}
export interface EditFundingInput {
  redemption: EditFundingRedemption;
  /** Complete POSTED RESTORE history for this redemption, across every line. */
  history: readonly EditFundingHistoryRow[]; historyComplete: true;
  editId: string; lines: readonly EditFundingTargetLine[];
  /** Durable order_edit receipt, including edits which produced no RESTORE rows. */
  committedEdit?: { editId: string; requestDigest: string; postingKeys: readonly string[] };
}
export type EditFundingRefusalCode = 'INVALID_REDEMPTION' | 'AMBIGUOUS_HISTORY' | 'INVALID_REQUEST' | 'REPLAY_CONFLICT';
export interface EditFundingRefusal {
  ok: false; event: 'account_credit.reconciliation_required'; operation: 'order_edit';
  code: EditFundingRefusalCode; message: string;
}
export interface CreditFundingState {
  remaining: Record<string, number[]>; returnedIndexes: Record<string, number[]>;
  redeemed: number; restored: number; retained: number;
}
export type EditFundingResult = EditFundingRefusal | {
  ok: true; replay: true; requestDigest: string;
  /** Replay emits no postings; consumer returns its durable order_edit result. */
  postings: []; state: CreditFundingState;
} | {
  ok: true; replay: false; requestDigest: string; postings: EditFundingPosting[];
  /** Current-position funding for downstream totals; original vectors stay intact. */
  allocation: Record<string, number[]>; state: CreditFundingState;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const money = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= MAX_CREDIT_CENTS;
class Refusal extends Error {
  constructor(readonly code: EditFundingRefusalCode, message: string) { super(message); }
}
function requireFact(ok: unknown, code: EditFundingRefusalCode, message: string): asserts ok {
  if (!ok) throw new Refusal(code, message);
}
function sum(values: readonly number[], code: EditFundingRefusalCode): number {
  const total = values.reduce((n, v) => n + v, 0);
  requireFact(money(total), code, 'Credit sum exceeds integer cents'); return total;
}
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}
const serialize = (value: unknown) => JSON.stringify(stable(value));
export const creditReturnSnapshotDigest = (value: unknown): string => createHash('sha256').update(serialize(value)).digest('hex');
export const originalCreditUnitId = (redemptionId: string, orderLineId: string, index: number): string =>
  `original:${redemptionId}:${orderLineId}:${index}`;
export interface CreditUnitEconomics { net: number; gross: number; cashRefundGross: number }
export interface CreditUnitReturnLine {
  orderLineId: string; positions: number[]; originalIndexes: Array<number | null>; creditCents: number[];
}
export interface CreditUnitReturnLineV2 extends CreditUnitReturnLine { unitIds: string[]; unitEconomics: CreditUnitEconomics[] }
export interface CreditUnitReturnsV1 {
  version: 1; redemptionId: string; snapshotDigest: string; requestDigest: string; lines: CreditUnitReturnLine[];
}
export interface CreditUnitReturnsV2 {
  version: 2; redemptionId: string; snapshotHash: string; snapshotDigest: string; requestDigest: string; lines: CreditUnitReturnLineV2[];
}
export type CreditUnitReturns = CreditUnitReturnsV1 | CreditUnitReturnsV2;
export interface CreditRefundEvidence {
  id: string; state: string; metadata: unknown;
  lines: readonly { orderLineId: string; quantity: number; amount: number }[];
}
/** Structural decoder; source snapshot validation belongs to current pricing. */
export function readCreditUnitReturns(metadata: unknown): CreditUnitReturns | null {
  const raw = object(metadata) ? metadata.creditUnitReturns : undefined;
  if (raw === undefined) return null;
  if (!object(raw) || (raw.version !== 1 && raw.version !== 2) || typeof raw.redemptionId !== 'string' ||
    typeof raw.snapshotDigest !== 'string' || !/^[a-f0-9]{64}$/.test(raw.snapshotDigest) || !Array.isArray(raw.lines) ||
    typeof raw.requestDigest !== 'string' || (raw.version === 2 && (typeof raw.snapshotHash !== 'string' || !/^[a-f0-9]{64}$/.test(raw.snapshotHash)))) {
    throw new Error('Invalid frozen refund unit identity');
  }
  const lines = new Set<string>(), units = new Set<string>();
  for (const line of raw.lines) {
    if (!object(line) || typeof line.orderLineId !== 'string' || lines.has(line.orderLineId) || !Array.isArray(line.positions) ||
      !Array.isArray(line.originalIndexes) || !Array.isArray(line.creditCents)) throw new Error('Invalid frozen refund unit vectors');
    const { positions, originalIndexes, creditCents } = line;
    if (!positions.length || positions.length !== originalIndexes.length || positions.length !== creditCents.length ||
      !positions.every(i => Number.isSafeInteger(i) && i >= 0) || new Set(positions).size !== positions.length ||
      !originalIndexes.every(i => i === null || Number.isSafeInteger(i) && i >= 0) ||
      new Set(originalIndexes.filter(i => i !== null)).size !== originalIndexes.filter(i => i !== null).length ||
      !creditCents.every(money) || originalIndexes.some((i, p) => i === null && creditCents[p] !== 0)) throw new Error('Invalid frozen refund unit vectors');
    if (raw.version === 2) {
      if (!Array.isArray(line.unitIds) || !Array.isArray(line.unitEconomics) || line.unitIds.length !== positions.length || line.unitEconomics.length !== positions.length) throw new Error('Frozen refund lacks stable unit custody');
      for (let p = 0; p < positions.length; p++) {
        const id = line.unitIds[p], economics = line.unitEconomics[p], index = originalIndexes[p];
        const born = typeof id === 'string' ? id.split(':') : [];
        if (typeof id !== 'string' || units.has(id) || (index !== null ? id !== originalCreditUnitId(raw.redemptionId, line.orderLineId, index) :
          born.length !== 4 || born[0] !== 'edit' || !UUID.test(born[1]!) || born[2] !== line.orderLineId || !/^(0|[1-9]\d*)$/.test(born[3]!) || !Number.isSafeInteger(Number(born[3]))) ||
          !object(economics) || !money(economics.net) || !money(economics.gross) || !money(economics.cashRefundGross)) throw new Error('Invalid frozen stable unit identity or economics');
        units.add(id);
      }
    }
    lines.add(line.orderLineId);
  }
  const result = raw as unknown as CreditUnitReturns;
  const base = { version: result.version, redemptionId: result.redemptionId, snapshotDigest: result.snapshotDigest, lines: result.lines,
    ...(result.version === 2 ? { snapshotHash: result.snapshotHash } : {}) };
  if (creditReturnSnapshotDigest(base) !== result.requestDigest) throw new Error('Frozen refund unit digest differs');
  return result;
}
export function readCreditRefundEvidence(refund: CreditRefundEvidence): CreditUnitReturns | null {
  const frozen = readCreditUnitReturns(refund.metadata);
  if (!frozen) return null;
  if (new Set(refund.lines.map(line => line.orderLineId)).size !== refund.lines.length || frozen.lines.length !== refund.lines.length ||
    frozen.lines.some(line => !refund.lines.some(actual => actual.orderLineId === line.orderLineId && actual.quantity === line.positions.length &&
      (frozen.version !== 2 || actual.amount === (line as CreditUnitReturnLineV2).unitEconomics.reduce((n, unit) => n + unit.cashRefundGross, 0))))) {
    throw new Error('Frozen refund unit closure differs from refund lines');
  }
  return frozen;
}
const refusal = (error: Refusal): EditFundingRefusal => ({ ok: false,
  event: 'account_credit.reconciliation_required', operation: 'order_edit', code: error.code, message: error.message });
const keyFor = (e: RestorationEnvelope) => e.type === 'account_credit.edit_restore'
  ? `edit:${e.editId}:credit:${e.redemptionId}:line:${e.orderLineId}:${e.cause}`
  : e.operation.kind === 'refund' ? `refund:${e.operation.id}:line:${e.orderLineId}` : `manual:${e.operation.id}`;

function parseEnvelope(row: EditFundingHistoryRow): RestorationEnvelope | null {
  if (row.allocation === null) return null;
  let raw: unknown;
  try { raw = JSON.parse(row.allocation); } catch { throw new Refusal('AMBIGUOUS_HISTORY', 'Unreadable restoration allocation'); }
  // Legacy source allocation objects are not evidence of monetary corrections.
  if (!object(raw)) return null;
  if (!['account_credit.edit_restore', 'account_credit.unit_restore'].includes(String(raw.type))) {
    requireFact(typeof raw.type !== 'string' || !raw.type.startsWith('account_credit.'), 'AMBIGUOUS_HISTORY', 'Unsupported account-credit restoration provenance');
    return null;
  }
  if (raw.type === 'account_credit.unit_restore') {
    requireFact(raw.version === 1 && raw.cause === 'quantity_return' && object(raw.operation) &&
      ['refund', 'manual_return'].includes(String(raw.operation.kind)) && typeof raw.operation.id === 'string' &&
      raw.operation.id.length > 0 && raw.operation.id.length <= 153 &&
      (raw.operation.kind !== 'refund' || UUID.test(raw.operation.id)) && Array.isArray(raw.units) && raw.units.length > 0,
    'AMBIGUOUS_HISTORY', 'Invalid unit-restoration operation provenance');
    return raw as unknown as UnitRestoreEnvelope;
  }
  requireFact(raw.version === 1 && ['quantity_return', 'unit_correction'].includes(String(raw.cause)) &&
    typeof raw.editId === 'string' && UUID.test(raw.editId) && typeof raw.requestDigest === 'string' && /^[a-f0-9]{64}$/.test(raw.requestDigest) &&
    Array.isArray(raw.units) && raw.units.length > 0, 'AMBIGUOUS_HISTORY', 'Invalid versioned restoration provenance');
  return raw as unknown as EditFundingEnvelope;
}

function readState(redemption: EditFundingRedemption, history: readonly EditFundingHistoryRow[], complete: boolean) {
  const c = 'INVALID_REDEMPTION';
  requireFact(redemption && redemption.kind === 'REDEEM' && redemption.status === 'POSTED' &&
    UUID.test(redemption.id) && typeof redemption.orderId === 'string' && UUID.test(redemption.orderId) && UUID.test(redemption.accountCreditId) &&
    money(redemption.amount) && redemption.amount > 0 && redemption.delta === -redemption.amount && object(redemption.operationalAllocation), c,
  'Proven POSTED redemption & native order allocation required');
  const original = redemption.operationalAllocation;
  requireFact(Object.keys(original).length > 0, c, 'Missing full redemption allocation');
  for (const [line, units] of Object.entries(original)) requireFact(UUID.test(line) && Array.isArray(units) && units.length > 0 && Array.from(units).every(money), c, 'Invalid immutable native-line unit vector');
  requireFact(sum(Object.values(original).flat(), c) === redemption.amount, c, 'Full allocation differs from redemption amount');
  const h = 'AMBIGUOUS_HISTORY';
  requireFact(complete === true && Array.isArray(history), h, 'Complete restoration history required');
  const remaining = structuredClone(original), returnedIndexes: Record<string, number[]> = Object.fromEntries(Object.keys(original).map(line => [line, []]));
  const ids = new Set<string>(), keys = new Set<string>();
  const legacy = new Map<string, { quantity: number; amounts: number[] }>();
  const modern: Array<{ row: EditFundingHistoryRow; envelope: RestorationEnvelope }> = [];
  for (const row of history) {
    requireFact(row && typeof row.id === 'string' && row.id.length > 0 && !ids.has(row.id) && typeof row.idempotencyKey === 'string' &&
      row.idempotencyKey.length > 0 && !keys.has(row.idempotencyKey) && row.kind === 'RESTORE' && row.status === 'POSTED' &&
      row.orderId === redemption.orderId && row.accountCreditId === redemption.accountCreditId && row.relatedTransactionId === redemption.id &&
      typeof row.orderLineId === 'string' && Object.hasOwn(original, row.orderLineId) && money(row.amount) && row.delta === row.amount,
    h, 'Restoration identity, native line or posted amount is unproven');
    ids.add(row.id); keys.add(row.idempotencyKey);
    const envelope = parseEnvelope(row);
    if (envelope) modern.push({ row, envelope });
    else {
      requireFact(Number.isSafeInteger(row.quantity) && row.quantity! > 0, h, 'Unversioned monetary restoration requires reconciliation');
      const group = legacy.get(row.orderLineId) ?? { quantity: 0, amounts: [] };
      group.quantity += row.quantity!; group.amounts.push(row.amount); legacy.set(row.orderLineId, group);
    }
  }
  for (const [line, group] of legacy) {
    const units = original[line]!;
    requireFact(Number.isSafeInteger(group.quantity) && group.quantity <= units.length &&
      sum(group.amounts, h) === sum(units.slice(0, group.quantity), h), h, 'Legacy restoration fails frozen prefix proof');
    returnedIndexes[line] = Array.from({ length: group.quantity }, (_, i) => i);
    remaining[line]!.fill(0, 0, group.quantity);
  }
  const transitions = new Map<string, Array<EditFundingUnitChange & { quantityReturn: boolean }>>();
  const editDigests = new Map<string, string>();
  for (const { row, envelope: e } of modern) {
    requireFact(e.redemptionId === redemption.id && e.orderId === redemption.orderId && e.accountCreditId === redemption.accountCreditId &&
      e.orderLineId === row.orderLineId && row.idempotencyKey === keyFor(e) &&
      row.quantity === (e.cause === 'quantity_return' ? e.units.length : 0), h, 'Envelope & restoration row differ');
    if (e.type === 'account_credit.unit_restore') requireFact(e.operation.kind === 'refund'
      ? row.refundId === e.operation.id : row.refundId == null, h, 'Restoration operation differs from refund linkage');
    if (e.type === 'account_credit.edit_restore') {
      requireFact(row.refundId == null, h, 'Edit restoration cannot carry refund linkage');
      requireFact(!editDigests.has(e.editId) || editDigests.get(e.editId) === e.requestDigest, h, 'Edit has conflicting request digests');
      editDigests.set(e.editId, e.requestDigest);
    }
    const seen = new Set<number>();
    for (const u of e.units) {
      requireFact(object(u) && Number.isSafeInteger(u.index) && u.index >= 0 && u.index < original[e.orderLineId]!.length && !seen.has(u.index) &&
        money(u.before) && money(u.after) && u.after <= u.before && (e.cause === 'quantity_return' ? u.after === 0 : u.after < u.before) &&
        !returnedIndexes[e.orderLineId]!.includes(u.index), h, 'Invalid, duplicate or legacy-returned unit index');
      seen.add(u.index);
      const key = `${e.orderLineId}:${u.index}`;
      const chain = transitions.get(key) ?? []; chain.push({ ...u, quantityReturn: e.cause === 'quantity_return' }); transitions.set(key, chain);
    }
    const projection = { [e.orderLineId]: e.units.map(u => u.before - u.after) };
    requireFact(sum(projection[e.orderLineId]!, h) === row.amount && serialize(row.operationalAllocation) === serialize(projection), h, 'Restoration allocation does not conserve cents');
  }
  // Before/after edges prove chronology without timestamps or guessed key ordering.
  for (const [line, units] of Object.entries(original)) for (let index = 0; index < units.length; index++) {
    const chain = transitions.get(`${line}:${index}`) ?? [];
    chain.sort((a, b) => b.before - a.before || Number(a.quantityReturn) - Number(b.quantityReturn));
    let current = units[index]!; let returned = false;
    for (const edge of chain) {
      requireFact(!returned && edge.before === current, h, 'Unit restoration chain has a gap, overlap or double consumption');
      current = edge.after; returned = edge.quantityReturn;
    }
    if (chain.length) remaining[line]![index] = current;
    if (returned) returnedIndexes[line]!.push(index);
  }
  const restored = sum(history.map(row => row.amount), h), retained = sum(Object.values(remaining).flat(), h);
  requireFact(restored + retained === redemption.amount, h, 'Full redemption conservation failed');
  for (const indexes of Object.values(returnedIndexes)) indexes.sort((a, b) => a - b);
  return { state: { remaining, returnedIndexes, redeemed: redemption.amount, restored, retained }, modern };
}

/** Shared authority for later refund/manual-return integrations, with no writes. */
export function readCreditFundingState(input: Pick<EditFundingInput, 'redemption' | 'history' | 'historyComplete'>):
  { ok: true; state: CreditFundingState } | EditFundingRefusal {
  try { return { ok: true, state: readState(input.redemption, input.history, input.historyComplete).state }; }
  catch (error) { if (error instanceof Refusal) return refusal(error); throw error; }
}

export function planEditCreditFunding(input: EditFundingInput): EditFundingResult {
  try {
    const { state, modern } = readState(input.redemption, input.history, input.historyComplete);
    const r = input.redemption;
    const rawLines: unknown = input.lines;
    requireFact(typeof input.editId === 'string' && UUID.test(input.editId) && Array.isArray(rawLines), 'INVALID_REQUEST', 'Native edit identity & target lines required');
    const lineIds = new Set<string>(), lines: EditFundingTargetLine[] = [];
    for (const rawLine of rawLines) {
      requireFact(object(rawLine) && typeof rawLine.orderLineId === 'string' && UUID.test(rawLine.orderLineId) &&
        !lineIds.has(rawLine.orderLineId) && Array.isArray(rawLine.units), 'INVALID_REQUEST', 'Duplicate or unproven target line');
      const orderLineId = rawLine.orderLineId, units: EditFundingTargetLine['units'] = [], seen = new Set<number>();
      lineIds.add(orderLineId);
      for (const rawUnit of rawLine.units) {
        requireFact(object(rawUnit), 'INVALID_REQUEST', 'Invalid immutable unit target');
        const unit = rawUnit, index = unit.originalIndex;
        requireFact(money(unit.maximumCredit) && (unit.consumed === undefined || typeof unit.consumed === 'boolean') &&
          (unit.unitId === undefined || typeof unit.unitId === 'string' && unit.unitId.length > 0 && unit.unitId.length <= 255) &&
          (index === null || (typeof index === 'number' && Number.isSafeInteger(index) && index >= 0 &&
          Object.hasOwn(state.remaining, orderLineId) && index < state.remaining[orderLineId]!.length && !seen.has(index))),
        'INVALID_REQUEST', 'Invalid or transferred immutable unit index');
        if (index !== null) seen.add(index);
        units.push({ originalIndex: index, maximumCredit: unit.maximumCredit,
          ...(unit.consumed === undefined ? {} : { consumed: unit.consumed }), ...(unit.unitId === undefined ? {} : { unitId: unit.unitId }) });
      }
      lines.push({ orderLineId, units });
    }
    const requestDigest = createHash('sha256').update(serialize({ redemptionId: r.id, editId: input.editId,
      lines: [...lines].sort((a, b) => a.orderLineId.localeCompare(b.orderLineId)) })).digest('hex');
    const ownRows = modern.filter((item): item is { row: EditFundingHistoryRow; envelope: EditFundingEnvelope } => item.envelope.type === 'account_credit.edit_restore' && item.envelope.editId === input.editId);
    if (input.committedEdit) {
      requireFact(input.committedEdit.editId === input.editId && input.committedEdit.requestDigest === requestDigest &&
        Array.isArray(input.committedEdit.postingKeys) && new Set(input.committedEdit.postingKeys).size === input.committedEdit.postingKeys.length &&
        serialize([...input.committedEdit.postingKeys].sort()) === serialize(ownRows.map(item => item.row.idempotencyKey).sort()) &&
        ownRows.every(item => item.envelope.requestDigest === requestDigest), 'REPLAY_CONFLICT', 'Edit replay payload or posted effect closure differs');
      return { ok: true, replay: true, requestDigest, postings: [], state };
    }
    requireFact(ownRows.length === 0, 'REPLAY_CONFLICT', 'Posted edit restoration lacks durable edit receipt');
    const allocation: Record<string, number[]> = {}, postings: EditFundingPosting[] = [];
    const target = new Map(lines.map(line => [line.orderLineId, line]));
    for (const [line, units] of Object.entries(state.remaining).sort(([a], [b]) => a.localeCompare(b))) {
      const wanted = new Map<number, number>();
      for (const unit of target.get(line)?.units ?? []) if (unit.originalIndex !== null) wanted.set(unit.originalIndex, unit.maximumCredit);
      const returned = new Set(state.returnedIndexes[line]);
      for (const index of wanted.keys()) {
        const unit = target.get(line)!.units.find(unit => unit.originalIndex === index)!;
        requireFact(returned.has(index) ? unit.consumed === true : unit.consumed !== true,
          'INVALID_REQUEST', 'Returned unit funding cannot be reattached or consumed without posted proof');
      }
      for (const cause of ['quantity_return', 'unit_correction'] as const) {
        const changes: EditFundingUnitChange[] = [];
        for (let index = 0; index < units.length; index++) {
          if (returned.has(index)) continue;
          const before = units[index]!, retained = wanted.has(index);
          if (cause === 'quantity_return' && !retained) changes.push({ index, before, after: 0 });
          if (cause === 'unit_correction' && retained && wanted.get(index)! < before) changes.push({ index, before, after: wanted.get(index)! });
        }
        if (!changes.length) continue;
        const envelope: EditFundingEnvelope = { version: 1, type: 'account_credit.edit_restore', cause,
          redemptionId: r.id, orderId: r.orderId!, accountCreditId: r.accountCreditId, orderLineId: line, editId: input.editId, requestDigest, units: changes };
        const cents = changes.map(u => u.before - u.after), amount = sum(cents, 'INVALID_REQUEST');
        postings.push({ kind: 'RESTORE', status: 'POSTED', relatedTransactionId: r.id, orderId: r.orderId!, accountCreditId: r.accountCreditId,
          orderLineId: line, quantity: cause === 'quantity_return' ? changes.length : 0, amount, delta: amount,
          idempotencyKey: keyFor(envelope), allocation: serialize(envelope), operationalAllocation: { [line]: cents } });
        for (const change of changes) { state.remaining[line]![change.index] = change.after;
          if (cause === 'quantity_return') state.returnedIndexes[line]!.push(change.index); }
      }
    }
    for (const line of lines) allocation[line.orderLineId] = line.units.map(unit => unit.originalIndex === null ? 0 : state.remaining[line.orderLineId]![unit.originalIndex]!);
    state.restored += sum(postings.map(p => p.amount), 'INVALID_REQUEST'); state.retained = sum(Object.values(state.remaining).flat(), 'INVALID_REQUEST');
    requireFact(state.restored + state.retained === state.redeemed && sum(Object.values(allocation).flat(), 'INVALID_REQUEST') === state.retained,
      'AMBIGUOUS_HISTORY', 'Planned funding does not conserve full redemption');
    for (const indexes of Object.values(state.returnedIndexes)) indexes.sort((a, b) => a - b);
    return { ok: true, replay: false, requestDigest, postings, allocation, state };
  } catch (error) { if (error instanceof Refusal) return refusal(error); throw error; }
}

/** Explicit current-unit selection; null identities are new, unfunded merchandise. */
export function planCreditUnitReturn(input: Pick<EditFundingInput, 'redemption' | 'history' | 'historyComplete'> & {
  operation: UnitRestoreEnvelope['operation']; orderLineId: string; originalIndexes: readonly (number | null)[];
}): EditFundingRefusal | { ok: true; posting: EditFundingPosting | null; state: CreditFundingState } {
  try {
    const { state } = readState(input.redemption, input.history, input.historyComplete);
    const { redemption: r, orderLineId: line, operation } = input;
    requireFact(UUID.test(line) && Array.isArray(input.originalIndexes) && input.originalIndexes.length > 0 &&
      operation && ['refund', 'manual_return'].includes(operation.kind) && typeof operation.id === 'string' &&
      operation.id.length > 0 && operation.id.length <= 153 && (operation.kind !== 'refund' || UUID.test(operation.id)),
    'INVALID_REQUEST', 'Explicit unit-return identity required');
    const seen = new Set<number>(), units: EditFundingUnitChange[] = [];
    for (const index of input.originalIndexes) {
      if (index === null) continue;
      requireFact(Number.isSafeInteger(index) && index >= 0 && Object.hasOwn(state.remaining, line) &&
        index < state.remaining[line]!.length && !seen.has(index) && !state.returnedIndexes[line]!.includes(index),
      'INVALID_REQUEST', 'Returned unit identity is missing, repeated or already consumed');
      seen.add(index); units.push({ index, before: state.remaining[line]![index]!, after: 0 });
    }
    if (!units.length) return { ok: true, posting: null, state };
    const envelope: UnitRestoreEnvelope = { version: 1, type: 'account_credit.unit_restore', cause: 'quantity_return',
      redemptionId: r.id, orderId: r.orderId!, accountCreditId: r.accountCreditId, orderLineId: line, operation, units };
    const cents = units.map(u => u.before), amount = sum(cents, 'INVALID_REQUEST');
    const posting: EditFundingPosting = { kind: 'RESTORE', status: 'POSTED', relatedTransactionId: r.id, orderId: r.orderId!,
      accountCreditId: r.accountCreditId, orderLineId: line, quantity: units.length, amount, delta: amount,
      idempotencyKey: keyFor(envelope), allocation: serialize(envelope), operationalAllocation: { [line]: cents },
      refundId: operation.kind === 'refund' ? operation.id : null };
    for (const unit of units) { state.remaining[line]![unit.index] = 0; state.returnedIndexes[line]!.push(unit.index); }
    state.returnedIndexes[line]!.sort((a, b) => a - b);
    state.restored += amount; state.retained -= amount;
    return { ok: true, posting, state };
  } catch (error) { if (error instanceof Refusal) return refusal(error); throw error; }
}
