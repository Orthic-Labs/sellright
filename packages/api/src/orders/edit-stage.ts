/** Durable order_edit JSON protocol. Live economics change only at activation. */
import { randomUUID } from 'node:crypto';
import { orderEditStoredFingerprint } from './order-edit-stack.js';
import { and, eq } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import * as s from '../db/schema.js';
import { OrderEditError } from './order-edit.js';

export type EditStagePhase = 'prepared' | 'awaiting_refund' | 'awaiting_tender' | 'ready' | 'activated' | 'failed';
export interface EditStageSettlement {
  phase: EditStagePhase; type: string; status: string; refundId?: string; paymentAttemptId?: string;
  amendmentDigest?: string;
  activationReceipt?: { proposalDigest: string; requestDigest: string; postingKeys: string[]; activatedAt: string; amendmentDigest?: string; activatedSnapshotHash?: string };
}
export interface EditSettlementAmendment {
  version: 1; id: string; kind: 'leave_credit'; baseProposalDigest: string; previousRequirementDigest: string;
  failedRefundId: string | null; failedAttemptId: string | null;
  requirement: EditStageProposal['settlementRequirement']; digest: string;
}
export interface EditStageProposal {
  version: 1; editId: string; orderId: string; requestFingerprint: string; previewAcceptanceHash: string;
  beforeFingerprint: string; beforeLedgerPrefixDigest: string;
  /** Complete current pricing, including immutable origin & native-line mapping. */
  pricingSnapshot: unknown; lineIds: Record<string, string>; lines: readonly unknown[];
  couponCodes: string[]; appliedPromotionIds: string[]; fundingPlan: unknown;
  requestDigest: string; postingKeys: string[];
  settlementRequirement: { type: string; currency: string; requiredTender: number; requiredRefund: number };
  stockReservationReceipt: { key: string; positiveDeltas: Array<{ variantId: string; quantity: number }> };
  /** Entire native activation payload is immutable & covered by proposalDigest. */
  activation: unknown; proposalDigest: string;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
function requireFact(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(`Invalid order edit stage: ${message}`); }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Allocate exactly once in preparation, then persist this map with proposal. */
export function allocateEditStageIds(lines: readonly { key: string; id: string | null }[], editId = randomUUID()) {
  requireFact(UUID.test(editId), 'edit identity');
  const lineIds: Record<string, string> = {};
  for (const line of lines) {
    requireFact(line.key.length > 0 && !Object.hasOwn(lineIds, line.key), 'logical line closure');
    lineIds[line.key] = line.id ?? randomUUID(); requireFact(UUID.test(lineIds[line.key]!), 'native line identity');
  }
  requireFact(new Set(Object.values(lineIds)).size === lines.length, 'native line bijection');
  return { editId, lineIds };
}

/** Count-only fulfillment assigns custody to earliest existing tuples; consumed IDs are exact. */
export function retainedEditUnitPositions(currentQuantity: number, quantity: number, lockedQuantity: number, consumedPositions: readonly number[]): number[] {
  requireFact([currentQuantity, quantity, lockedQuantity].every(n => Number.isSafeInteger(n) && n >= 0) && lockedQuantity <= currentQuantity && quantity >= lockedQuantity, 'unit quantity/locked capacity');
  const retained = new Set(consumedPositions);
  requireFact(retained.size === consumedPositions.length && consumedPositions.every(position => Number.isSafeInteger(position) && position >= 0 && position < currentQuantity) && retained.size <= lockedQuantity, 'consumed unit custody');
  for (let position = 0; position < currentQuantity && retained.size < lockedQuantity; position++) retained.add(position);
  for (let position = 0; position < currentQuantity && retained.size < quantity; position++) retained.add(position);
  requireFact(retained.size <= quantity, 'consumed unit quantity');
  return [...retained].sort((a, b) => a - b);
}

export function buildEditStageProposal(input: Omit<EditStageProposal, 'version' | 'proposalDigest'>): EditStageProposal {
  const payload = { ...structuredClone(input), version: 1 as const };
  const proposal = { ...payload, proposalDigest: orderEditStoredFingerprint(payload) };
  return readEditStageProposal(proposal);
}

export function readEditStageProposal(raw: unknown): EditStageProposal {
  requireFact(object(raw) && raw.version === 1 && UUID.test(String(raw.editId)) && UUID.test(String(raw.orderId)), 'version/order/edit identity');
  for (const key of ['requestFingerprint', 'previewAcceptanceHash', 'beforeFingerprint', 'beforeLedgerPrefixDigest', 'requestDigest', 'proposalDigest']) requireFact(HASH.test(String(raw[key])), key);
  requireFact(object(raw.lineIds) && Object.values(raw.lineIds).every(id => typeof id === 'string' && UUID.test(id)) &&
    new Set(Object.values(raw.lineIds)).size === Object.values(raw.lineIds).length && Array.isArray(raw.lines) && raw.lines.length === Object.keys(raw.lineIds).length, 'line closure');
  requireFact(Array.isArray(raw.couponCodes) && raw.couponCodes.every(code => typeof code === 'string' && code.length > 0 && code.length <= 255) &&
    new Set(raw.couponCodes.map(code => code.toLowerCase())).size === raw.couponCodes.length, 'complete canonical coupon membership');
  requireFact(Array.isArray(raw.appliedPromotionIds) && raw.appliedPromotionIds.every(id => typeof id === 'string' && id.length > 0) &&
    new Set(raw.appliedPromotionIds).size === raw.appliedPromotionIds.length, 'applied promotion set');
  requireFact(Array.isArray(raw.postingKeys) && raw.postingKeys.every(key => typeof key === 'string' && key.length > 0) && new Set(raw.postingKeys).size === raw.postingKeys.length, 'posting receipt');
  const requirement = raw.settlementRequirement;
  requireFact(object(requirement) && typeof requirement.type === 'string' && /^[A-Z]{3}$/.test(String(requirement.currency)) &&
    Number.isSafeInteger(requirement.requiredTender) && Number(requirement.requiredTender) >= 0 &&
    Number.isSafeInteger(requirement.requiredRefund) && Number(requirement.requiredRefund) >= 0 &&
    !(Number(requirement.requiredTender) > 0 && Number(requirement.requiredRefund) > 0), 'immutable settlement requirement');
  const stock = raw.stockReservationReceipt;
  requireFact(object(stock) && stock.key === `order-edit:${raw.editId}:stock` && Array.isArray(stock.positiveDeltas), 'stock reservation receipt');
  const variants = new Set<string>();
  for (const delta of stock.positiveDeltas) { requireFact(object(delta) && typeof delta.variantId === 'string' && UUID.test(delta.variantId) && !variants.has(delta.variantId) &&
    Number.isSafeInteger(delta.quantity) && Number(delta.quantity) > 0, 'stock reservation delta'); variants.add(delta.variantId); }
  requireFact(raw.pricingSnapshot != null && raw.fundingPlan != null && raw.activation != null, 'complete proposal economics');
  const { proposalDigest, ...payload } = raw; requireFact(proposalDigest === orderEditStoredFingerprint(payload), 'proposal digest');
  return structuredClone(raw) as unknown as EditStageProposal;
}

export function buildEditSettlementAmendment(proposal: EditStageProposal, failedRefundId: string | null, failedAttemptId: string | null): EditSettlementAmendment {
  const identity = orderEditStoredFingerprint({ editId: proposal.editId, action: 'credit', failedRefundId, failedAttemptId });
  const payload = { version: 1 as const, id: identity, kind: 'leave_credit' as const, baseProposalDigest: proposal.proposalDigest,
    previousRequirementDigest: orderEditStoredFingerprint(proposal.settlementRequirement), failedRefundId, failedAttemptId,
    requirement: { type: 'leave_credit', currency: proposal.settlementRequirement.currency, requiredTender: 0, requiredRefund: 0 } };
  return { ...payload, digest: orderEditStoredFingerprint(payload) };
}
export function effectiveEditSettlementRequirement(proposal: EditStageProposal, raw?: unknown) {
  if (raw == null) return { requirement: proposal.settlementRequirement, amendment: null };
  requireFact(proposal.settlementRequirement.type === 'refund_now' && proposal.settlementRequirement.requiredRefund > 0, 'amendment source requirement');
  requireFact(object(raw), 'settlement amendment');
  const expected = buildEditSettlementAmendment(proposal, raw.failedRefundId as string | null, raw.failedAttemptId as string | null);
  requireFact((raw.failedRefundId === null || typeof raw.failedRefundId === 'string' && UUID.test(raw.failedRefundId)) &&
    (raw.failedAttemptId === null || typeof raw.failedAttemptId === 'string' && UUID.test(raw.failedAttemptId)) &&
    orderEditStoredFingerprint(expected) === orderEditStoredFingerprint(raw), 'settlement amendment digest');
  return { requirement: expected.requirement, amendment: expected };
}

/** Pure precondition called under existing licence/order locks, before account locks. */
export function assertEditStageActivation(input: { proposal: unknown; settlement: EditStageSettlement;
  settlementAmendment?: unknown;
  beforeFingerprint: string; beforeLedgerPrefixDigest: string;
  linkedRefund?: { id: string; state: string; orderId: string; currency: string; amount: number };
  linkedTender?: { attemptId: string; state: string; orderId: string; currency: string; amount: number } }) {
  const proposal = readEditStageProposal(input.proposal), settlement = input.settlement;
  const { requirement, amendment } = effectiveEditSettlementRequirement(proposal, input.settlementAmendment);
  requireFact(settlement.amendmentDigest === amendment?.digest, 'settlement amendment binding');
  if (settlement.phase === 'activated') {
    requireFact(settlement.activationReceipt?.proposalDigest === proposal.proposalDigest && settlement.activationReceipt.requestDigest === proposal.requestDigest &&
      JSON.stringify(settlement.activationReceipt.postingKeys) === JSON.stringify(proposal.postingKeys) && settlement.activationReceipt.amendmentDigest === amendment?.digest, 'activation replay receipt');
    return { proposal, replay: true };
  }
  requireFact(input.beforeFingerprint === proposal.beforeFingerprint && input.beforeLedgerPrefixDigest === proposal.beforeLedgerPrefixDigest, 'before economics/ledger prefix changed');
  requireFact(settlement.phase !== 'failed' && settlement.phase !== 'prepared', 'settlement is not ready');
  requireFact(settlement.type === requirement.type, 'settlement type differs from accepted proposal');
  if (requirement.requiredRefund > 0) requireFact(settlement.refundId && input.linkedRefund?.id === settlement.refundId && input.linkedRefund.state === 'Settled' &&
    input.linkedRefund.orderId === proposal.orderId && input.linkedRefund.currency === requirement.currency && input.linkedRefund.amount === requirement.requiredRefund, 'linked refund is not settled');
  if (requirement.requiredTender > 0) requireFact(settlement.paymentAttemptId && input.linkedTender?.attemptId === settlement.paymentAttemptId &&
    input.linkedTender.state === 'Settled' && input.linkedTender.orderId === proposal.orderId && input.linkedTender.currency === requirement.currency && input.linkedTender.amount === requirement.requiredTender, 'linked tender is not settled');
  return { proposal, replay: false };
}

export function isPendingEditStage(settlement: unknown): boolean {
  return object(settlement) && ['prepared', 'awaiting_refund', 'awaiting_tender', 'ready', 'failed'].includes(String(settlement.phase));
}

/** Shared fence for economic consumers; linked settlement names its own edit. */
export async function assertNoPendingOrderEdit(tx: Tx, storeId: string, orderId: string, options: { allowEditId?: string } = {}) {
  const rows = await tx.select({ id: s.orderEdit.id, settlement: s.orderEdit.settlement }).from(s.orderEdit)
    .where(and(eq(s.orderEdit.storeId, storeId), eq(s.orderEdit.orderId, orderId)));
  if (rows.some(row => row.id !== options.allowEditId && isPendingEditStage(row.settlement))) {
    throw new OrderEditError(409, 'ORDER_EDIT_PENDING', 'Resolve the prepared order edit before changing its economics.');
  }
}
