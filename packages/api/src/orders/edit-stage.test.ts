import { describe, expect, it } from 'vitest';
import { allocateEditStageIds, assertEditStageActivation, buildEditStageProposal, buildEditSettlementAmendment, effectiveEditSettlementRequirement, isPendingEditStage, readEditStageProposal, retainedEditUnitPositions } from './edit-stage.js';
import type { Tx } from '../db/client.js';
import * as s from '../db/schema.js';

const A = 'cccccccc-0000-4000-8000-000000000001', B = 'cccccccc-0000-4000-8000-000000000002';
const hash = (n: string) => n.repeat(64);
function proposal(type = 'leave_credit', requiredTender = 0, requiredRefund = 0) {
  return buildEditStageProposal({ editId: A, orderId: B, requestFingerprint: hash('a'), previewAcceptanceHash: hash('b'),
    beforeFingerprint: hash('c'), beforeLedgerPrefixDigest: hash('d'), pricingSnapshot: { version: 2 }, lineIds: { old: A }, lines: [{ id: A }],
    couponCodes: ['RETAINED'], appliedPromotionIds: ['ordinary'], fundingPlan: { postings: [] }, requestDigest: hash('e'), postingKeys: [],
    settlementRequirement: { type, currency: 'USD', requiredTender, requiredRefund },
    stockReservationReceipt: { key: `order-edit:${A}:stock`, positiveDeltas: [] }, activation: { amount: 100 } });
}
describe('durable edit preparation protocol', () => {
  it('allocates native IDs once & validates frozen proposal digest on every read', () => {
    const ids = allocateEditStageIds([{ key: 'old', id: A }, { key: 'new:0', id: null }], B);
    expect(ids.editId).toBe(B); expect(ids.lineIds.old).toBe(A); expect(ids.lineIds['new:0']).toMatch(/^[0-9a-f-]{36}$/);
    const frozen = proposal(); const saved = structuredClone(frozen);
    expect(readEditStageProposal(frozen)).toEqual(saved);
    const corrupt = structuredClone(frozen); corrupt.couponCodes.push('NEW');
    expect(() => readEditStageProposal(corrupt)).toThrow('proposal digest'); expect(frozen).toEqual(saved);
  });

  it('keeps refund preparation inactive until exact linked refund settles', () => {
    const p = proposal('refund_now', 0, 100); const input = { proposal: p, settlement: { type: 'refund_now', status: 'pending', phase: 'awaiting_refund' as const, refundId: A },
      beforeFingerprint: p.beforeFingerprint, beforeLedgerPrefixDigest: p.beforeLedgerPrefixDigest };
    const linked = { id: A, state: 'Settled', orderId: B, currency: 'USD', amount: 100 };
    expect(() => assertEditStageActivation({ ...input, linkedRefund: { ...linked, state: 'Pending' } })).toThrow();
    expect(() => assertEditStageActivation({ ...input, linkedRefund: { ...linked, id: B } })).toThrow();
    expect(assertEditStageActivation({ ...input, linkedRefund: linked }).replay).toBe(false);
    expect(() => assertEditStageActivation({ ...input, beforeLedgerPrefixDigest: hash('f'), linkedRefund: linked })).toThrow();
  });

  it('requires settled tender for new cash liability even when leaving due or sending pay link', () => {
    for (const type of ['leave_due', 'send_pay_link']) {
      const p = proposal(type, 100);
      const input = { proposal: p, settlement: { type, status: 'due', phase: 'awaiting_tender' as const, paymentAttemptId: A },
        beforeFingerprint: p.beforeFingerprint, beforeLedgerPrefixDigest: p.beforeLedgerPrefixDigest };
      expect(() => assertEditStageActivation(input)).toThrow();
      expect(() => assertEditStageActivation({ ...input, linkedTender: { attemptId: A, state: 'Settled', orderId: B, currency: 'USD', amount: 99 } })).toThrow();
      expect(() => assertEditStageActivation({ ...input, linkedTender: { attemptId: A, state: 'Settled', orderId: B, currency: 'USD', amount: 101 } })).toThrow();
      expect(assertEditStageActivation({ ...input, linkedTender: { attemptId: A, state: 'Settled', orderId: B, currency: 'USD', amount: 100 } }).replay).toBe(false);
    }
  });

  it('retains consumed non-prefix units & count-held custody while removing only open tuples', () => {
    expect(retainedEditUnitPositions(5, 3, 2, [4])).toEqual([0, 1, 4]);
    expect(retainedEditUnitPositions(3, 5, 1, [2])).toEqual([0, 1, 2]);
    expect(() => retainedEditUnitPositions(5, 1, 2, [4])).toThrow('locked capacity');
    expect(() => retainedEditUnitPositions(5, 3, 1, [0, 4])).toThrow('consumed unit custody');
    expect(() => retainedEditUnitPositions(5, 3, 2, [4, 4])).toThrow('consumed unit custody');
  });

  it('binds leave-credit amendment without changing immutable economic proposal', () => {
    const p = proposal('refund_now', 0, 100), original = structuredClone(p);
    const amendment = buildEditSettlementAmendment(p, A, B);
    expect(amendment).toEqual(buildEditSettlementAmendment(p, A, B));
    expect(effectiveEditSettlementRequirement(p, amendment).requirement).toEqual({ type: 'leave_credit', currency: 'USD', requiredTender: 0, requiredRefund: 0 });
    expect(assertEditStageActivation({ proposal: p, settlementAmendment: amendment,
      settlement: { type: 'leave_credit', status: 'credit', phase: 'ready', amendmentDigest: amendment.digest },
      beforeFingerprint: p.beforeFingerprint, beforeLedgerPrefixDigest: p.beforeLedgerPrefixDigest }).replay).toBe(false);
    expect(() => assertEditStageActivation({ proposal: p, settlementAmendment: amendment,
      settlement: { type: 'leave_credit', status: 'credit', phase: 'ready' }, beforeFingerprint: p.beforeFingerprint, beforeLedgerPrefixDigest: p.beforeLedgerPrefixDigest })).toThrow('amendment binding');
    expect(() => effectiveEditSettlementRequirement(p, { ...amendment, requirement: { ...amendment.requirement, requiredTender: 1 } })).toThrow('amendment digest');
    expect(p).toEqual(original);
  });

  it('requires durable activation receipt even for zero-effect RESTORE plan', () => {
    const p = proposal(); const input = { proposal: p, settlement: { type: 'leave_credit', status: 'credit', phase: 'activated' as const },
      beforeFingerprint: hash('f'), beforeLedgerPrefixDigest: hash('f') };
    expect(() => assertEditStageActivation(input)).toThrow();
    expect(assertEditStageActivation({ ...input, settlement: { ...input.settlement, activationReceipt: { proposalDigest: p.proposalDigest,
      requestDigest: p.requestDigest, postingKeys: [], activatedAt: '2026-10-18T00:00:00Z' } } }).replay).toBe(true);
    expect(isPendingEditStage({ phase: 'failed' })).toBe(true); expect(isPendingEditStage({ phase: 'activated' })).toBe(false);
  });
});

describe('settled cash activation isolation', () => {
  it('keeps linked cash durable when proposal proof fails & records activation-only reconciliation', async () => {
    const { activatePreparedOrderEdit } = await import('./order-edit-service.js');
    const journal = { id: A, orderId: B, fingerprint: hash('a'), after: { proposal: { version: 1, malformed: true } },
      settlement: { type: 'refund_now', phase: 'awaiting_refund', status: 'pending', refundId: B } };
    const executions: unknown[] = [], writes: Array<{ table: unknown; values: unknown }> = [];
    const tx = {
      select: () => { const query = { from: () => query, where: () => query, limit: () => query, for: () => query,
        then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(resolve([journal])) }; return query; },
      execute: async (statement: unknown) => { executions.push(statement); },
      update: (table: unknown) => ({ set: (values: unknown) => ({ where: async () => { writes.push({ table, values }); } }) }),
      insert: (table: unknown) => ({ values: async (values: unknown) => { writes.push({ table, values }); } }),
    } as unknown as Tx;
    expect(await activatePreparedOrderEdit(tx, { storeId: A, orderId: B, refundId: B })).toBe(false);
    expect(executions).toHaveLength(3); // Savepoint, rollback only activation, release.
    expect(writes.some(write => write.table === s.payment || write.table === s.refund || write.table === s.order || write.table === s.accountCreditTransaction)).toBe(false);
    expect(writes.find(write => write.table === s.orderEdit)?.values).toMatchObject({ settlement: { refundId: B, phase: 'awaiting_refund', status: 'reconciliation_required' } });
    expect(writes.find(write => write.table === s.auditLog)?.values).toMatchObject({ action: 'edit_activation_reconciliation', data: { editId: A } });
  });
});
