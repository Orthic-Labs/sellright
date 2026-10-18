/**
 * Order editing (spec G13 / G5) — the DB-bound half. `orders/order-edit.ts`
 * holds the pure model; this loads the facts, builds a PLAN (new totals, line
 * diff, stock check, balance) and, for a commit, applies it atomically.
 *
 *  - previewOrderEdit: stateless, read-only (no locks, no writes).
 *  - commitOrderEdit: idempotent per key, rejects a stale preview, applies the
 *    edit + the in-transaction settlement parts (manual payment, pay-link
 *    email) under the order row lock, THEN (outside any transaction, as the
 *    refund engine requires) performs a refund_now settlement.
 *  - saveOrderAddress: the direct, same-country address save (G5).
 *
 * Stock (locked architecture): no caching anywhere. Reservation is live via
 * reserveStockOrThrow; only the UNFULFILLED delta per variant moves; callers
 * run onStockChanged after the commit.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gte, ilike, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { withAdvisoryLocks, withStore, type Tx } from '../db/client.js';
import { afterCommit } from '../db/after-commit.js';
import { LockSetUnstable, orderIdByCode, withLockedSet } from '../db/locks.js';
import { checkPlacement } from '../payments/policy/host.js';
import { PaymentPolicyUnavailableError, PaymentPolicyVetoError } from '../payments/policy/registry.js';
import * as s from '../db/schema.js';
import { hasConfirmableIntent, hasUnresolvedPayment } from '../payments/hold.js';
import { cancelOrderStripeIntents } from '../payments/stripe-reconcile.js';
import { licensedLineEditViolations } from '../licensing/edit-reconcile.js';
import { amountDueForOrder, applyPaymentResult, editRefundedTotal } from '../payments/settle.js';
import { editBalanceEffects, paidOrderEffects, recordSettlementOperation } from '../payments/settlement/record.js';
import { requestRefund, RefundError, isDuplicatePayment } from '../payments/refunds.js';
import { editedEarnTarget, orderLoyaltySnapshot, syncEditEarn } from '../loyalty/ledger.js';
import { editRefundReason } from '../payments/edit-refund.js';
import { loadOrderCouponCodes } from '../routes/order-facts.js';
import { loadCouponMatchContext } from '../money/coupon-context.js';
import { resolveTaxRate } from '../money/tax.js';
import { selectUnitPrice, variantPriceRuleFromConfig } from '../money/pricing.js';
import { resolvePromotionStack } from '../money/promotion-resolver.js';
import { migrationId } from '../import/context.js';
import { calculatePromotionStack, type StackInput } from '../money/promotion-stack.js';
import { buildOrderPricingSnapshot, type OrderPricingSnapshotV1 } from '../money/pricing-snapshot.js';
import { orderEditAcceptanceHash, orderEditStoredFingerprint, priceEditShippingCarriers, priceOrderEditStack, projectEditStackLines, readImportedOrderEditBasis, readImportedOrderEditComponents, OrderEditStackError, type OrderEditStackCandidate } from './order-edit-stack.js';
import { allocateEditStageIds, assertEditStageActivation, assertNoPendingOrderEdit, buildEditStageProposal, buildEditSettlementAmendment, effectiveEditSettlementRequirement, isPendingEditStage, readEditStageProposal, retainedEditUnitPositions, type EditStageProposal, type EditStageSettlement } from './edit-stage.js';
import { buildCurrentCreditPricingSnapshot, creditPricingSnapshotDigest, currentCreditFundingTargets, currentShippingSourceFacts, readCurrentOrderPricingSnapshot, type CreditPricingEvidence, type CurrentOrderPricing, type OrdinaryUnitFacts, type OrderPricingSnapshotV2, type OriginalUnitIndexes } from '../money/current-credit-pricing.js';
import { decodeCreditPricingOrigin, isImportedCreditOrigin, type CreditPricingOrigin } from '../money/imported-credit-origin.js';
import { planEditCreditFunding, type EditFundingPosting } from '../account-credit/edit-funding.js';
import { prepareEditCreditFunding, postEditCreditFunding, readCurrentCreditEvidence } from '../account-credit/service.js';
import { isMethodEligible, shippingRate, type ShippingCalculator } from '../shipping/calculator.js';
import { reserveStockOrThrow, StockReservationError } from './stock-reservation.js';
import { emitEvent } from '../webhooks/emit.js';
import { enqueueOrderBalanceDue, enqueueOrderUpdated, pickEmailAppKey, resolveStorefrontUrl, type StoreEmailCtx } from '../email/dispatch.js';
import { normalizeEmail } from '../auth/email.js';
import { loadImportedOrderHistory } from './imported-order-history.js';
import { assertImportedEditAllowed, classifyImportedEditAdmission } from './imported-edit-admission.js';
import { importedEditSource, importedSourceMetadata, importedPricingBasis as buildImportedPricingBasis, type ImportedPricingBasis } from '../import/source-compatibility.js';
import {
  OrderEditError, applyEditOps, countryChanged, diffLines, lockedQty, openQty, planChangesEntitlements, priceWorkingOrder, readAddress,
  referencedKeys, sameAddress, validateSettlement, allowedSettlements,
  type Address, type EditOpT, type LineDiff, type OrderSnapshot, type PromoFacts, type SettlementT,
  type ShippingMethodFacts, type VariantFacts, type WLine, type WorkingOrder,
} from './order-edit.js';

export { OrderEditError } from './order-edit.js';

type OrderRow = typeof s.order.$inferSelect;
type VariantRow = typeof s.productVariant.$inferSelect;

const EDITABLE_STATES = new Set(['PendingPayment', 'Paid', 'PartiallyRefunded']);

const importedEditAdmission = (metadata: unknown) => classifyImportedEditAdmission(importedEditSource(metadata));

/** Throws unless this order may take these ops. Cancelled: nothing. Refunded:
 *  address changes only (G5 — "address edit allowed until Cancelled"). */
export function assertEditable(state: string, ops: EditOpT[]): void {
  const addressOnly = ops.length > 0 && ops.every((o) => o.op === 'set_address');
  if (state === 'Cancelled') throw new OrderEditError(409, 'ORDER_NOT_EDITABLE', 'a cancelled order cannot be edited');
  if (!EDITABLE_STATES.has(state) && !(addressOnly && state === 'Refunded')) {
    throw new OrderEditError(409, 'ORDER_NOT_EDITABLE', `a ${state} order cannot be edited (only its address can)`);
  }
}

// ── plan ─────────────────────────────────────────────────────────────────────
export interface StockCheck { sku: string; name: string; variantId: string; delta: number; available: number | null; ok: boolean }
export interface BalanceInfo {
  newGrandTotal: number; settled: number; refunded: number; netPaid: number;
  /** Money handed back by earlier order edits (already reflected in grandTotal). */
  editRefunded: number;
  /** newGrandTotal - settled + editRefunded: + the customer owes, - owed back. */
  amountDue: number;
}
export interface RefundablePayment { id: string; method: string; amount: number; available: number }
export interface EditPricingOptions { recalculateShipping?: boolean; recalculateShippingPromotions?: boolean }
function editPricingOptions(options: EditPricingOptions): Required<EditPricingOptions> {
  const recalculateShipping = options.recalculateShipping !== false;
  return { recalculateShipping, recalculateShippingPromotions: options.recalculateShippingPromotions ?? recalculateShipping };
}
export interface EditPlan {
  pricingOptions: Required<EditPricingOptions>;
  order: OrderRow;
  working: WorkingOrder;
  before: OrderSnapshot;
  after: OrderSnapshot;
  lineDiffs: LineDiff[];
  priced: Omit<ReturnType<typeof priceWorkingOrder>, 'perLine'> & { perLine: Array<{ key: string; unitPrice: number; lineSubtotal: number; lineDiscount: number; lineTax: number; lineTotal: number }> };
  stock: StockCheck[];
  /** per-variant allocation delta (+ reserve, - release), physical non-preorder only */
  stockDeltas: Map<string, number>;
  balance: BalanceInfo;
  refundable: RefundablePayment[];
  warnings: string[];
  promotionRow: PromoFacts | null;
  shipping: { amount: number; base: number; override: boolean; methodCode: string | null; methodName: string | null };
  address: { shipping: { changed: boolean; countryChanged: boolean }; billing: { changed: boolean } };
  variantsById: Map<string, VariantRow>;
  isPreOrder: boolean;
  storeCtx: StoreEmailCtx;
  recipient: string | null;
  customerId: string | null;
  taxRate: number;
  taxInclusive: boolean;
  stack: OrderEditStackCandidate;
  storedLines: Array<typeof s.orderLine.$inferSelect>;
  storedFingerprint: string;
  importedPricingBasis?: ImportedPricingBasis;
  legacyPricingSnapshot?: OrderPricingSnapshotV1;
  previewAcceptanceHash: string;
  credit: { current: CurrentOrderPricing; evidence: CreditPricingEvidence; origin: CreditPricingOrigin;
    indexes: OriginalUnitIndexes; ordinary: OrderPricingSnapshotV1; ordinaryUnitFacts: OrdinaryUnitFacts;
    pricing: OrderPricingSnapshotV2; ledgerPrefixDigest: string; creditCode: string } | null;
}

type OrderMeta = {
  shipping?: { methodCode?: string | null; base?: number };
  taxInclusive?: boolean;
  loyalty?: { pointsDiscount?: number };
  contact?: { email?: string };
};

const asFacts = (v: VariantRow): VariantFacts => v;

function logicalUuid(key: string): string {
  const hex = createHash('sha256').update(key).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
function fundingPrefixDigest(evidence: CreditPricingEvidence): string {
  return orderEditStoredFingerprint({ redemption: evidence.redemption,
    history: [...evidence.history].sort((a, b) => a.id.localeCompare(b.id)) });
}
function refundPrefixDigest(evidence: CreditPricingEvidence, ownRefundId?: string): string {
  if (evidence.refundsComplete !== true || !evidence.refunds) throw new OrderEditError(409, 'CREDIT_ALLOCATION_INVALID', 'Complete refund custody evidence is absent.');
  const own = evidence.refunds.find(refund => refund.id === ownRefundId);
  if (own?.lines.length) throw new OrderEditError(409, 'CREDIT_ALLOCATION_INVALID', 'Prepared settlement refund cannot consume merchandise.');
  return orderEditStoredFingerprint(evidence.refunds.filter(refund => refund.id !== ownRefundId).sort((a, b) => a.id.localeCompare(b.id)));
}
function plannedFundingEvidence(evidence: CreditPricingEvidence, postings: readonly EditFundingPosting[]): CreditPricingEvidence {
  return { ...evidence, history: [...evidence.history, ...postings.map(posting => ({ ...posting,
    id: logicalUuid(`account-credit:${posting.idempotencyKey}`), refundId: null }))] };
}
function ordinaryProducerFacts(stack: OrderEditStackCandidate, ids: ReadonlyMap<string, string>): OrdinaryUnitFacts {
  return Object.fromEntries(stack.result.lineSnapshots.map(line => {
    if (line.sourceAdjustmentTotal === undefined || line.sourceAdjustmentDivisor === undefined) throw new OrderEditError(409, 'ORDER_PRICING_EDIT_UNSUPPORTED', 'Ordinary unit producer facts are absent.');
    return [ids.get(line.lineKey)!, { sourceAdjustmentTotal: line.sourceAdjustmentTotal, sourceAdjustmentDivisor: line.sourceAdjustmentDivisor }];
  }));
}
function creditMaterial(input: { stack: OrderEditStackCandidate; working: WorkingOrder; current: CurrentOrderPricing;
  evidence: CreditPricingEvidence; pricingSources: Awaited<ReturnType<typeof loadPricingLineage>>['pricingSources']; origin: CreditPricingOrigin; creditCode: string; editId: string; lineIds: ReadonlyMap<string, string> }) {
  const ordinary = buildOrderPricingSnapshot(input.stack.input, input.stack.result, input.lineIds);
  const unitIds: Record<string, string[]> = {}, consumedPositions: Record<string, number[]> = {};
  const indexes: OriginalUnitIndexes = Object.fromEntries(input.working.lines.map(line => {
    const prior = line.id ? input.current.originalUnitIndexes[line.id] ?? [] : [];
    const unchangedVariant = !line.original || line.original.variantId === line.variantId;
    const consumed = new Set(line.id ? input.current.consumedPositions[line.id] ?? [] : []);
    if (!unchangedVariant && consumed.size) throw new OrderEditError(409, 'CREDIT_ALLOCATION_INVALID', 'Consumed unit identities cannot be swapped.');
    const positions = unchangedVariant ? retainedEditUnitPositions(prior.length, line.quantity, lockedQty(line), [...consumed]) : [], id = input.lineIds.get(line.key)!;
    const selected = positions.map(position => prior[position]!);
    const newCount = Math.max(0, line.quantity - selected.length);
    unitIds[id] = [...positions.map(position => input.current.unitIds[line.id!]![position]!), ...Array.from({ length: newCount }, (_, ordinal) => `edit:${input.editId}:${id}:${ordinal}`)];
    consumedPositions[id] = positions.flatMap((position, next) => consumed.has(position) ? [next] : []);
    return [id, [...selected, ...Array(newCount).fill(null)]];
  }));
  const ordinaryUnitFacts = ordinaryProducerFacts(input.stack, input.lineIds);
  const targets = currentCreditFundingTargets(ordinary, indexes, decodeCreditPricingOrigin(input.origin).pricesIncludeTax ? 'gross' : 'net', ordinaryUnitFacts,
    { consumedPositions, sourceCustody: input.current.sourceCustody, liveDetachedAllocation: input.current.liveDetachedAllocation, consumedUnitIds: input.current.consumedSourceUnitIds });
  // Removing retained bearer membership restores every remaining funded cent.
  const retained = input.working.couponCodes.some(member => member.toLowerCase() === input.creditCode.toLowerCase());
  if (!retained) for (const line of targets) for (const unit of line.units) unit.maximumCredit = 0;
  const plan = planEditCreditFunding({ ...input.evidence, editId: input.editId, lines: targets });
  if (!plan.ok || plan.replay) throw new OrderEditError(409, 'CREDIT_ALLOCATION_INVALID', plan.ok ? 'Edit preparation unexpectedly replayed.' : plan.message);
  const pricing = buildCurrentCreditPricingSnapshot({ origin: input.origin, ordinary, couponCodes: input.working.couponCodes,
    evidence: plannedFundingEvidence(input.evidence, plan.postings), pricingSources: input.pricingSources, originalUnitIndexes: indexes, ordinaryUnitFacts, unitIds, predecessor: input.current, sourceCustody: input.current.sourceCustody,
    lineage: { editId: input.editId, predecessorSnapshotDigest: creditPricingSnapshotDigest(input.current.snapshot), consumedUnitIds: input.current.consumedSourceUnitIds } });
  return { ordinary, indexes, ordinaryUnitFacts, targets, plan, pricing, unitIds, consumedPositions };
}

async function loadPricingLineage(tx: Tx, storeId: string, orderId: string) {
  const edits = await tx.select({ id: s.orderEdit.id, orderId: s.orderEdit.orderId, before: s.orderEdit.before, after: s.orderEdit.after, settlement: s.orderEdit.settlement }).from(s.orderEdit).where(and(eq(s.orderEdit.storeId, storeId), eq(s.orderEdit.orderId, orderId)));
  return { pricingSources: edits };
}

type PricedTotals = { subtotal: number; discountTotal: number; shippingTotal: number; taxTotal: number; grandTotal: number };
/** True when the edit leaves every priced total (so the amount basis) unchanged. */
export function totalsInert(a: PricedTotals, b: PricedTotals): boolean {
  return a.subtotal === b.subtotal && a.discountTotal === b.discountTotal && a.shippingTotal === b.shippingTotal
    && a.taxTotal === b.taxTotal && a.grandTotal === b.grandTotal;
}

/** A set that cannot be taken within its restarts (lock timeout or plan churn) is a
 *  transient 503 for the caller, never a partial edit (STOREKIT §5.2). */
const orderBusy = (e: unknown): never => {
  if (e instanceof LockSetUnstable) throw new OrderEditError(503, 'ORDER_BUSY', 'the order is busy — try again in a moment');
  throw e;
};

/** Order id for a set subject (unlocked read). A missing order is the same 404 as the plan. */
async function lockableOrderId(storeId: string, code: string): Promise<string> {
  const id = await orderIdByCode(storeId, code);
  if (!id) throw new OrderEditError(404, 'ORDER_NOT_FOUND', 'order not found');
  return id;
}

/** Legacy editing cannot reproduce immutable stacked/unit-vector pricing. */
async function pricingEditProtected(tx: Tx, storeId: string, order: typeof s.order.$inferSelect, proposedCodes: readonly string[] = []): Promise<boolean> {
  const source = importedSourceMetadata(order.metadata);
  // This is capability admission only. Planning validates every retained raw
  // record, financial projection & immutable credit origin before pricing.
  const importedBasis = source?.editBasisV1 != null;
  if (order.pricingSnapshot == null && source && !importedBasis) return true;
  if (order.pricingSnapshot != null && ![1, 2].includes(Number((order.pricingSnapshot as { version?: unknown }).version))) return true;
  const [ledger] = await tx.select({ id: s.accountCreditTransaction.id }).from(s.accountCreditTransaction)
    .where(and(eq(s.accountCreditTransaction.storeId, storeId), eq(s.accountCreditTransaction.orderId, order.id))).limit(1);
  if (ledger && order.pricingSnapshot == null && !importedBasis) return true;
  const codes = new Set([...order.couponCodes, ...proposedCodes].map(code => code.toLowerCase()));
  const usages = await tx.select({ promotionId: s.promotionUsage.promotionId }).from(s.promotionUsage)
    .where(and(eq(s.promotionUsage.storeId, storeId), eq(s.promotionUsage.orderId, order.id)));
  const applied = new Set([order.promotionId, ...usages.map(usage => usage.promotionId)]);
  const promotions = await tx.select({ id: s.promotion.id, code: s.promotion.code, type: s.promotion.type, scope: s.promotion.discountScope }).from(s.promotion).where(eq(s.promotion.storeId, storeId));
  const snapshot = order.pricingSnapshot as CreditPricingOrigin | OrderPricingSnapshotV2 | null;
  const redemptions = importedBasis && order.pricingSnapshot == null ? await tx.select({ accountCreditId: s.accountCreditTransaction.accountCreditId }).from(s.accountCreditTransaction)
    .where(and(eq(s.accountCreditTransaction.storeId, storeId), eq(s.accountCreditTransaction.orderId, order.id), eq(s.accountCreditTransaction.kind, 'REDEEM'), eq(s.accountCreditTransaction.status, 'POSTED'))) : [];
  const [retainedAccount] = redemptions.length === 1 ? await tx.select({ promotionId: s.accountCredit.promotionId }).from(s.accountCredit)
    .where(and(eq(s.accountCredit.storeId, storeId), eq(s.accountCredit.id, redemptions[0]!.accountCreditId))).limit(1) : [];
  const retainedId = snapshot?.version === 2 ? snapshot.credit.promotionId : isImportedCreditOrigin(snapshot) ? snapshot.accountSource.promotionId : snapshot?.selectedCredit?.promotionId ?? retainedAccount?.promotionId;
  if (ledger && !retainedId) return true;
  return promotions.some(promotion => (applied.has(promotion.id) || (promotion.code != null && codes.has(promotion.code.toLowerCase()))) &&
    promotion.type === 'account_credit' && promotion.id !== retainedId);
}

export async function planOrderEdit(tx: Tx, storeId: string, code: string, ops: EditOpT[], opts: { lock: boolean } & EditPricingOptions): Promise<EditPlan> {
  const pricingOptions = editPricingOptions(opts);
  const [order] = opts.lock
    ? await tx.select().from(s.order).where(eq(s.order.code, code)).limit(1).for('update')
    : await tx.select().from(s.order).where(eq(s.order.code, code)).limit(1);
  if (!order || order.deletedAt) throw new OrderEditError(404, 'ORDER_NOT_FOUND', 'order not found');
  assertImportedEditAllowed(importedEditAdmission(order.metadata), 'plan');
  assertEditable(order.state, ops);
  const stages = await tx.select({ settlement: s.orderEdit.settlement }).from(s.orderEdit)
    .where(and(eq(s.orderEdit.storeId, storeId), eq(s.orderEdit.orderId, order.id)));
  if (stages.some(stage => isPendingEditStage(stage.settlement))) {
    throw new OrderEditError(409, 'ORDER_EDIT_PENDING', 'Resolve the prepared order edit before changing its economics.');
  }
  if (await pricingEditProtected(tx, storeId, order, referencedKeys(ops).coupons)) {
    throw new OrderEditError(409, 'ORDER_PRICING_EDIT_UNSUPPORTED', 'This order supports address changes only; its saved pricing must remain intact.');
  }
  const addressOnly = ops.length > 0 && ops.every((o) => o.op === 'set_address');
  if (!addressOnly && await hasUnresolvedPayment(tx, order.id)) {
    throw new OrderEditError(409, 'PAYMENT_UNRESOLVED', 'resolve the pending payment before editing this order');
  }
  const meta = (order.metadata ?? {}) as OrderMeta;

  const dbLines = await tx.select().from(s.orderLine).where(eq(s.orderLine.orderId, order.id));
  const dbAdjustments = await tx.select().from(s.orderAdjustment).where(eq(s.orderAdjustment.orderId, order.id)).orderBy(asc(s.orderAdjustment.createdAt));
  const [storeRow] = await tx.select().from(s.store).where(eq(s.store.id, storeId)).limit(1);
  if (!storeRow) throw new OrderEditError(404, 'STORE_NOT_FOUND', 'store not found');
  const zones = await tx.select({ countries: s.taxZone.countries, rate: s.taxZone.rate, priority: s.taxZone.priority }).from(s.taxZone).where(eq(s.taxZone.enabled, true));
  const methods = await tx.select().from(s.shippingMethod).where(eq(s.shippingMethod.enabled, true));
  const refs = referencedKeys(ops);

  const lineVariantIds = [...new Set(dbLines.map((l) => l.variantId).filter((x): x is string => !!x))];
  const variantRows: VariantRow[] = [];
  if (lineVariantIds.length) variantRows.push(...await tx.select().from(s.productVariant).where(inArray(s.productVariant.id, lineVariantIds)));
  if (refs.skus.length) {
    const bySku = await tx.select().from(s.productVariant).where(and(inArray(s.productVariant.sku, refs.skus), isNull(s.productVariant.deletedAt)));
    for (const v of bySku) if (!variantRows.some((x) => x.id === v.id)) variantRows.push(v);
  }
  const variantsById = new Map(variantRows.map((v) => [v.id, v]));
  const variantsBySku = new Map(variantRows.map((v) => [v.sku, asFacts(v)]));

  const now = new Date();
  const promosByCode = new Map<string, PromoFacts>();
  if (refs.coupons.length) {
    const rows = await tx.select().from(s.promotion).where(and(
      eq(s.promotion.storeId, storeId), eq(s.promotion.enabled, true),
      or(isNull(s.promotion.startsAt), lte(s.promotion.startsAt, now)), or(isNull(s.promotion.endsAt), gte(s.promotion.endsAt, now)),
    ));
    for (const r of rows) if (r.code && r.type !== 'account_credit') promosByCode.set(r.code, { ...r, type: r.type });
  }
  const methodsByCode = new Map<string, ShippingMethodFacts>(methods.map((m) => [m.code, m]));
  const priceRule = variantPriceRuleFromConfig(storeRow.config);

  const initial: WorkingOrder = {
    lines: dbLines.map((l): WLine => ({
      key: l.id, id: l.id, variantId: l.variantId, sku: l.variantSku, name: l.variantName, unitPrice: l.unitPrice, quantity: l.quantity,
      fulfilledQty: l.fulfilledQty, refundedQty: l.refundedQty, cancelledQty: l.cancelledQty,
      original: { variantId: l.variantId, sku: l.variantSku, name: l.variantName, unitPrice: l.unitPrice, quantity: l.quantity },
    })),
    adjustments: dbAdjustments.map((a) => ({ id: a.id, label: a.label, amount: a.amount })),
    couponCodes: await loadOrderCouponCodes(tx, order),
    promotion: { kind: 'keep' }, shipping: { kind: 'keep' }, saveToAddressBook: false,
  };
  const working = applyEditOps(initial, ops, { variantsBySku, promosByCode, methodsByCode, unitPriceFor: (v) => selectUnitPrice(v, priceRule) });

  // ── pricing inputs ─────────────────────────────────────────────────────────
  const warnings: string[] = [];
  const beforeShip = readAddress(order.shippingAddress);
  const beforeBill = readAddress(order.billingAddress);
  const afterShip = working.shippingAddress ?? beforeShip;
  const afterBill = working.billingAddress ?? beforeBill;
  const country = afterShip?.country ?? null;
  const taxRate = resolveTaxRate(zones, country, storeRow.taxRate);
  const taxInclusive = meta.taxInclusive ?? storeRow.taxInclusive;

  const productIdOf = (l: WLine) => (l.variantId ? variantsById.get(l.variantId)?.productId ?? null : null);

  // Promotion.
  const [currentPromo] = order.promotionId ? await tx.select().from(s.promotion).where(eq(s.promotion.id, order.promotionId)).limit(1) : [];
  let promotionRow: PromoFacts | null = null;

  // Shipping.
  const storedBase = meta.shipping?.base ?? order.shippingTotal;
  let baseShipping = storedBase;
  let shippingOverride = order.shippingOverride;
  let methodCode: string | null = order.shippingMethodCode ?? meta.shipping?.methodCode ?? null;
  const storedMethodCode = methodCode;
  let calc: ShippingCalculator | undefined;
  if (working.shipping.kind === 'method') {
    const m = working.shipping.method;
    calc = m.calculator as ShippingCalculator;
    baseShipping = shippingRate(calc); shippingOverride = false; methodCode = m.code;
  } else if (working.shipping.kind === 'custom') {
    baseShipping = working.shipping.amount; shippingOverride = true; methodCode = null;
  } else if (working.shipping.kind === 'none') {
    baseShipping = 0; shippingOverride = true; methodCode = null;
  }

  let priced: EditPlan['priced'];
  // Admit current stored economics before replacing the singleton calculator.
  // A native legacy row must reproduce its complete stored amounts; imported
  // rows without a proven raw basis remain protected above.
  const rawPricing = order.pricingSnapshot as CreditPricingOrigin | OrderPricingSnapshotV2 | null;
  const storedMoney = { subtotal: order.subtotal, discountTotal: order.discountTotal, shippingTotal: order.shippingTotal,
    taxTotal: order.taxTotal, grandTotal: order.grandTotal, pointsDiscount: isImportedCreditOrigin(rawPricing) ? rawPricing.capture.totals.pointsDiscount : rawPricing != null
      ? rawPricing.totals.pointsDiscount : Math.max(0, Math.floor(meta.loyalty?.pointsDiscount ?? 0)) };
  const nativeLines = dbLines.map(line => ({ key: line.id, id: line.id, quantity: line.quantity }));
  // Pending imported credit refunds have no source unit authority until actual
  // settlement. Classify that actionable interlock before decoding an origin.
  const [committedCredit] = await tx.select({ id: s.accountCreditTransaction.id }).from(s.accountCreditTransaction)
    .where(and(eq(s.accountCreditTransaction.storeId, storeId), eq(s.accountCreditTransaction.orderId, order.id), eq(s.accountCreditTransaction.kind, 'REDEEM'), eq(s.accountCreditTransaction.status, 'POSTED'))).limit(1);
  if (committedCredit) {
    const refunds = await tx.select({ state: s.refund.state, metadata: s.refund.metadata }).from(s.refund)
      .where(and(eq(s.refund.storeId, storeId), eq(s.refund.orderId, order.id), sql`${s.refund.state} <> 'Failed'`));
    if (refunds.some(refund => { const metadata = refund.metadata as { creditRestoration?: { status?: string; state?: string }; stockEffects?: { state?: string }; merchandiseCompletion?: { state?: string } } | null;
      const restoration = metadata?.creditRestoration;
      return refund.state !== 'Settled' || restoration?.status === 'reconciliation_required' || restoration?.state === 'reconciliation_required' || metadata?.stockEffects?.state === 'pending' || metadata?.merchandiseCompletion?.state === 'pending'; })) {
      throw new OrderEditError(409, 'REFUND_UNRESOLVED', 'Resolve pending merchandise refunds before editing credited pricing.');
    }
  }
  const creditEvidence = await readCurrentCreditEvidence(tx, { storeId, orderId: order.id });
  const pricingLineage = await loadPricingLineage(tx, storeId, order.id);
  const importedBasis = (order.pricingSnapshot == null || isImportedCreditOrigin(rawPricing)) && importedSourceMetadata(order.metadata)
    ? readImportedOrderEditBasis(order.metadata, { storeId, orderId: order.id, currency: order.currency, orderLines: dbLines, couponCodes: initial.couponCodes }) : null;
  const initialCreditPricing = importedBasis && creditEvidence && order.pricingSnapshot == null ? (() => {
    if (!creditEvidence.importedOrigin) throw new OrderEditError(409, 'CREDIT_ALLOCATION_INVALID', 'Retained imported account/redemption source proof is absent.');
    return creditEvidence.importedOrigin;
  })() : null;
  let snapshot: CurrentOrderPricing | null;
  try { snapshot = readCurrentOrderPricingSnapshot(initialCreditPricing ?? order.pricingSnapshot, { currency: order.currency, orderLines: nativeLines, totals: storedMoney, mode: 'settlement', creditEvidence: creditEvidence ?? undefined, ...pricingLineage }); }
  catch { throw new OrderEditError(409, 'ORDER_PRICING_EDIT_UNSUPPORTED', 'Saved pricing evidence does not match this order.'); }
  if (snapshot?.selectedCredit && !creditEvidence) throw new OrderEditError(409, 'CREDIT_ALLOCATION_INVALID', 'Immutable credit redemption proof is absent.');
  if (snapshot?.selectedCredit) {
    const [pendingReserve] = await tx.select({ id: s.accountCreditTransaction.id }).from(s.accountCreditTransaction)
      .where(and(eq(s.accountCreditTransaction.storeId, storeId), eq(s.accountCreditTransaction.orderId, order.id), eq(s.accountCreditTransaction.kind, 'RESERVE'), eq(s.accountCreditTransaction.status, 'PENDING'))).limit(1);
    if (pendingReserve) throw new OrderEditError(409, 'CREDIT_ALLOCATION_INVALID', 'Posted redemption has a contradictory pending reserve.');
  }
  const [retainedCreditPromotion] = snapshot?.selectedCredit ? await tx.select({ code: s.promotion.code }).from(s.promotion)
    .where(and(eq(s.promotion.storeId, storeId), eq(s.promotion.id, snapshot.selectedCredit.promotionId))).limit(1) : [];
  if (snapshot?.selectedCredit && !retainedCreditPromotion?.code) throw new OrderEditError(409, 'CREDIT_ALLOCATION_INVALID', 'Retained credit bearer identity is absent.');
  if (snapshot) {
    if (JSON.stringify(snapshot.couponCodes) !== JSON.stringify(initial.couponCodes)) {
      throw new OrderEditError(409, 'ORDER_PRICING_EDIT_UNSUPPORTED', 'Saved pricing differs from complete stored coupon membership.');
    }
    const byId = new Map(snapshot.lines.map(line => [line.orderLineId, line]));
    if (dbLines.some(line => {
      const saved = byId.get(line.id)!;
      const netList = saved.priceIncludesTax ? saved.unitListPrice / (1 + saved.taxRateBps / 10000) : saved.unitListPrice;
      const nativeProjection = line.unitPrice === Math.round(netList) && line.lineSubtotal === Math.round(netList * saved.quantity) &&
        line.lineDiscount === Math.round(netList * saved.quantity) - saved.lineNet && line.lineTax === saved.lineGross - saved.lineNet && line.lineTotal === saved.lineGross;
      // Existing checkout V1 writers stored line columns in each line's input
      // basis, with zero lineTax. Admit only that exact documented projection.
      const oldTotal = saved.priceIncludesTax ? saved.lineGross : saved.lineNet;
      const checkoutProjection = line.unitPrice === saved.unitListPrice && line.lineSubtotal === saved.unitListPrice * saved.quantity &&
        line.lineDiscount === saved.unitListPrice * saved.quantity - oldTotal && line.lineTax === 0 && line.lineTotal === oldTotal;
      return !nativeProjection && !checkoutProjection;
    })) throw new OrderEditError(409, 'ORDER_PRICING_EDIT_UNSUPPORTED', 'Saved pricing differs from stored financial lines.');
    for (const line of nativeLines) line.key = byId.get(line.id)!.key;
    for (const line of working.lines) if (line.id) line.key = byId.get(line.id)!.key;
  }
  const originalByKey = new Map((snapshot?.lines ?? importedBasis?.lines ?? []).map(line => [line.key, line]));
  const sourceKey = importedSourceMetadata(order.metadata)?.sourceKey;
  const priorOrdinary = snapshot ? snapshot.snapshot.version === 2 ? snapshot.snapshot.ordinary : isImportedCreditOrigin(snapshot.snapshot) ? null : snapshot.snapshot : null;
  const retainedComponents = importedBasis ?? (importedSourceMetadata(order.metadata)?.editBasisV1
    ? readImportedOrderEditComponents(order.metadata, order.currency) : null);
  const sourceSurcharges = new Map<string, NonNullable<NonNullable<StackInput['adjustments']>[number]['sourceSurcharge']>>();
  if (importedBasis) {
    if (typeof sourceKey !== 'string') throw new OrderEditError(409, 'ORDER_PRICING_EDIT_UNSUPPORTED', 'Imported surcharge source identity is absent.');
    for (const charge of importedBasis.surcharges) {
      const id = migrationId(storeId, sourceKey, 'order-adjustment', charge.sourceId), row = dbAdjustments.find(item => item.id === id);
      if (!row || row.amount !== charge.net || row.label !== charge.description) throw new OrderEditError(409, 'ORDER_PRICING_EDIT_UNSUPPORTED', 'Stored surcharge differs from retained source getter.');
      sourceSurcharges.set(id, { sourceId: charge.sourceId, sourceDigest: importedBasis.sourceDigest, net: charge.net, gross: charge.gross });
    }
  } else for (const adjustment of priorOrdinary?.adjustments ?? []) if (adjustment.sourceSurcharge) {
    if (typeof sourceKey !== 'string') throw new OrderEditError(409, 'ORDER_PRICING_EDIT_UNSUPPORTED', 'Imported surcharge source identity is absent.');
    const source = adjustment.sourceSurcharge, id = migrationId(storeId, sourceKey, 'order-adjustment', source.sourceId), row = dbAdjustments.find(item => item.id === id);
    if (!row || row.amount !== source.net || row.amount !== adjustment.amount) throw new OrderEditError(409, 'ORDER_PRICING_EDIT_UNSUPPORTED', 'Stored surcharge differs from current pricing.');
    sourceSurcharges.set(id, source);
  }
  // Every line, including zero rows, needs exact authoritative product facts.
  const facts = await loadCouponMatchContext(tx, [...new Set(variantRows.map(variant => variant.productId))]);
  const items = working.lines.map(line => {
    const productId = productIdOf(line); const product = productId ? facts.get(productId) : undefined;
    if (!productId || !product) throw new OrderEditError(409, 'ORDER_PRICING_EDIT_UNSUPPORTED', 'Promotion line identity cannot be established.', { lineId: line.id });
    return { lineKey: line.key, quantity: line.quantity, productId, tags: product.tags, collectionIds: product.collectionIds };
  });
  let retainedShipping: StackInput['retainedShipping'];
  // Native scalar defaults keep their historical snapshot shape. Source vectors,
  // explicit preservation options & retained promotion recalculation use carriers.
  const carrierPricing = !!retainedComponents || !!priorOrdinary?.retainedShipping ||
    (working.shipping.kind === 'keep' || working.shipping.kind === 'method') && (!pricingOptions.recalculateShipping || !pricingOptions.recalculateShippingPromotions);
  if (!carrierPricing && working.shipping.kind === 'keep' && !shippingOverride) {
    const recorded = storedMethodCode ? methodsByCode.get(storedMethodCode) : undefined;
    if (!recorded && storedBase !== 0) throw new OrderEditError(409, 'ORDER_PRICING_EDIT_UNSUPPORTED', 'Shipping requires a mapped current calculator or an explicit amount.');
    calc = recorded?.calculator as ShippingCalculator | undefined;
    methodCode = recorded?.code ?? null;
    baseShipping = calc ? shippingRate(calc) : 0;
  }
  const pricingBase: Omit<StackInput, 'lines' | 'promotions' | 'couponContext'> & { couponContext: { activeVerifications: string[]; items: typeof items } } = { currency: order.currency, phase: 'PaymentSettled' as const, pricesIncludeTax: snapshot?.pricesIncludeTax ?? importedBasis?.pricesIncludeTax ?? taxInclusive,
    ...(retainedShipping ? { retainedShipping } : {}),
    shipping: baseShipping, shippingTaxRateBps: retainedShipping ? 0 : calc?.taxRate ?? (storeRow.shippingTaxable ? taxRate : 0),
    shippingIncludesTax: retainedShipping ? false : calc?.taxInclusive ?? taxInclusive, couponContext: { activeVerifications: [], items },
    pointsDiscount: storedMoney.pointsDiscount, adjustments: working.adjustments.map(({ id, label, amount }) => ({ label, amount, ...(id && sourceSurcharges.has(id) ? { sourceSurcharge: sourceSurcharges.get(id)! } : {}) })),
    couponCodes: working.couponCodes.filter(code => !retainedCreditPromotion?.code || code.toLowerCase() !== retainedCreditPromotion.code.toLowerCase()) };
  const workingBases = working.lines.map(line => {
    const original = originalByKey.get(line.key);
    const untouched = !!line.original && line.original.variantId === line.variantId && line.original.quantity === line.quantity;
    if (untouched) return { key: line.key, quantity: line.quantity, change: 'untouched' as const };
    const variant = line.variantId ? variantsById.get(line.variantId) : undefined;
    if (!variant) throw new OrderEditError(409, 'ORDER_PRICING_EDIT_UNSUPPORTED', 'Current line price cannot be established.', { lineId: line.id });
    return { key: line.key, quantity: line.quantity, change: line.id ? 'touched' as const : 'new' as const,
      basis: { unitListPrice: line.customPrice ? line.unitPrice : selectUnitPrice(variant, priceRule), priceIncludesTax: storeRow.taxInclusive,
        taxRateBps: taxRate, placedQuantity: Math.max(original?.placedQuantity ?? line.original?.quantity ?? line.quantity, line.quantity), priorAdjustments: [] } };
  });
  // Legacy native unitPrice is a list price only if reproducing every stored
  // financial line & header proves it. Never apply this to imported net rows.
  let legacyInput: StackInput | undefined;
  let legacyResult: ReturnType<typeof calculatePromotionStack> | undefined;
  if (!snapshot && !importedBasis) {
    const beforeItems = dbLines.map(line => {
      const productId = line.variantId ? variantsById.get(line.variantId)?.productId : undefined;
      const product = productId ? facts.get(productId) : undefined;
      if (!productId || !product) throw new OrderEditError(409, 'ORDER_PRICING_EDIT_UNSUPPORTED', 'Stored promotion line identity cannot be established.');
      return { lineKey: line.id, quantity: line.quantity, productId, tags: product.tags, collectionIds: product.collectionIds };
    });
    const legacyBase = { ...pricingBase, shipping: storedBase, couponCodes: initial.couponCodes,
      adjustments: dbAdjustments.map(({ label, amount }) => ({ label, amount })), couponContext: { activeVerifications: [], items: beforeItems },
      lines: dbLines.map(line => ({ key: line.id, quantity: line.quantity, placedQuantity: line.quantity, unitListPrice: line.unitPrice, priceIncludesTax: taxInclusive, taxRateBps: taxRate })) };
    legacyResult = await resolvePromotionStack(tx, { ...legacyBase, storeId, orderId: order.id, customerId: order.customerId ?? undefined });
    legacyInput = { ...legacyBase, promotions: legacyResult.resolvedPromotions ?? [] };
    const legacyPerLine = projectEditStackLines(legacyInput, legacyResult);
    if (!totalsInert(storedMoney, legacyResult) || dbLines.some(line => {
      const p = legacyPerLine.find(item => item.key === line.id)!;
      const previous = legacyResult!.lines[legacyInput!.lines.findIndex(item => item.key === line.id)]!;
      const nativeProjection = p.unitPrice === line.unitPrice && p.lineSubtotal === line.lineSubtotal && p.lineDiscount === line.lineDiscount && p.lineTotal === line.lineTotal && p.lineTax === line.lineTax;
      const checkoutProjection = previous.unitPrice === line.unitPrice && previous.lineSubtotal === line.lineSubtotal && previous.lineDiscount === line.lineDiscount && previous.lineTotal === line.lineTotal && line.lineTax === 0;
      return !nativeProjection && !checkoutProjection;
    })) throw new OrderEditError(409, 'ORDER_PRICING_EDIT_UNSUPPORTED', 'Stored native pricing cannot be reproduced from complete list-price evidence.');
  }
  const legacyPricingSnapshot = legacyInput && legacyResult ? buildOrderPricingSnapshot(legacyInput, legacyResult,
    new Map(dbLines.map(line => [line.id, line.id]))) : undefined;
  const existingBasis = snapshot?.lines ?? importedBasis?.lines ?? legacyInput!.lines;
  const afterLines = workingBases.map(line => line.change === 'untouched'
    ? { ...existingBasis.find(original => original.key === line.key)!, priorAdjustments: [] }
    : { ...line.basis, key: line.key, quantity: line.quantity });
  let resolved = await resolvePromotionStack(tx, { ...pricingBase, lines: afterLines, storeId, orderId: order.id, customerId: order.customerId ?? undefined, mode: opts.lock ? 'payment' : 'quote' });
  const listSubtotal = afterLines.reduce((total, line) => {
    const factor = 1 + line.taxRateBps / 10000;
    const unit = pricingBase.pricesIncludeTax ? (line.priceIncludesTax ? line.unitListPrice : line.unitListPrice * factor)
      : (line.priceIncludesTax ? line.unitListPrice / factor : line.unitListPrice);
    return total + Math.round(unit * line.quantity);
  }, 0);
  if (carrierPricing) {
    const source = snapshot ? currentShippingSourceFacts(snapshot, creditEvidence ?? undefined, pricingLineage.pricingSources,
      { orderId: order.id, shippingMethodCode: storedMethodCode }) : retainedComponents ? {
      basis: retainedComponents.shippingLines.map(line => ({ sourceId: line.sourceId, amount: line.listPrice, includesTax: line.listPriceIncludesTax, taxRateBps: line.taxRateBps })),
      adjustments: Object.fromEntries(retainedComponents.shippingLines.map(line => [line.sourceId, line.adjustments.reduce((sum, amount) => sum + amount, 0)])),
      carriers: retainedComponents.shippingLines.map(line => ({ sourceId: line.sourceId, methodCode: line.methodCode,
        lineKeys: line.orderLineIds.map(id => { const native = working.lines.find(line => line.id === id);
          if (!native) throw new OrderEditError(409, 'ORDER_PRICING_EDIT_UNSUPPORTED', 'Retained shipping member identity is absent.'); return native.key; }) })),
    } : {
      // This branch follows complete native legacy financial reproduction above.
      basis: [{ sourceId: 'current-shipping', amount: legacyInput!.shipping, includesTax: legacyInput!.shippingIncludesTax, taxRateBps: legacyInput!.shippingTaxRateBps }],
      adjustments: { 'current-shipping': legacyResult!.shippingTotal - legacyInput!.shipping },
      carriers: [{ sourceId: 'current-shipping', methodCode: storedMethodCode, lineKeys: legacyInput!.lines.map(line => line.key) }],
    };
    const final = priorOrdinary?.retainedShippingFinal ?? (priorOrdinary ? (() => {
      const basis = priorOrdinary.shippingBasis, amount = priorOrdinary.totals.shippingTotal, factor = 1 + basis.taxRateBps / 10000;
      return [{ sourceId: 'current-shipping', net: Math.round(basis.includesTax ? amount / factor : amount), gross: Math.round(basis.includesTax ? amount : amount * factor) }];
    })() : retainedComponents?.shippingLines.map(line => ({ sourceId: line.sourceId, net: line.net, gross: line.gross })) ??
      [{ sourceId: 'current-shipping', net: Math.round(legacyInput!.shippingIncludesTax ? legacyResult!.shippingTotal / (1 + legacyInput!.shippingTaxRateBps / 10000) : legacyResult!.shippingTotal),
        gross: Math.round(legacyInput!.shippingIncludesTax ? legacyResult!.shippingTotal : legacyResult!.shippingTotal * (1 + legacyInput!.shippingTaxRateBps / 10000)) }]);
    retainedShipping = priceEditShippingCarriers({ ...source, final, sourceDigest: snapshot ? creditPricingSnapshotDigest(snapshot.snapshot) : retainedComponents?.sourceDigest ?? creditPricingSnapshotDigest(legacyPricingSnapshot!),
      lines: working.lines, methods, ...(working.shipping.kind === 'method' ? { selectedMethodCode: working.shipping.method.code } : {}),
      ...(working.shipping.kind === 'custom' ? { replacement: { kind: 'custom' as const, amount: working.shipping.amount } }
        : working.shipping.kind === 'none' ? { replacement: { kind: 'none' as const } }
        : working.shipping.kind === 'keep' && shippingOverride && pricingOptions.recalculateShipping && source.carriers.length > 0 ? { replacement: { kind: 'custom' as const, amount: source.basis[0]!.amount } } : {}), ...pricingOptions,
      context: { subtotal: listSubtotal, country, discountedSubtotalWithTax: resolved.lineSnapshots.reduce((total, line) => total + line.lineGross, 0) },
      defaultTaxRateBps: storeRow.shippingTaxable ? taxRate : 0, defaultIncludesTax: taxInclusive });
    baseShipping = retainedShipping.lines.reduce((sum, line) => sum + line.net, 0);
    methodCode = retainedShipping.carriers?.[0]?.methodCode ?? null;
    pricingBase.retainedShipping = retainedShipping; pricingBase.shipping = baseShipping;
    pricingBase.shippingTaxRateBps = 0; pricingBase.shippingIncludesTax = false;
    resolved = await resolvePromotionStack(tx, { ...pricingBase, lines: afterLines, storeId, orderId: order.id, customerId: order.customerId ?? undefined, mode: opts.lock ? 'payment' : 'quote' });
  }
  if (!carrierPricing && calc && !isMethodEligible(calc, { subtotal: listSubtotal, country,
    discountedSubtotalWithTax: resolved.lineSnapshots.reduce((total, line) => total + line.lineGross, 0) })) {
    throw new OrderEditError(409, 'SHIPPING_UNAVAILABLE', 'Shipping method is not available for this order.', { code: methodCode });
  }
  for (const op of ops) if (op.op === 'apply_coupon') {
    if (retainedCreditPromotion?.code?.toLowerCase() === op.code.toLowerCase()) continue;
    const status = resolved.coupons.find(coupon => coupon.code.toLowerCase() === op.code.toLowerCase());
    if (!status?.applied) throw new OrderEditError(409, 'COUPON_INVALID', `Coupon cannot be applied: ${status?.reason ?? 'unavailable'}`, { code: op.code });
  }
  let stack: OrderEditStackCandidate;
  try { stack = priceOrderEditStack({ before: { basis: snapshot?.selectedCredit
    ? { kind: 'current-proof', lines: snapshot.lines, pricesIncludeTax: snapshot.pricesIncludeTax, economicHash: snapshot.quoteHash,
      ...(isImportedCreditOrigin(snapshot.snapshot.version === 2 ? snapshot.snapshot.origin : snapshot.snapshot) ? { signedHeader: true as const } : {}) }
    : snapshot ? { kind: 'snapshot', snapshot: snapshot.snapshot } : importedBasis ?? { kind: 'legacy', input: legacyInput!, result: legacyResult! },
    currency: order.currency, orderLines: nativeLines, totals: storedMoney, economicHash: snapshot?.quoteHash ?? importedBasis?.sourceFingerprint ?? legacyResult!.quoteHash },
    creditLedgerEvidence: [], lines: workingBases, pricing: { ...pricingBase, promotions: resolved.resolvedPromotions ?? [] } }); }
  catch (error) { if (error instanceof OrderEditStackError) throw new OrderEditError(409, 'ORDER_PRICING_EDIT_UNSUPPORTED', error.message); throw error; }
  stack.result.coupons = resolved.coupons;
  let projections = projectEditStackLines(stack.input, stack.result);
  let credit: EditPlan['credit'] = null;
  if (snapshot?.selectedCredit && creditEvidence) {
    const origin = snapshot.snapshot.version === 2 ? snapshot.snapshot.origin : snapshot.snapshot;
    const ids = new Map(working.lines.map(line => [line.key, line.id ?? logicalUuid(`edit-preview:${order.id}:${line.key}`)]));
    const material = creditMaterial({ stack, working, current: snapshot, evidence: creditEvidence, pricingSources: pricingLineage.pricingSources, origin,
      creditCode: retainedCreditPromotion!.code!, editId: logicalUuid(`edit-preview:${order.id}`), lineIds: ids });
    credit = { current: snapshot, evidence: creditEvidence, origin, ...material, creditCode: retainedCreditPromotion!.code!, ledgerPrefixDigest: fundingPrefixDigest(creditEvidence) };
    projections = projections.map(line => { const final = material.pricing.lines.find(item => item.orderLineId === ids.get(line.key))!;
      return { ...line, lineDiscount: line.lineSubtotal - final.lineNet, lineTax: final.lineGross - final.lineNet, lineTotal: final.lineGross }; });
  }
  priced = { totals: credit ? { ...stack.result, ...credit.pricing.totals } : stack.result, perLine: projections };
  for (const line of working.lines) line.unitPrice = projections.find(item => item.key === line.key)!.unitPrice;
  promotionRow = null; // Full applied set below owns usage; singleton is display compatibility only.
  const firstOrdinary = stack.result.applied.find(entry => entry.kind !== 'account_credit');
  if (firstOrdinary) {
    const [row] = await tx.select().from(s.promotion).where(eq(s.promotion.id, firstOrdinary.promotionId)).limit(1);
    if (row && row.type !== 'account_credit') promotionRow = { ...row, type: row.type };
  }
  const storedUsage = await tx.select().from(s.promotionUsage).where(and(eq(s.promotionUsage.storeId, storeId), eq(s.promotionUsage.orderId, order.id)));
  const rawSource = importedSourceMetadata(order.metadata);
  const importedPricingBasis: ImportedPricingBasis | undefined = importedBasis && !snapshot?.selectedCredit && order.pricingSnapshot == null && typeof rawSource?.sourceKey === 'string'
    ? buildImportedPricingBasis({ storeId, orderId: order.id, currency: order.currency, sourceKey: rawSource.sourceKey,
      sourceOrderId: String(rawSource.id), editBasisV1: rawSource.editBasisV1 }) : undefined;
  const storedFingerprint = orderEditStoredFingerprint({ order, ...(importedPricingBasis ? { importedPricingBasis } : {}), lines: [...dbLines].sort((a, b) => a.id.localeCompare(b.id)),
    adjustments: dbAdjustments, couponCodes: initial.couponCodes, usage: storedUsage.sort((a, b) => a.id.localeCompare(b.id)), variants: [...variantRows].sort((a, b) => a.id.localeCompare(b.id)),
    ...(credit ? { refundPrefixDigest: refundPrefixDigest(credit.evidence) } : {}) });
  const afterHash = credit ? orderEditStoredFingerprint({ ordinaryHash: stack.afterEconomicHash, totals: credit.pricing.totals,
    sourceCustody: credit.pricing.sourceCustody, sourceCustodyAllocation: credit.pricing.credit.sourceCustodyAllocation,
    funding: working.lines.map(line => ({ key: line.key, indexes: credit!.indexes[credit!.ordinary.lines.find(item => item.key === line.key)!.orderLineId],
      allocation: credit!.pricing.credit.allocation[credit!.ordinary.lines.find(item => item.key === line.key)!.orderLineId],
      unitEconomics: credit!.pricing.unitEconomics[credit!.ordinary.lines.find(item => item.key === line.key)!.orderLineId],
      consumedPositions: credit!.current.consumedPositions[line.id ?? ''] ?? [] })) }) : stack.afterEconomicHash;
  const previewAcceptanceHash = orderEditAcceptanceHash(storedFingerprint, orderEditStoredFingerprint({ economics: afterHash, pricingOptions }), ops);
  const t = priced.totals;

  // A pure address edit is exempt from the payment holds ONLY while it is
  // monetarily inert: a shipping-country change re-prices tax, so it holds and
  // retires intents exactly like an item edit. Any priced total moving changes
  // the amount basis: no Stripe intent minted at the old amount may stay
  // confirmable (commitOrderEdit retires them first; one that could not be
  // cancelled, or was minted since, blocks the edit).
  const moneyInert = totalsInert(
    { subtotal: order.subtotal, discountTotal: order.discountTotal, shippingTotal: order.shippingTotal, taxTotal: order.taxTotal, grandTotal: order.grandTotal }, t);
  if (addressOnly && !moneyInert && await hasUnresolvedPayment(tx, order.id)) {
    throw new OrderEditError(409, 'PAYMENT_UNRESOLVED', 'resolve the pending payment before editing this order');
  }
  if (opts.lock && !moneyInert && await hasConfirmableIntent(tx, storeId, order.id)) {
    throw new OrderEditError(409, 'PAYMENT_UNRESOLVED', 'an open card payment for the old amount could not be cancelled yet — retry in a moment');
  }

  // ── issued licenses: a line that already carries a non-revoked license may
  // not be removed, reduced or repointed at another variant; entitlements are
  // settled money, not editable merchandise.
  const licensed = await licensedLineEditViolations(tx, storeId, order.id,
    working.lines.filter((l) => l.id).map((l) => ({ id: l.id!, variantId: l.variantId, quantity: l.quantity })));
  if (licensed.length) {
    const skus = working.lines.filter((l) => l.id && licensed.includes(l.id)).map((l) => l.sku);
    throw new OrderEditError(409, 'LINE_LICENSED', `a line with an issued license cannot be removed, reduced or swapped: ${skus.join(', ')}`, { lineIds: licensed });
  }

  // ── stock plan: unfulfilled delta per variant ──────────────────────────────
  const stockDeltas = new Map<string, number>();
  const physical = (variantId: string) => {
    const v = variantsById.get(variantId);
    return !!v && !v.isPreOrder && v.fulfillmentType === 'physical';
  };
  const bump = (variantId: string | null, n: number) => {
    if (!variantId || n === 0 || !physical(variantId)) return;
    stockDeltas.set(variantId, (stockDeltas.get(variantId) ?? 0) + n);
  };
  for (const l of dbLines) bump(l.variantId, -openQty(l));
  for (const l of working.lines) bump(l.variantId, openQty(l));
  for (const [id, d] of [...stockDeltas]) if (d === 0) stockDeltas.delete(id);
  for (const [id, d] of stockDeltas) {
    const v = variantsById.get(id)!;
    if (d > 0 && (!v.enabled || v.deletedAt)) throw new OrderEditError(409, 'VARIANT_UNAVAILABLE', `variant is not available: ${v.sku}`, { sku: v.sku });
  }
  const stock: StockCheck[] = [];
  const growing = [...stockDeltas].filter(([, d]) => d > 0).map(([id]) => id);
  const stockRows = growing.length ? await tx.select().from(s.stock).where(and(eq(s.stock.storeId, storeId), inArray(s.stock.variantId, growing))) : [];
  for (const [id, delta] of stockDeltas) {
    const v = variantsById.get(id)!;
    const row = stockRows.find((r) => r.variantId === id);
    const available = row ? row.onHand - row.allocated : null;
    stock.push({ sku: v.sku, name: v.name, variantId: id, delta, available, ok: delta <= 0 || (available != null && available >= delta) });
  }

  // ── balance ────────────────────────────────────────────────────────────────
  const payments = await tx.select().from(s.payment).where(and(eq(s.payment.orderId, order.id), eq(s.payment.state, 'Settled')));
  const refunds = await tx.select().from(s.refund).where(and(eq(s.refund.orderId, order.id), sql`${s.refund.state} <> 'Failed'`));
  const settled = payments.reduce((n, p) => n + p.amount, 0);
  const refunded = refunds.reduce((n, r) => n + r.amount, 0);
  const amountDue = await amountDueForOrder(tx, storeId, order.id, t.grandTotal);
  const editRefunded = await editRefundedTotal(tx, storeId, order.id);
  const balance: BalanceInfo = { newGrandTotal: t.grandTotal, settled, refunded, netPaid: settled - refunded, editRefunded, amountDue };
  const refundable: RefundablePayment[] = payments.filter((p) => !isDuplicatePayment(p)).map((p) => ({
    id: p.id, method: p.method, amount: p.amount,
    available: p.amount - refunds.filter((r) => r.paymentId === p.id).reduce((n, r) => n + r.amount, 0),
  })).filter((p) => p.available > 0);

  // ── snapshots / diffs ──────────────────────────────────────────────────────
  const snapLines = dbLines.map((l) => ({ id: l.id as string | null, sku: l.variantSku, name: l.variantName, unitPrice: l.unitPrice, quantity: l.quantity, lineTotal: l.lineTotal, fulfilledQty: l.fulfilledQty, refundedQty: l.refundedQty }));
  const isPreOrderAfter = working.lines.some((l) => l.quantity > 0 && l.variantId && variantsById.get(l.variantId)?.isPreOrder === true);
  const before: OrderSnapshot = {
    totals: { subtotal: order.subtotal, discountTotal: order.discountTotal, shippingTotal: order.shippingTotal, taxTotal: order.taxTotal, grandTotal: order.grandTotal, adjustmentTotal: dbAdjustments.reduce((n, a) => n + a.amount, 0) },
    lines: snapLines, adjustments: dbAdjustments.map((a) => ({ label: a.label, amount: a.amount })),
    shipping: { amount: order.shippingTotal, override: order.shippingOverride, methodCode: order.shippingMethodCode ?? meta.shipping?.methodCode ?? null },
    promotion: currentPromo ? { id: currentPromo.id, code: currentPromo.code } : null,
    shippingAddress: beforeShip, billingAddress: beforeBill, isPreOrder: order.isPreOrder,
  };
  const after: OrderSnapshot = {
    totals: { subtotal: t.subtotal, discountTotal: t.discountTotal, shippingTotal: t.shippingTotal, taxTotal: t.taxTotal, grandTotal: t.grandTotal, adjustmentTotal: t.adjustmentTotal ?? 0 },
    lines: working.lines.map((l) => ({ id: l.id, sku: l.sku, name: l.name, unitPrice: l.unitPrice, quantity: l.quantity, lineTotal: priced.perLine.find((p) => p.key === l.key)!.lineTotal, fulfilledQty: l.fulfilledQty, refundedQty: l.refundedQty })),
    adjustments: working.adjustments.map((a) => ({ label: a.label, amount: a.amount })),
    shipping: { amount: t.shippingTotal, override: shippingOverride, methodCode },
    promotion: promotionRow ? { id: promotionRow.id, code: promotionRow.code } : null,
    shippingAddress: afterShip, billingAddress: afterBill, isPreOrder: isPreOrderAfter,
  };

  const [customer] = order.customerId ? await tx.select({ email: s.customer.email }).from(s.customer).where(eq(s.customer.id, order.customerId)).limit(1) : [];
  const recipient = normalizeEmail(meta.contact?.email || customer?.email || '') || null;
  const storeCtx: StoreEmailCtx = {
    name: storeRow.name, currency: order.currency, config: storeRow.config, storeId,
    appKey: pickEmailAppKey(variantRows.map((v) => v.appKey)),
  };

  return {
    order, working, before, after, pricingOptions, ...(importedPricingBasis ? { importedPricingBasis } : {}), ...(legacyPricingSnapshot ? { legacyPricingSnapshot } : {}), lineDiffs: diffLines(snapLines, working.lines, priced), priced, stock, stockDeltas, balance, refundable, warnings, storedLines: dbLines,
    promotionRow, shipping: { amount: t.shippingTotal, base: baseShipping, override: shippingOverride, methodCode, methodName: methodCode ? methodsByCode.get(methodCode)?.name ?? null : null },
    address: { shipping: { changed: !sameAddress(beforeShip, afterShip), countryChanged: countryChanged(beforeShip, afterShip) }, billing: { changed: !sameAddress(beforeBill, afterBill) } },
    variantsById, isPreOrder: isPreOrderAfter, storeCtx, recipient, customerId: order.customerId, taxRate, taxInclusive, stack, storedFingerprint, previewAcceptanceHash, credit,
  };
}

// ── preview ──────────────────────────────────────────────────────────────────
export interface RefundFeasibility { feasible: boolean; reason?: string; paymentId?: string }

/** Can a refund_now of `amount` be issued right now (and against which payment)? */
export function refundFeasibility(plan: Pick<EditPlan, 'refundable' | 'order'>, amount: number, paymentId?: string): RefundFeasibility {
  if (plan.order.state !== 'Paid' && plan.order.state !== 'PartiallyRefunded') return { feasible: false, reason: 'only a paid order can be refunded; leave the credit instead' };
  const pool = paymentId ? plan.refundable.filter((p) => p.id === paymentId) : plan.refundable;
  if (paymentId && pool.length === 0) return { feasible: false, reason: 'the selected payment has nothing left to refund' };
  if (!paymentId && pool.length === 0) return { feasible: false, reason: 'no refundable payment on this order' };
  if (!paymentId && pool.length > 1) return { feasible: false, reason: 'select which payment to refund' };
  const p = pool[0]!;
  if (amount > p.available) return { feasible: false, reason: 'the refund exceeds what is left on that payment' };
  if (amount === p.available) return { feasible: false, reason: 'this would refund the whole payment — cancel or refund the order instead' };
  return { feasible: true, paymentId: p.id };
}

export interface PreviewResult {
  pricingOptions: Required<EditPricingOptions>;
  code: string; state: string; currency: string; reason?: undefined;
  before: OrderSnapshot['totals']; after: OrderSnapshot['totals'];
  lines: LineDiff[]; adjustments: Array<{ id: string | null; label: string; amount: number }>;
  shipping: EditPlan['shipping']; promotion: { code: string | null; type: string; value: number } | null;
  stock: StockCheck[]; stockOk: boolean; balance: BalanceInfo; settlementOptions: string[];
  refund: { feasible: boolean; reason?: string; payments: RefundablePayment[] } | null;
  warnings: string[]; address: EditPlan['address']; isPreOrder: boolean; recipientEmail: string | null;
  couponCodes: string[]; previewAcceptanceHash: string;
}

export function previewFromPlan(plan: EditPlan): PreviewResult {
  const amountDue = plan.balance.amountDue;
  const refund = amountDue < 0 ? { ...refundFeasibility(plan, -amountDue), payments: plan.refundable } : null;
  return {
    code: plan.order.code, state: plan.order.state, currency: plan.order.currency, pricingOptions: plan.pricingOptions,
    before: plan.before.totals, after: plan.after.totals, lines: plan.lineDiffs,
    adjustments: plan.working.adjustments, shipping: plan.shipping,
    promotion: plan.promotionRow ? { code: plan.promotionRow.code, type: plan.promotionRow.type, value: plan.promotionRow.value } : null,
    stock: plan.stock, stockOk: plan.stock.every((x) => x.ok), balance: plan.balance,
    settlementOptions: allowedSettlements(amountDue), refund, warnings: plan.warnings, address: plan.address,
    isPreOrder: plan.isPreOrder, recipientEmail: plan.recipient, couponCodes: [...plan.working.couponCodes], previewAcceptanceHash: plan.previewAcceptanceHash,
  };
}

export async function previewOrderEdit(storeId: string, code: string, ops: EditOpT[], options: EditPricingOptions = {}): Promise<PreviewResult> {
  return withStore(storeId, async (tx) => previewFromPlan(await planOrderEdit(tx, storeId, code, ops, { ...options, lock: false })));
}

// ── commit ───────────────────────────────────────────────────────────────────
export interface CommitInput extends EditPricingOptions {
  storeId: string; storeSlug: string; code: string; actor: string;
  /** Who is acting. Required (no default) so a caller cannot forget it: an agent may not commit entitlement-changing ops. */
  principalKind: 'human' | 'agent';
  ops: EditOpT[]; expectedGrandTotal: number; expectedBalance?: number; previewAcceptanceHash?: string; idempotencyKey: string;
  settlement?: SettlementT; notifyCustomer: boolean; reason?: string;
}
export interface SettlementOutcome {
  type: string; status: 'none' | 'recorded' | 'settled' | 'pending' | 'failed' | 'sent' | 'due' | 'credit' | 'reconciliation_required';
  amount?: number; paymentId?: string; refundId?: string; refundState?: string; message?: string; paymentMethod?: string; reference?: string | null;
  phase?: EditStageSettlement['phase']; paymentAttemptId?: string; amendmentDigest?: string; activationReceipt?: EditStageSettlement['activationReceipt'];
}

interface CreditActivation {
  pricingOptions: Required<EditPricingOptions>;
  beforeOrder: OrderRow; variants: VariantRow[]; working: WorkingOrder; perLine: EditPlan['priced']['perLine'];
  origin: CreditPricingOrigin; ordinary: OrderPricingSnapshotV1; indexes: OriginalUnitIndexes; ordinaryUnitFacts: OrdinaryUnitFacts;
  predecessor: CurrentOrderPricing; unitIds: Record<string, string[]>; lineage: OrderPricingSnapshotV2['lineage'];
  targets: ReturnType<typeof currentCreditFundingTargets>; stockDeltas: Array<[string, number]>;
  shipping: EditPlan['shipping']; isPreOrder: boolean; taxRate: number; taxInclusive: boolean;
  storeCtx: StoreEmailCtx; storeSlug: string; recipient: string | null; actor: string; principalKind: 'human' | 'agent';
  notifyCustomer: boolean; reason: string | null; changes: string[]; newPromoId: string | null;
}
async function preparedStage(tx: Tx, storeId: string, orderId: string, editId?: string) {
  const rows = await tx.select().from(s.orderEdit).where(and(eq(s.orderEdit.storeId, storeId), eq(s.orderEdit.orderId, orderId))).for('update');
  const row = editId ? rows.find(row => row.id === editId) : rows.find(row => isPendingEditStage(row.settlement));
  if (!row || !(row.after && typeof row.after === 'object' && 'proposal' in row.after)) return null;
  const proposal = readEditStageProposal((row.after as { proposal: unknown }).proposal);
  if (proposal.editId !== row.id || proposal.orderId !== row.orderId || proposal.requestFingerprint !== row.fingerprint) throw new OrderEditError(409, 'ORDER_EDIT_STAGE_INVALID', 'Prepared edit identity differs.');
  return { row, proposal, settlement: row.settlement as unknown as EditStageSettlement & SettlementOutcome, settlementAmendment: (row.after as { settlementAmendment?: unknown }).settlementAmendment };
}

/** Consumers call under existing licence/order lock set, before account locks. */
export async function preparedEditTender(tx: Tx, input: { storeId: string; orderId: string }) {
  const stage = await preparedStage(tx, input.storeId, input.orderId);
  if (!stage || stage.settlement.phase !== 'awaiting_tender') return null;
  return { editId: stage.row.id, amount: stage.proposal.settlementRequirement.requiredTender, currency: stage.proposal.settlementRequirement.currency };
}
export async function bindPreparedEditTender(tx: Tx, input: { storeId: string; orderId: string; editId: string; paymentAttemptId: string }) {
  const stage = await preparedStage(tx, input.storeId, input.orderId, input.editId);
  if (!stage || stage.settlement.phase !== 'awaiting_tender') throw new OrderEditError(409, 'ORDER_EDIT_STAGE_INVALID', 'Prepared tender is absent.');
  const [attempt] = await tx.select().from(s.paymentAttempt).where(and(eq(s.paymentAttempt.storeId, input.storeId), eq(s.paymentAttempt.id, input.paymentAttemptId))).limit(1);
  const required = stage.proposal.settlementRequirement;
  if (!attempt || attempt.orderId !== input.orderId || !['charge', 'session', 'intent'].includes(attempt.operation) || attempt.currency !== required.currency || attempt.amount !== required.requiredTender) throw new OrderEditError(409, 'ORDER_EDIT_TENDER_INVALID', 'Tender differs from accepted edit.');
  if (stage.settlement.paymentAttemptId && stage.settlement.paymentAttemptId !== attempt.id) {
    const [prior] = await tx.select().from(s.paymentAttempt).where(eq(s.paymentAttempt.id, stage.settlement.paymentAttemptId)).limit(1);
    const superseded = prior?.status === 'cancelled' && (prior.result as { superseded_by?: string } | null)?.superseded_by === attempt.id;
    if (!prior || (!superseded && prior.status !== 'failed')) throw new OrderEditError(409, 'ORDER_EDIT_TENDER_PENDING', 'Previous tender remains unresolved.');
  }
  await tx.update(s.orderEdit).set({ settlement: { ...stage.settlement, paymentAttemptId: attempt.id } }).where(eq(s.orderEdit.id, stage.row.id));
}
export async function bindPreparedEditRefund(tx: Tx, input: { storeId: string; orderId: string; editId: string; refundId: string }) {
  const stage = await preparedStage(tx, input.storeId, input.orderId, input.editId);
  if (!stage || stage.settlement.phase !== 'awaiting_refund') throw new OrderEditError(409, 'ORDER_EDIT_STAGE_INVALID', 'Prepared refund is absent.');
  const [refund] = await tx.select().from(s.refund).where(and(eq(s.refund.storeId, input.storeId), eq(s.refund.id, input.refundId))).limit(1);
  const [payment] = refund ? await tx.select().from(s.payment).where(and(eq(s.payment.storeId, input.storeId), eq(s.payment.id, refund.paymentId))).limit(1) : [];
  const required = stage.proposal.settlementRequirement;
  if (!refund || !payment || refund.orderId !== input.orderId || payment.currency !== required.currency || refund.amount !== required.requiredRefund || refund.paymentId !== stage.settlement.paymentId) throw new OrderEditError(409, 'ORDER_EDIT_REFUND_INVALID', 'Refund differs from accepted edit.');
  if (stage.settlement.refundId && stage.settlement.refundId !== refund.id) {
    const [prior] = await tx.select().from(s.refund).where(eq(s.refund.id, stage.settlement.refundId)).limit(1);
    if (!prior || prior.state !== 'Failed') throw new OrderEditError(409, 'ORDER_EDIT_REFUND_PENDING', 'Previous refund remains unresolved.');
  }
  await tx.update(s.orderEdit).set({ settlement: { ...stage.settlement, refundId: refund.id } }).where(eq(s.orderEdit.id, stage.row.id));
}

function creditEconomics(snapshot: OrderPricingSnapshotV2) {
  const { quoteHash: _quoteHash, credit, ...facts } = snapshot;
  const { atPricingRestoreIds: _ids, atPricingRestoreDigest: _digest, ...funding } = credit;
  return { ...facts, credit: funding };
}

async function prepareCreditedOrderEdit(tx: Tx, input: CommitInput, plan: EditPlan, settlement: SettlementT | null | undefined,
  fingerprint: string, refundPlan?: { amount: number; paymentId: string }) {
  const credit = plan.credit!;
  const { editId, lineIds } = allocateEditStageIds(plan.working.lines);
  const material = creditMaterial({ stack: plan.stack, working: plan.working, current: credit.current, evidence: credit.evidence, pricingSources: (await loadPricingLineage(tx, input.storeId, plan.order.id)).pricingSources,
    origin: credit.origin, creditCode: credit.creditCode, editId, lineIds: new Map(Object.entries(lineIds)) });
  const prepared = await prepareEditCreditFunding(tx, { storeId: input.storeId, orderId: plan.order.id, editId, lines: material.targets });
  if (!prepared || prepared.plan.requestDigest !== material.plan.requestDigest || fundingPrefixDigest(prepared.evidence) !== credit.ledgerPrefixDigest) throw new OrderEditError(409, 'PREVIEW_STALE', 'Credit funding changed since preview.');
  const requiredTender = Math.max(0, plan.balance.amountDue), requiredRefund = refundPlan?.amount ?? 0;
  if (settlement?.type === 'record_payment') {
    if ((settlement.amount ?? requiredTender) !== requiredTender) throw new OrderEditError(409, 'ORDER_EDIT_TENDER_INVALID', 'Tender must equal accepted amount due.');
    try { await checkPlacement(tx, input.storeId, { id: plan.order.id, storeId: input.storeId, code: plan.order.code, state: plan.order.state, currency: plan.order.currency, grandTotal: material.pricing.totals.grandTotal, customerId: plan.order.customerId, metadata: plan.order.metadata }, 'manual'); }
    catch (error) { if (error instanceof PaymentPolicyVetoError) throw new OrderEditError(409, error.veto.code, error.veto.message, error.veto.extra);
      if (error instanceof PaymentPolicyUnavailableError) throw new OrderEditError(503, 'PAYMENT_POLICY_UNAVAILABLE', 'Payment is temporarily unavailable.'); throw error; }
  }
  const positiveDeltas = [...plan.stockDeltas].filter(([, delta]) => delta > 0).map(([variantId, quantity]) => ({ variantId, quantity }));
  if (positiveDeltas.length) {
    const reserveMap = new Map(positiveDeltas.map(({ variantId }) => { const variant = plan.variantsById.get(variantId)!; return [variant.sku, variant]; }));
    try { await reserveStockOrThrow(tx, input.storeId, positiveDeltas.map(({ variantId, quantity }) => ({ sku: plan.variantsById.get(variantId)!.sku, quantity })), reserveMap); }
    catch (error) { if (error instanceof StockReservationError) throw new OrderEditError(409, 'OUT_OF_STOCK', 'Insufficient stock for added quantity.', { skus: error.skus }); throw error; }
  }
  const activation: CreditActivation = { pricingOptions: plan.pricingOptions, beforeOrder: plan.order, variants: [...plan.variantsById.values()], working: plan.working, perLine: plan.priced.perLine,
    origin: credit.origin, ordinary: material.ordinary, indexes: material.indexes, ordinaryUnitFacts: material.ordinaryUnitFacts, targets: material.targets,
    predecessor: credit.current, unitIds: material.unitIds, lineage: material.pricing.lineage,
    stockDeltas: [...plan.stockDeltas], shipping: plan.shipping, isPreOrder: plan.isPreOrder, taxRate: plan.taxRate, taxInclusive: plan.taxInclusive,
    storeCtx: plan.storeCtx, storeSlug: input.storeSlug, recipient: plan.recipient, actor: input.actor, principalKind: input.principalKind, notifyCustomer: input.notifyCustomer,
    reason: input.reason ?? null, changes: describeChanges(plan, plan.order.currency), newPromoId: plan.promotionRow?.id ?? null };
  const proposal = buildEditStageProposal({ editId, orderId: plan.order.id, requestFingerprint: fingerprint, previewAcceptanceHash: plan.previewAcceptanceHash,
    beforeFingerprint: plan.storedFingerprint, beforeLedgerPrefixDigest: credit.ledgerPrefixDigest, pricingSnapshot: material.pricing,
    lineIds, lines: plan.working.lines, couponCodes: plan.working.couponCodes,
    appliedPromotionIds: [...new Set([...plan.stack.result.applied.map(item => item.promotionId), ...(plan.working.couponCodes.some(code => code.toLowerCase() === credit.creditCode.toLowerCase()) ? [decodeCreditPricingOrigin(credit.origin).selectedCredit.promotionId] : [])])],
    fundingPlan: material.plan, requestDigest: material.plan.requestDigest, postingKeys: material.plan.postings.map(posting => posting.idempotencyKey),
    settlementRequirement: { type: settlement?.type ?? 'none', currency: plan.order.currency, requiredTender, requiredRefund },
    stockReservationReceipt: { key: `order-edit:${editId}:stock`, positiveDeltas }, activation });
  const outcome: SettlementOutcome & EditStageSettlement = { type: settlement?.type ?? 'none', phase: requiredRefund > 0 ? 'awaiting_refund' : requiredTender > 0 ? 'awaiting_tender' : 'ready',
    status: requiredRefund ? 'pending' : settlement?.type === 'leave_due' ? 'due' : settlement?.type === 'send_pay_link' ? 'sent' : settlement?.type === 'leave_credit' ? 'credit' : 'none',
    ...(refundPlan ? { amount: refundPlan.amount, paymentId: refundPlan.paymentId } : {}) };
  await tx.insert(s.orderEdit).values({ id: editId, storeId: input.storeId, orderId: plan.order.id, idempotencyKey: input.idempotencyKey, fingerprint,
    before: { ...plan.before, currentPricing: credit.current.snapshot, storedOrder: plan.order, financialLines: plan.storedLines, storedFingerprint: plan.storedFingerprint }, after: { ...plan.after, proposal }, balance: plan.balance.amountDue,
    settlement: outcome, actor: input.actor, reason: input.reason ?? null });
  if (positiveDeltas.length) afterCommit(tx, () => { void import('../manifest/stock-hook.js').then(({ onStockChanged }) => onStockChanged(input.storeSlug)); });
  let emailQueued = false;
  if (settlement?.type === 'record_payment') {
    const amount = settlement.amount ?? requiredTender, providerRef = `manual:${editId}`;
    const [attempt] = await tx.insert(s.paymentAttempt).values({ storeId: input.storeId, orderId: plan.order.id, operation: 'charge', method: 'manual', accountId: 'manual', mode: 'test', amount, currency: plan.order.currency,
      idempotencyKey: `order-edit:${editId}:tender`, fingerprint, providerRef, status: 'processing' }).returning();
    await bindPreparedEditTender(tx, { storeId: input.storeId, orderId: plan.order.id, editId, paymentAttemptId: attempt!.id });
    await applyPaymentResult(tx, { storeId: input.storeId, method: 'manual', amount, editId, paymentAttemptId: attempt!.id,
      order: { id: plan.order.id, state: plan.order.state, grandTotal: plan.order.grandTotal, currency: plan.order.currency, customerId: plan.order.customerId, code: plan.order.code },
      result: { state: 'Settled', providerRef, metadata: { gateway: { accountId: attempt!.accountId, mode: attempt!.mode }, manual: { method: settlement.method, reference: settlement.reference ?? null, recordedBy: input.actor, editId } } } });
    const [payment] = await tx.select().from(s.payment).where(and(eq(s.payment.storeId, input.storeId), eq(s.payment.orderId, plan.order.id),
      eq(s.payment.method, attempt!.method), eq(s.payment.providerRef, providerRef), eq(s.payment.gatewayAccount, attempt!.accountId), eq(s.payment.gatewayMode, attempt!.mode))).limit(1);
    await tx.update(s.paymentAttempt).set({ status: 'settled', paymentId: payment?.id, result: { state: 'Settled' }, updatedAt: new Date() }).where(eq(s.paymentAttempt.id, attempt!.id));
    if (payment) await activatePreparedOrderEdit(tx, { storeId: input.storeId, orderId: plan.order.id, paymentId: payment.id, paymentAttemptId: attempt!.id });
  } else if (outcome.phase === 'ready') await activatePreparedOrderEdit(tx, { storeId: input.storeId, orderId: plan.order.id });
  else if (settlement?.type === 'send_pay_link') {
    const receiptToken = plan.order.receiptToken ?? randomBytes(32).toString('base64url');
    if (!plan.order.receiptToken) await tx.update(s.order).set({ receiptToken }).where(eq(s.order.id, plan.order.id));
    const payUrl = `${resolveStorefrontUrl(plan.storeCtx)}/orders/${encodeURIComponent(plan.order.code)}?rt=${encodeURIComponent(receiptToken)}&pay=balance`;
    if (plan.recipient) emailQueued = await enqueueOrderBalanceDue(tx, input.storeId, plan.storeCtx, plan.recipient, { code: plan.order.code, currency: plan.order.currency, amountDue: requiredTender, payUrl, dedupeKey: `order_balance_due:${editId}` });
  }
  const [row] = await tx.select().from(s.orderEdit).where(eq(s.orderEdit.id, editId)).limit(1);
  const [order] = await tx.select().from(s.order).where(eq(s.order.id, plan.order.id)).limit(1);
  return { plan, refundPlan, result: { editId, code: plan.order.code, state: order!.state, grandTotal: order!.grandTotal, previousGrandTotal: plan.order.grandTotal,
    balance: plan.balance.amountDue, amountDue: await amountDueForOrder(tx, input.storeId, order!.id, order!.grandTotal), settlement: row!.settlement as unknown as SettlementOutcome, replay: false, emailQueued } };
}

/** Cash success is durable even when activation proof/posting fails. Retry only this proposal. */
export async function activatePreparedOrderEdit(tx: Tx, input: { storeId: string; orderId: string; refundId?: string; paymentAttemptId?: string; paymentId?: string }): Promise<boolean> {
  const rows = await tx.select().from(s.orderEdit).where(and(eq(s.orderEdit.storeId, input.storeId), eq(s.orderEdit.orderId, input.orderId)));
  const selected = rows.find(row => {
    const settlement = row.settlement as unknown as EditStageSettlement | null;
    return settlement && (input.refundId ? settlement.refundId === input.refundId : input.paymentAttemptId ? settlement.paymentAttemptId === input.paymentAttemptId : isPendingEditStage(settlement));
  });
  if (!selected) return false;
  await tx.execute(sql`SAVEPOINT order_edit_activation`);
  try {
    const stage = await preparedStage(tx, input.storeId, input.orderId, selected.id);
    if (!stage) throw new Error('Prepared proposal is absent');
    if (stage.settlement.phase === 'activated') {
      assertEditStageActivation({ ...stage, beforeFingerprint: stage.proposal.beforeFingerprint, beforeLedgerPrefixDigest: stage.proposal.beforeLedgerPrefixDigest });
      const activated = (stage.row.after as { activatedPricingSnapshot?: unknown }).activatedPricingSnapshot;
      if (!activated || orderEditStoredFingerprint(creditEconomics(activated as OrderPricingSnapshotV2)) !== orderEditStoredFingerprint(creditEconomics(stage.proposal.pricingSnapshot as OrderPricingSnapshotV2))) throw new Error('Activation receipt pricing differs');
      const a = stage.proposal.activation as CreditActivation;
      const replay = await prepareEditCreditFunding(tx, { ...input, editId: stage.row.id, lines: a.targets, committedEdit: { editId: stage.row.id, requestDigest: stage.proposal.requestDigest, postingKeys: stage.proposal.postingKeys } });
      if (!replay?.plan.replay || !readCurrentOrderPricingSnapshot(activated, { currency: stage.proposal.settlementRequirement.currency,
        orderLines: (activated as OrderPricingSnapshotV2).lines.map(line => ({ id: line.orderLineId, quantity: line.quantity })), mode: 'settlement', creditEvidence: await readCurrentCreditEvidence(tx, input) ?? undefined, ...await loadPricingLineage(tx, input.storeId, input.orderId) })) throw new Error('Activation funding receipt differs');
      await tx.execute(sql`RELEASE SAVEPOINT order_edit_activation`); return true;
    }
    const a = stage.proposal.activation as CreditActivation;
    const { requirement, amendment } = effectiveEditSettlementRequirement(stage.proposal, stage.settlementAmendment);
    const [order] = await tx.select().from(s.order).where(eq(s.order.id, input.orderId)).limit(1);
    if (!order) throw new Error('Prepared order is absent');
    const evidence = await readCurrentCreditEvidence(tx, input);
    if (!evidence) throw new Error('Prepared redemption is absent');
    const lines = await tx.select().from(s.orderLine).where(eq(s.orderLine.orderId, input.orderId));
    const adjustments = await tx.select().from(s.orderAdjustment).where(eq(s.orderAdjustment.orderId, input.orderId)).orderBy(asc(s.orderAdjustment.createdAt));
    const usage = await tx.select().from(s.promotionUsage).where(and(eq(s.promotionUsage.storeId, input.storeId), eq(s.promotionUsage.orderId, input.orderId)));
    // Linked settlement can advance state/timestamp; every stored economic fact remains frozen.
    const beforeFingerprint = orderEditStoredFingerprint({ order: { ...order, state: a.beforeOrder.state, updatedAt: a.beforeOrder.updatedAt, receiptToken: a.beforeOrder.receiptToken },
      lines: lines.sort((x, y) => x.id.localeCompare(y.id)), adjustments, couponCodes: await loadOrderCouponCodes(tx, order),
      usage: usage.sort((x, y) => x.id.localeCompare(y.id)), variants: a.variants.sort((x, y) => x.id.localeCompare(y.id)),
      refundPrefixDigest: refundPrefixDigest(evidence, stage.settlement.refundId) });
    const [refund] = stage.settlement.refundId ? await tx.select().from(s.refund).where(eq(s.refund.id, stage.settlement.refundId)).limit(1) : [];
    const [refundPayment] = refund ? await tx.select().from(s.payment).where(eq(s.payment.id, refund.paymentId)).limit(1) : [];
    const [attempt] = stage.settlement.paymentAttemptId ? await tx.select().from(s.paymentAttempt).where(eq(s.paymentAttempt.id, stage.settlement.paymentAttemptId)).limit(1) : [];
    const [payment] = input.paymentId ? await tx.select().from(s.payment).where(eq(s.payment.id, input.paymentId)).limit(1) : attempt?.paymentId ? await tx.select().from(s.payment).where(eq(s.payment.id, attempt.paymentId)).limit(1) : attempt?.providerRef ? await tx.select().from(s.payment).where(and(
      eq(s.payment.storeId, input.storeId), eq(s.payment.orderId, input.orderId), eq(s.payment.state, 'Settled'),
      eq(s.payment.method, attempt.method), eq(s.payment.providerRef, attempt.providerRef),
      ...(attempt.method === 'stripe' ? [] : [eq(s.payment.gatewayAccount, attempt.accountId), eq(s.payment.gatewayMode, attempt.mode)]),
    )).limit(1) : [];
    if ((requirement.requiredRefund > 0 && refund?.state !== 'Settled') ||
      (requirement.requiredTender > 0 && payment?.state !== 'Settled')) {
      await tx.execute(sql`RELEASE SAVEPOINT order_edit_activation`); return false;
    }
    if (input.paymentAttemptId && input.paymentAttemptId !== attempt?.id) throw new Error('Tender attempt differs');
    if (payment && (!attempt || !payment.currency || payment.storeId !== input.storeId || payment.orderId !== attempt.orderId || payment.currency !== attempt.currency || payment.amount !== attempt.amount || payment.method !== attempt.method || (attempt.providerRef && payment.providerRef !== attempt.providerRef) ||
      (attempt.method !== 'stripe' && (payment.gatewayAccount !== attempt.accountId || payment.gatewayMode !== attempt.mode)))) throw new Error('Tender payment differs or currency proof is absent');
    if (refund && (!refundPayment || refundPayment.storeId !== input.storeId || refundPayment.orderId !== input.orderId || !refundPayment.currency)) throw new Error('Refund payment currency proof is absent');
    assertEditStageActivation({ proposal: stage.proposal, settlement: stage.settlement, settlementAmendment: stage.settlementAmendment, beforeFingerprint, beforeLedgerPrefixDigest: fundingPrefixDigest(evidence),
      ...(refund && refundPayment?.currency ? { linkedRefund: { ...refund, currency: refundPayment.currency } } : {}), ...(attempt && payment?.currency ? { linkedTender: { attemptId: attempt.id, state: payment.state, orderId: payment.orderId, currency: payment.currency, amount: payment.amount } } : {}) });
    const posted = await postEditCreditFunding(tx, { ...input, editId: stage.row.id, lines: a.targets });
    if (!posted || orderEditStoredFingerprint(posted.plan) !== orderEditStoredFingerprint(stage.proposal.fundingPlan)) throw new Error('Prepared funding plan differs');
    const afterEvidence = await readCurrentCreditEvidence(tx, input);
    if (!afterEvidence) throw new Error('Activated funding evidence is absent');
    const actualRows = afterEvidence.history.filter(row => !evidence.history.some(prior => prior.id === row.id));
    if (actualRows.length !== posted.plan.postings.length || actualRows.some(row => !posted.plan.postings.some(posting => Object.entries(posting).every(([key, value]) => orderEditStoredFingerprint(value) === orderEditStoredFingerprint(row[key as keyof typeof row]))))) throw new Error('Posted funding rows differ');
    const pricing = buildCurrentCreditPricingSnapshot({ origin: a.origin, ordinary: a.ordinary, couponCodes: stage.proposal.couponCodes, evidence: afterEvidence, pricingSources: (await loadPricingLineage(tx, input.storeId, input.orderId)).pricingSources, originalUnitIndexes: a.indexes, ordinaryUnitFacts: a.ordinaryUnitFacts,
      predecessor: a.predecessor, unitIds: a.unitIds, lineage: a.lineage, sourceCustody: a.predecessor.sourceCustody });
    if (orderEditStoredFingerprint(creditEconomics(pricing)) !== orderEditStoredFingerprint(creditEconomics(stage.proposal.pricingSnapshot as OrderPricingSnapshotV2))) throw new Error('Activated pricing differs from accepted proposal');
    for (const [variantId, delta] of a.stockDeltas) if (delta < 0) await tx.update(s.stock).set({ allocated: sql`greatest(${s.stock.allocated} - ${-delta}, 0)` }).where(and(eq(s.stock.storeId, input.storeId), eq(s.stock.variantId, variantId)));
    for (const line of a.working.lines) {
      const id = stage.proposal.lineIds[line.key]!, ordinary = a.perLine.find(p => p.key === line.key)!, final = pricing.lines.find(p => p.orderLineId === id)!;
      const values = { variantId: line.variantId, variantSku: line.sku, variantName: line.name, quantity: line.quantity, unitPrice: ordinary.unitPrice,
        lineSubtotal: ordinary.lineSubtotal, lineDiscount: ordinary.lineSubtotal - final.lineNet, lineTax: final.lineGross - final.lineNet, lineTotal: final.lineGross };
      if (line.id) await tx.update(s.orderLine).set(values).where(eq(s.orderLine.id, id));
      else await tx.insert(s.orderLine).values({ id, storeId: input.storeId, orderId: input.orderId, ...values });
    }
    const keep = a.working.adjustments.flatMap(item => item.id ? [item.id] : []);
    const drop = adjustments.filter(item => !keep.includes(item.id)).map(item => item.id);
    if (drop.length) await tx.delete(s.orderAdjustment).where(inArray(s.orderAdjustment.id, drop));
    const fresh = a.working.adjustments.filter(item => !item.id);
    if (fresh.length) await tx.insert(s.orderAdjustment).values(fresh.map(item => ({ storeId: input.storeId, orderId: input.orderId, label: item.label, amount: item.amount, actor: a.actor })));
    const applied = new Set(stage.proposal.appliedPromotionIds);
    for (const item of usage) if (!applied.has(item.promotionId)) {
      await tx.delete(s.promotionUsage).where(eq(s.promotionUsage.id, item.id));
      await tx.update(s.promotion).set({ usedCount: sql`greatest(${s.promotion.usedCount} - 1, 0)` }).where(eq(s.promotion.id, item.promotionId));
    }
    for (const promotionId of applied) if (!usage.some(item => item.promotionId === promotionId)) {
      const inserted = await tx.insert(s.promotionUsage).values({ storeId: input.storeId, orderId: input.orderId, customerId: order.customerId, promotionId }).onConflictDoNothing().returning({ id: s.promotionUsage.id });
      if (inserted.length) await tx.update(s.promotion).set({ usedCount: sql`${s.promotion.usedCount} + 1` }).where(eq(s.promotion.id, promotionId));
    }
    const meta = (order.metadata ?? {}) as OrderMeta & Record<string, unknown>;
    await tx.update(s.order).set({ subtotal: pricing.totals.subtotal, discountTotal: pricing.totals.discountTotal, shippingTotal: pricing.totals.shippingTotal, taxTotal: pricing.totals.taxTotal, grandTotal: pricing.totals.grandTotal, couponCodes: stage.proposal.couponCodes, pricingSnapshot: pricing, isPreOrder: a.isPreOrder, promotionId: a.newPromoId,
      shippingOverride: a.shipping.override, ...(a.working.shipping.kind !== 'keep' || a.shipping.methodCode !== order.shippingMethodCode ? { shippingMethodCode: a.shipping.methodCode, shippingMethodName: a.shipping.methodName } : {}),
      shippingAddress: a.working.shippingAddress ? addressRow(a.working.shippingAddress) : order.shippingAddress, billingAddress: a.working.billingAddress ? addressRow(a.working.billingAddress) : order.billingAddress,
      metadata: a.working.shipping.kind !== 'keep' || meta.shipping ? { ...meta, shipping: { methodCode: a.shipping.methodCode, base: a.shipping.base, override: a.shipping.override } } : order.metadata, updatedAt: new Date() }).where(eq(s.order.id, input.orderId));
    if (a.working.saveToAddressBook) { await saveToAddressBook(tx, input.storeId, order.customerId, a.working.shippingAddress); await saveToAddressBook(tx, input.storeId, order.customerId, a.working.billingAddress); }
    const activatedAt = new Date().toISOString();
    const settlement = { ...stage.settlement, phase: 'activated' as const, status: requirement.requiredRefund ? 'settled' : requirement.requiredTender ? 'recorded' : stage.settlement.status,
      activationReceipt: { proposalDigest: stage.proposal.proposalDigest, requestDigest: stage.proposal.requestDigest, postingKeys: stage.proposal.postingKeys, activatedAt, activatedSnapshotHash: creditPricingSnapshotDigest(pricing), ...(amendment ? { amendmentDigest: amendment.digest } : {}) } };
    await tx.update(s.orderEdit).set({ settlement, after: { ...(stage.row.after as object), activatedPricingSnapshot: pricing } }).where(eq(s.orderEdit.id, stage.row.id));
    const due = await amountDueForOrder(tx, input.storeId, input.orderId, pricing.totals.grandTotal);
    if (order.customerId) {
      const snap = orderLoyaltySnapshot(order.metadata);
      if (snap) { const target = editedEarnTarget(snap, { subtotal: pricing.totals.subtotal, discountTotal: pricing.totals.discountTotal, taxRate: a.taxRate, taxInclusive: a.taxInclusive,
        lines: a.working.lines.filter(line => line.quantity > 0 && line.variantId && a.variants.some(v => v.id === line.variantId)).map(line => ({ productId: a.variants.find(v => v.id === line.variantId)!.productId, cents: a.perLine.find(p => p.key === line.key)!.lineSubtotal })) });
        if (target != null) await syncEditEarn(tx, { storeId: input.storeId, orderId: input.orderId, editId: stage.row.id, targetEarn: target, actor: a.actor, settled: due <= 0 }); }
    }
    let finalState = order.state;
    if (order.state === 'PendingPayment' && due <= 0) {
      const paidAt = new Date();
      await recordSettlementOperation(tx, { storeId: input.storeId, kind: 'order_paid_transition', operationId: order.id, orderId: order.id,
        mutations: [{ type: 'order_paid', orderId: order.id, placedAt: paidAt }], effects: paidOrderEffects({ orderId: order.id, customerId: order.customerId, paidAt, variant: 'settle' }) });
      finalState = 'Paid';
    } else if ((order.state === 'Paid' || order.state === 'PartiallyRefunded') && due <= 0) await recordSettlementOperation(tx, { storeId: input.storeId, kind: 'order_edit_balance_settled', operationId: stage.row.id, mutations: [], effects: editBalanceEffects({ orderId: order.id, customerId: order.customerId, deferredEarn: false, actorKind: a.principalKind }) });
    if (a.notifyCustomer && a.recipient) await enqueueOrderUpdated(tx, input.storeId, a.storeCtx, a.recipient, { code: order.code, currency: order.currency, beforeTotal: a.beforeOrder.grandTotal, afterTotal: pricing.totals.grandTotal, changes: a.changes, balance: stage.row.balance, reason: a.reason, dedupeKey: `order_updated:${stage.row.id}` });
    await tx.insert(s.auditLog).values({ storeId: input.storeId, actor: a.actor, entity: 'order', entityId: input.orderId, action: 'edit', fromState: a.beforeOrder.state, toState: finalState, data: { editId: stage.row.id, proposalDigest: stage.proposal.proposalDigest, previousGrandTotal: a.beforeOrder.grandTotal, grandTotal: pricing.totals.grandTotal, balance: stage.row.balance } });
    await emitEvent(tx, input.storeId, 'order.updated', { code: order.code, editId: stage.row.id, previousGrandTotal: a.beforeOrder.grandTotal, grandTotal: pricing.totals.grandTotal, balance: stage.row.balance, currency: order.currency, reason: a.reason });
    await tx.execute(sql`RELEASE SAVEPOINT order_edit_activation`);
    if (a.stockDeltas.some(([, delta]) => delta < 0)) afterCommit(tx, () => { void import('../manifest/stock-hook.js').then(({ onStockChanged }) => onStockChanged(a.storeSlug)); });
    return true;
  } catch (error) {
    await tx.execute(sql`ROLLBACK TO SAVEPOINT order_edit_activation`); await tx.execute(sql`RELEASE SAVEPOINT order_edit_activation`);
    await tx.update(s.orderEdit).set({ settlement: { ...(selected.settlement as object), status: 'reconciliation_required', message: 'Settled payment requires edit activation reconciliation.' } }).where(eq(s.orderEdit.id, selected.id));
    await tx.insert(s.auditLog).values({ storeId: input.storeId, actor: 'system', entity: 'order', entityId: input.orderId, action: 'edit_activation_reconciliation', data: { editId: selected.id, errorCode: error instanceof OrderEditError ? error.code : 'ACTIVATION_PROOF_FAILED' } });
    return false;
  }
}
/**
 * The stored settlement is a snapshot taken when the edit committed; an async
 * refund (Pending) later settles or fails in the shared refund finalizer, which
 * knows nothing about order_edit. Derive the live outcome from the linked refund
 * row so history shows the truth and a failed refund becomes retryable.
 */
export async function liveEditSettlement(tx: Tx, storeId: string, st: SettlementOutcome): Promise<SettlementOutcome> {
  if (st.type !== 'refund_now' || !st.refundId) return st;
  const [r] = await tx.select({ state: s.refund.state }).from(s.refund)
    .where(and(eq(s.refund.storeId, storeId), eq(s.refund.id, st.refundId))).limit(1);
  if (!r) return st;
  if (st.phase && st.status === 'reconciliation_required') return { ...st, refundState: r.state };
  const status = r.state === 'Settled' ? 'settled' : r.state === 'Failed' ? 'failed' : 'pending';
  if (status === st.status && r.state === st.refundState) return st;
  const { message: _m, ...rest } = st;
  return { ...rest, refundState: r.state, status,
    ...(status === 'failed' ? { message: 'the gateway declined the refund — retry it from the order edit, or leave it as credit' } : {}) };
}

/** A connection can fail after the refund reservation committed. Link that
 *  deterministic attempt before recording failure so reconciliation stays visible. */
async function recoverEditRefundSettlement(storeId: string, idempotencyKey: string, out: SettlementOutcome): Promise<SettlementOutcome> {
  return withStore(storeId, async tx => {
    const [refund] = await tx.select({ id: s.refund.id }).from(s.refund)
      .innerJoin(s.paymentAttempt, eq(s.paymentAttempt.id, s.refund.attemptId))
      .where(and(eq(s.refund.storeId, storeId), eq(s.paymentAttempt.idempotencyKey, `refund:${idempotencyKey}`))).limit(1);
    return refund ? liveEditSettlement(tx, storeId, { ...out, refundId: refund.id }) : out;
  });
}

export interface CommitResult {
  editId: string; code: string; state: string; grandTotal: number; previousGrandTotal: number;
  /** Balance at commit time (+ owed, - credit). */
  balance: number; amountDue: number; settlement: SettlementOutcome; replay: boolean; emailQueued: boolean;
}

const fingerprintOf = (i: CommitInput) => createHash('sha256').update(JSON.stringify({
  code: i.code, ops: i.ops, settlement: i.settlement ?? null, expectedGrandTotal: i.expectedGrandTotal,
  expectedBalance: i.expectedBalance ?? null, notify: i.notifyCustomer, reason: i.reason ?? null,
  previewAcceptanceHash: i.previewAcceptanceHash ?? null,
  pricingOptions: editPricingOptions(i),
})).digest('hex');

const fmt = (cents: number, cur: string) => `${(Math.abs(cents) / 100).toFixed(2)} ${cur}`;

/** Human change list for the customer email, from the line diff. */
export function describeChanges(plan: Pick<EditPlan, 'lineDiffs' | 'before' | 'after' | 'address'>, currency: string): string[] {
  const out: string[] = [];
  for (const d of plan.lineDiffs) {
    if (d.change === 'added') out.push(`Added ${d.afterQty} × ${d.name}`);
    else if (d.change === 'removed') out.push(`Removed ${d.name}`);
    else if (d.change === 'quantity') out.push(`${d.name}: quantity ${d.beforeQty} → ${d.afterQty}`);
    else if (d.change === 'swapped') out.push(`${d.fromSku} changed to ${d.name}`);
  }
  const b = plan.before.totals, a = plan.after.totals;
  if (a.discountTotal !== b.discountTotal) out.push(`Discount: ${fmt(b.discountTotal, currency)} → ${fmt(a.discountTotal, currency)}`);
  if (a.shippingTotal !== b.shippingTotal) out.push(`Shipping: ${fmt(b.shippingTotal, currency)} → ${fmt(a.shippingTotal, currency)}`);
  if (a.taxTotal !== b.taxTotal) out.push(`Tax: ${fmt(b.taxTotal, currency)} → ${fmt(a.taxTotal, currency)}`);
  if (a.adjustmentTotal !== b.adjustmentTotal) out.push(`Adjustment: ${a.adjustmentTotal - b.adjustmentTotal >= 0 ? '+' : '-'}${fmt(a.adjustmentTotal - b.adjustmentTotal, currency)}`);
  if (plan.address.shipping.changed) out.push('Shipping address updated');
  if (plan.address.billing.changed) out.push('Billing address updated');
  return out;
}

const addressRow = (a: Address) => ({ fullName: a.fullName, line1: a.line1, line2: a.line2, city: a.city, province: a.province, postalCode: a.postalCode, country: a.country, phone: a.phone });

async function saveToAddressBook(tx: Tx, storeId: string, customerId: string | null, a: Address | null | undefined): Promise<boolean> {
  if (!customerId || !a || !a.line1 || !a.city || !a.country) return false;
  const existing = await tx.select().from(s.address).where(eq(s.address.customerId, customerId));
  if (existing.some((e) => e.line1 === a.line1 && e.city === a.city && (e.postalCode ?? null) === a.postalCode && e.country === a.country && (e.fullName ?? null) === a.fullName && (e.line2 ?? null) === a.line2)) return false;
  await tx.insert(s.address).values({ storeId, customerId, fullName: a.fullName, line1: a.line1, line2: a.line2, city: a.city, province: a.province, postalCode: a.postalCode, country: a.country, phone: a.phone });
  return true;
}

/** Best-effort cancel of the order's open Stripe intents; the commit's
 *  hasConfirmableIntent guard fails closed if any survive. */
async function retireOrderIntents(storeId: string, code: string, actor: string): Promise<void> {
  const [ord] = await withStore(storeId, (tx) => tx.select({ id: s.order.id }).from(s.order)
    .where(and(eq(s.order.storeId, storeId), eq(s.order.code, code))).limit(1));
  if (ord) await cancelOrderStripeIntents(storeId, ord.id, actor);
}

/**
 * Only a human may commit an edit that adds, removes, swaps or resizes an entitlement-bearing line. Decided from the plan
 * (the affected variants), so an agent's physical-only edit is allowed. Defence in depth behind the route, which relies on
 * this same check; reconciliation refuses issuance for an agent edit independently (handlers.ts editReconcile).
 */
export function assertPrincipalMayCommit(principalKind: 'human' | 'agent', plan: Pick<EditPlan, 'working' | 'variantsById'>): void {
  if (principalKind !== 'human' && planChangesEntitlements(plan.working.lines, plan.variantsById)) {
    throw new OrderEditError(403, 'AGENT_FORBIDDEN', 'agents cannot perform this action');
  }
}

export async function commitOrderEdit(input: CommitInput): Promise<CommitResult> {
  const { storeId } = input;
  const fp = fingerprintOf(input);
  // Retire confirmable Stripe intents (minted at the pre-edit amount) BEFORE the
  // edit: Stripe I/O must run with no pay lock held (the sweep takes it). A
  // capture that already succeeded settles against the still-unedited total.
  // Only a NEW edit (no stored replay for the key) whose preview matches and
  // whose priced totals change retires anything: an idempotent replay or a
  // stale/invalid request must never cancel a newer legitimate intent. The
  // locked commit below re-validates everything and keeps the survivor check.
  const retire = await withStore(storeId, async (tx) => {
    const [prior] = await tx.select({ id: s.orderEdit.id }).from(s.orderEdit)
      .where(and(eq(s.orderEdit.storeId, storeId), eq(s.orderEdit.idempotencyKey, input.idempotencyKey))).limit(1);
    if (prior) return false;
    const plan = await planOrderEdit(tx, storeId, input.code, input.ops, { ...editPricingOptions(input), lock: false });
    assertPrincipalMayCommit(input.principalKind, plan); // before any Stripe I/O or write
    if (plan.previewAcceptanceHash !== input.previewAcceptanceHash || plan.after.totals.grandTotal !== input.expectedGrandTotal ||
      (input.expectedBalance != null && plan.balance.amountDue !== input.expectedBalance)) {
      throw new OrderEditError(409, 'PREVIEW_STALE', 'the order changed since the preview — review the new totals and try again', { grandTotal: plan.after.totals.grandTotal, balance: plan.balance.amountDue });
    }
    return !totalsInert(plan.before.totals, plan.after.totals);
  });
  if (retire) await retireOrderIntents(storeId, input.code, input.actor);
  // The pay advisory lock serializes this commit with an in-flight /pay for the
  // same order, so the charge amount and the total can never disagree mid-edit.
  const orderId = await lockableOrderId(storeId, input.code);
  return withAdvisoryLocks([`pay:${storeId}:${input.code}`, `refund:${storeId}:${orderId}`], async (held) => {
    let stockChanged = false;
    type Applied = { result: CommitResult; plan: EditPlan | null; refundPlan?: { amount: number; paymentId: string } };
    // STOREKIT §5.8 #15: the order's licences (L2) are planned and locked before the
    // order row (L3); the plan/lock/verify set owns the transaction.
    const applied: Applied = await withLockedSet(storeId, { kind: 'order', orderId }, async (tx): Promise<Applied> => {
      // Replay: the stored edit wins over re-applying (the total already moved).
      const [prior] = await tx.select().from(s.orderEdit).where(and(eq(s.orderEdit.storeId, storeId), eq(s.orderEdit.idempotencyKey, input.idempotencyKey))).limit(1);
      if (prior) {
        const [o] = await tx.select().from(s.order).where(eq(s.order.id, prior.orderId)).limit(1);
        if (!o || o.code !== input.code || prior.fingerprint !== fp) throw new OrderEditError(409, 'IDEMPOTENCY_KEY_REUSED', 'this idempotency key was used for a different edit');
        let st = await liveEditSettlement(tx, storeId, (prior.settlement ?? { type: 'none', status: 'none' }) as SettlementOutcome);
        if (isPendingEditStage(st)) {
          await activatePreparedOrderEdit(tx, { storeId, orderId: o.id, ...(st.refundId ? { refundId: st.refundId } : {}), ...(st.paymentAttemptId ? { paymentAttemptId: st.paymentAttemptId } : {}) });
          const [updated] = await tx.select().from(s.orderEdit).where(eq(s.orderEdit.id, prior.id)).limit(1);
          st = updated!.settlement as unknown as SettlementOutcome;
        }
        const [current] = await tx.select().from(s.order).where(eq(s.order.id, o.id)).limit(1);
        const dueNow = await amountDueForOrder(tx, storeId, o.id, current!.grandTotal);
        const before = prior.before as OrderSnapshot;
        const result: CommitResult = { editId: prior.id, code: o.code, state: current!.state, grandTotal: current!.grandTotal, previousGrandTotal: before.totals.grandTotal, balance: prior.balance, amountDue: dueNow, settlement: st, replay: true, emailQueued: false };
        // A refund_now that did not finish is re-driven (idempotent by key).
        if (st.type === 'refund_now' && st.status !== 'settled' && st.status !== 'reconciliation_required' && prior.balance < 0) {
          const [pay] = st.paymentId ? await tx.select().from(s.payment).where(eq(s.payment.id, st.paymentId)).limit(1) : [];
          if (pay) return { result, plan: null, refundPlan: { amount: -prior.balance, paymentId: pay.id } };
        }
        return { result, plan: null };
      }

      const plan = await planOrderEdit(tx, storeId, input.code, input.ops, { ...editPricingOptions(input), lock: true });
      assertPrincipalMayCommit(input.principalKind, plan); // re-checked on the locked plan: the order may have changed since the unlocked one
      const o = plan.order;
      if (plan.previewAcceptanceHash !== input.previewAcceptanceHash || plan.after.totals.grandTotal !== input.expectedGrandTotal || (input.expectedBalance != null && plan.balance.amountDue !== input.expectedBalance)) {
        throw new OrderEditError(409, 'PREVIEW_STALE', 'the order changed since the preview — review the new totals and try again', { grandTotal: plan.after.totals.grandTotal, balance: plan.balance.amountDue });
      }
      const balance = plan.balance.amountDue;
      const settlement = validateSettlement(balance, input.settlement);
      // Pre-flight everything that can refuse, before any write.
      let refundPlan: { amount: number; paymentId: string } | undefined;
      if (settlement?.type === 'refund_now') {
        const f = refundFeasibility(plan, -balance, settlement.paymentId);
        if (!f.feasible) throw new OrderEditError(409, 'REFUND_NOT_POSSIBLE', f.reason ?? 'refund not possible', { reason: f.reason });
        refundPlan = { amount: -balance, paymentId: f.paymentId! };
      }
      if (settlement?.type === 'send_pay_link' && !plan.recipient) throw new OrderEditError(409, 'NO_RECIPIENT', 'this order has no customer email to send a pay link to');

      if (plan.credit) return prepareCreditedOrderEdit(tx, input, plan, settlement, fp, refundPlan);

      // ── stock (live; only the unfulfilled delta) ──────────────────────────
      const reserve: Array<{ sku: string; quantity: number }> = [];
      const reserveMap = new Map<string, VariantFacts>();
      for (const [variantId, delta] of plan.stockDeltas) {
        const v = plan.variantsById.get(variantId)!;
        if (delta < 0) {
          await tx.update(s.stock).set({ allocated: sql`greatest(${s.stock.allocated} - ${-delta}, 0)` }).where(and(eq(s.stock.variantId, variantId), eq(s.stock.storeId, storeId)));
          stockChanged = true;
        } else {
          reserve.push({ sku: v.sku, quantity: delta }); reserveMap.set(v.sku, v);
        }
      }
      if (reserve.length) {
        try { stockChanged = (await reserveStockOrThrow(tx, storeId, reserve, reserveMap)) || stockChanged; }
        catch (e) {
          if (e instanceof StockReservationError) { stockChanged = false; throw new OrderEditError(409, 'OUT_OF_STOCK', 'insufficient stock for the added quantity', { skus: e.skus }); }
          throw e;
        }
      }

      // ── lines ─────────────────────────────────────────────────────────────
      const dbLines = await tx.select().from(s.orderLine).where(eq(s.orderLine.orderId, o.id));
      const lineIds = new Map(plan.working.lines.map(line => [line.key, line.id ?? randomUUID()]));
      for (const l of plan.working.lines) {
        const p = plan.priced.perLine.find((x) => x.key === l.key)!;
        if (!l.id) {
          await tx.insert(s.orderLine).values({
            id: lineIds.get(l.key)!, storeId, orderId: o.id, variantId: l.variantId, variantSku: l.sku, variantName: l.name, quantity: l.quantity, unitPrice: l.unitPrice,
            lineSubtotal: p.lineSubtotal, lineDiscount: p.lineDiscount, lineTax: plan.stack.result.lineSnapshots.find(line => line.lineKey === l.key)!.lineGross - plan.stack.result.lineSnapshots.find(line => line.lineKey === l.key)!.lineNet, lineTotal: p.lineTotal,
          });
          continue;
        }
        const cur = dbLines.find((x) => x.id === l.id)!;
        const lineFacts = plan.stack.result.lineSnapshots.find(line => line.lineKey === l.key)!;
        const lineTax = lineFacts.lineGross - lineFacts.lineNet;
        if (cur.quantity === l.quantity && cur.unitPrice === l.unitPrice && cur.variantId === l.variantId && cur.lineSubtotal === p.lineSubtotal && cur.lineDiscount === p.lineDiscount && cur.lineTotal === p.lineTotal && cur.lineTax === lineTax) continue;
        await tx.update(s.orderLine).set({
          quantity: l.quantity, unitPrice: l.unitPrice, variantId: l.variantId, variantSku: l.sku, variantName: l.name,
          lineSubtotal: p.lineSubtotal, lineDiscount: p.lineDiscount, lineTax, lineTotal: p.lineTotal,
        }).where(eq(s.orderLine.id, l.id));
      }

      // ── adjustments (replaced as a set; history lives in order_edit) ───────
      const keep = new Set(plan.working.adjustments.map((a) => a.id).filter((x): x is string => !!x));
      const existingAdj = await tx.select({ id: s.orderAdjustment.id }).from(s.orderAdjustment).where(eq(s.orderAdjustment.orderId, o.id));
      const drop = existingAdj.map((a) => a.id).filter((id) => !keep.has(id));
      if (drop.length) await tx.delete(s.orderAdjustment).where(inArray(s.orderAdjustment.id, drop));
      const fresh = plan.working.adjustments.filter((a) => !a.id);
      if (fresh.length) await tx.insert(s.orderAdjustment).values(fresh.map((a) => ({ storeId, orderId: o.id, label: a.label, amount: a.amount, actor: input.actor })));

      // ── promotion usage ledger ────────────────────────────────────────────
      const newPromoId = plan.promotionRow?.id ?? null;
      const usageRows = await tx.select({ promotionId: s.promotionUsage.promotionId }).from(s.promotionUsage)
        .where(and(eq(s.promotionUsage.storeId, storeId), eq(s.promotionUsage.orderId, o.id)));
      const appliedPromotions = new Set(plan.stack.result.applied.map(entry => entry.promotionId));
      for (const usage of usageRows) if (!appliedPromotions.has(usage.promotionId)) {
        const del = await tx.delete(s.promotionUsage).where(and(eq(s.promotionUsage.storeId, storeId), eq(s.promotionUsage.orderId, o.id), eq(s.promotionUsage.promotionId, usage.promotionId))).returning({ id: s.promotionUsage.id });
        if (del.length) await tx.update(s.promotion).set({ usedCount: sql`greatest(${s.promotion.usedCount} - 1, 0)` }).where(eq(s.promotion.id, usage.promotionId));
      }
      for (const promotionId of appliedPromotions) if (!usageRows.some(usage => usage.promotionId === promotionId)) {
        const ins = await tx.insert(s.promotionUsage).values({ storeId, promotionId, customerId: o.customerId, orderId: o.id }).onConflictDoNothing().returning({ id: s.promotionUsage.id });
        if (ins.length) await tx.update(s.promotion).set({ usedCount: sql`${s.promotion.usedCount} + 1` }).where(eq(s.promotion.id, promotionId));
      }

      // ── the order row ─────────────────────────────────────────────────────
      const meta = (o.metadata ?? {}) as OrderMeta & Record<string, unknown>;
      const t = plan.priced.totals;
      const currentPricing = buildOrderPricingSnapshot(plan.stack.input, plan.stack.result, lineIds);
      let receiptToken = o.receiptToken;
      if (settlement?.type === 'send_pay_link' && !receiptToken) receiptToken = randomBytes(32).toString('base64url');
      await tx.update(s.order).set({
        subtotal: t.subtotal, discountTotal: t.discountTotal, shippingTotal: t.shippingTotal, taxTotal: t.taxTotal, grandTotal: t.grandTotal,
        couponCodes: [...plan.working.couponCodes], pricingSnapshot: currentPricing,
        isPreOrder: plan.isPreOrder, promotionId: newPromoId, shippingOverride: plan.shipping.override, receiptToken,
        // Persisted method (0086): set/cleared only when this edit changed the shipping line.
        ...(plan.working.shipping.kind !== 'keep' || plan.shipping.methodCode !== o.shippingMethodCode ? { shippingMethodCode: plan.shipping.methodCode, shippingMethodName: plan.shipping.methodName } : {}),
        shippingAddress: plan.working.shippingAddress ? addressRow(plan.working.shippingAddress) : o.shippingAddress,
        billingAddress: plan.working.billingAddress ? addressRow(plan.working.billingAddress) : o.billingAddress,
        // Record the shipping basis only when this edit set it (or one already
        // existed): a legacy order's unrecorded base is never cemented from a guess.
        metadata: plan.working.shipping.kind !== 'keep' || meta.shipping
          ? { ...meta, shipping: { methodCode: plan.shipping.methodCode, base: plan.shipping.base, override: plan.shipping.override } } : o.metadata,
        updatedAt: new Date(),
      }).where(eq(s.order.id, o.id));
      if (plan.working.saveToAddressBook) {
        if (plan.working.shippingAddress) await saveToAddressBook(tx, storeId, o.customerId, plan.working.shippingAddress);
        if (plan.working.billingAddress) await saveToAddressBook(tx, storeId, o.customerId, plan.working.billingAddress);
      }

      // ── the edit record ───────────────────────────────────────────────────
      const outcome: SettlementOutcome = { type: settlement?.type ?? 'none', status: 'none' };
      const [edit] = await tx.insert(s.orderEdit).values({
        storeId, orderId: o.id, idempotencyKey: input.idempotencyKey, fingerprint: fp,
        before: { ...plan.before, currentPricing: plan.order.pricingSnapshot ?? plan.legacyPricingSnapshot, financialLines: plan.storedLines,
          ...(plan.importedPricingBasis ? { importedPricingBasis: plan.importedPricingBasis, storedOrder: plan.order } : {}) },
        after: { ...plan.after, lines: plan.after.lines.map((line, index) => ({ ...line, id: lineIds.get(plan.working.lines[index]!.key)! })),
          pricingOptions: plan.pricingOptions, currentPricing, currentPricingDigest: creditPricingSnapshotDigest(currentPricing) }, balance, settlement: outcome as object,
        reason: input.reason ?? null, actor: input.actor,
      }).returning({ id: s.orderEdit.id });
      const editId = edit!.id;

      // ── settlement parts that live inside the transaction ──────────────────
      const storefrontUrl = resolveStorefrontUrl(plan.storeCtx);
      let payUrl: string | undefined;
      if (settlement?.type === 'record_payment') {
        const amount = settlement.amount ?? balance;
        // PAYMENT-TIMING §4.6: the placement hook for an edit-recorded tender (provider 'manual') runs before the tender.
        try {
          await checkPlacement(tx, storeId, { id: o.id, storeId, code: o.code, state: o.state, currency: o.currency, grandTotal: t.grandTotal, customerId: o.customerId, metadata: o.metadata }, 'manual');
        } catch (e) {
          // PAYMENT-TIMING §3.6: a placement veto rolls the edit back (the throw aborts this tx); it surfaces as 409 with the veto's code.
          if (e instanceof PaymentPolicyVetoError) throw new OrderEditError(409, e.veto.code, e.veto.message, e.veto.extra);
          if (e instanceof PaymentPolicyUnavailableError) throw new OrderEditError(503, 'PAYMENT_POLICY_UNAVAILABLE', 'payment is temporarily unavailable, retry shortly');
          throw e;
        }
        const r = await applyPaymentResult(tx, {
          storeId, method: 'manual', amount, editId,
          order: { id: o.id, state: o.state, grandTotal: t.grandTotal, currency: o.currency, customerId: o.customerId, code: o.code },
          result: { state: 'Settled', providerRef: `manual:${editId}`, metadata: { manual: { method: settlement.method, reference: settlement.reference ?? null, recordedBy: input.actor, editId } } },
        });
        const [pay] = await tx.select({ id: s.payment.id }).from(s.payment).where(and(eq(s.payment.orderId, o.id), eq(s.payment.providerRef, `manual:${editId}`))).limit(1);
        outcome.status = 'recorded'; outcome.amount = amount; outcome.paymentId = pay?.id; outcome.paymentMethod = settlement.method; outcome.reference = settlement.reference ?? null;
        await tx.insert(s.auditLog).values({ storeId, actor: input.actor, entity: 'order', entityId: o.id, action: 'record_payment', fromState: o.state, toState: r.orderState, data: { editId, method: settlement.method, reference: settlement.reference ?? null, amount } });
      } else if (settlement?.type === 'send_pay_link') {
        payUrl = `${storefrontUrl}/orders/${encodeURIComponent(o.code)}?rt=${encodeURIComponent(receiptToken!)}&pay=balance`;
        outcome.status = 'sent';
      } else if (settlement?.type === 'leave_due') outcome.status = 'due';
      else if (settlement?.type === 'leave_credit') outcome.status = 'credit';
      else if (settlement?.type === 'refund_now') { outcome.status = 'pending'; outcome.paymentId = refundPlan!.paymentId; outcome.amount = refundPlan!.amount; }

      // ── loyalty: keep the earn on the edited merchandise ───────────────────
      // Unpaid order: the checkout snapshot is rewritten so the later payment
      // earns on the edited lines. Paid order: post the delta, but a POSITIVE
      // delta is held back until the balance is settled (see syncEditEarn).
      // Points redeemed on the order stay as stored (pointsDiscount is carried
      // into the new totals); only the earn moves with the merchandise.
      let loyaltyEarn: { delta: number; posted: number; shortfall: number; deferred?: boolean; snapshotUpdated?: boolean } | null = null;
      if (o.customerId) {
        const snap = orderLoyaltySnapshot(o.metadata);
        if (snap) {
          const target = editedEarnTarget(snap, {
            subtotal: t.subtotal, discountTotal: t.discountTotal, taxRate: plan.taxRate, taxInclusive: plan.taxInclusive,
            lines: plan.working.lines.filter((l) => l.quantity > 0 && l.variantId && plan.variantsById.get(l.variantId))
              .map((l) => ({ productId: plan.variantsById.get(l.variantId!)!.productId, cents: plan.priced.perLine.find((p) => p.key === l.key)!.lineSubtotal })),
          });
          if (target != null) {
            const dueAfter = await amountDueForOrder(tx, storeId, o.id, t.grandTotal);
            const r = await syncEditEarn(tx, { storeId, orderId: o.id, editId, targetEarn: target, actor: input.actor, settled: dueAfter <= 0 });
            if (r.delta !== 0) loyaltyEarn = r;
          }
        }
      }

      // ── customer email (one message: the summary carries the pay link) ─────
      let emailQueued = false;
      const changes = describeChanges(plan, o.currency);
      if (plan.recipient) {
        if (input.notifyCustomer) {
          emailQueued = await enqueueOrderUpdated(tx, storeId, plan.storeCtx, plan.recipient, {
            code: o.code, currency: o.currency, beforeTotal: o.grandTotal, afterTotal: t.grandTotal, changes, balance,
            payUrl, reason: input.reason ?? null, dedupeKey: `order_updated:${editId}`,
          });
        } else if (payUrl) {
          emailQueued = await enqueueOrderBalanceDue(tx, storeId, plan.storeCtx, plan.recipient, {
            code: o.code, currency: o.currency, amountDue: balance, payUrl, dedupeKey: `order_balance_due:${editId}`,
          });
        }
      }

      // ── timeline, event, settlement record ─────────────────────────────────
      const [afterRow] = await tx.select({ state: s.order.state }).from(s.order).where(eq(s.order.id, o.id)).limit(1);
      await tx.update(s.orderEdit).set({ settlement: outcome as object }).where(eq(s.orderEdit.id, editId));
      await tx.insert(s.auditLog).values({
        storeId, actor: input.actor, entity: 'order', entityId: o.id, action: 'edit', fromState: o.state, toState: afterRow?.state ?? o.state,
        data: { editId, reason: input.reason ?? null, changes, previousGrandTotal: o.grandTotal, grandTotal: t.grandTotal, balance, settlement: outcome.type, notifyCustomer: input.notifyCustomer, ...(loyaltyEarn ? { loyaltyEarn } : {}) },
      });
      await emitEvent(tx, storeId, 'order.updated', { code: o.code, editId, previousGrandTotal: o.grandTotal, grandTotal: t.grandTotal, balance, currency: o.currency, reason: input.reason ?? null });

      const dueNow = await amountDueForOrder(tx, storeId, o.id, t.grandTotal);
      // Entitlements follow money: a Paid/PartiallyRefunded order that is fully
      // funded after this edit (zero-balance swaps, credit-covered additions,
      // manual payments) gets licenses for its licensed lines now — no later
      // balance payment will ever call the settle-side reconcile. Idempotent.
      const finalState = afterRow?.state ?? o.state;
      if ((finalState === 'Paid' || finalState === 'PartiallyRefunded') && dueNow <= 0) {
        await recordSettlementOperation(tx, { storeId, kind: 'order_edit_balance_settled', operationId: editId, mutations: [], effects: editBalanceEffects({ orderId: o.id, customerId: o.customerId ?? null, deferredEarn: false, actorKind: input.principalKind }) });
      }
      return {
        plan, refundPlan,
        result: { editId, code: o.code, state: afterRow?.state ?? o.state, grandTotal: t.grandTotal, previousGrandTotal: o.grandTotal, balance, amountDue: dueNow, settlement: outcome, replay: false, emailQueued },
      };
    }).catch((e: unknown) => { stockChanged = false; return orderBusy(e); });

    if (stockChanged) { const { onStockChanged } = await import('../manifest/stock-hook.js'); onStockChanged(input.storeSlug); }

    // ── refund_now: the refund engine does gateway I/O, so it runs with no
    // transaction open. The edit is already committed; a refund that fails or
    // stays pending is reported (and recorded) rather than undoing the edit.
    if (applied.refundPlan) {
      const rp = applied.refundPlan;
      const [ord] = await withStore(storeId, (tx) => tx.select({ id: s.order.id }).from(s.order).where(eq(s.order.code, input.code)).limit(1));
      let out: SettlementOutcome = { ...applied.result.settlement, type: 'refund_now', paymentId: rp.paymentId, amount: rp.amount };
      try {
        const r = await requestRefund({
          storeId, orderId: ord!.id, actor: input.actor, idempotencyKey: `order-edit:${input.idempotencyKey}`,
          paymentId: rp.paymentId, amount: rp.amount, reason: editRefundReason(input.reason), source: 'order_edit', ...(applied.result.settlement.phase ? { editId: applied.result.editId } : {}),
        }, held);
        out = { ...out, refundId: r.refundId, refundState: r.refundState, status: r.refundState === 'Settled' ? 'settled' : r.refundState === 'Pending' ? 'pending' : 'failed' };
        if (r.refundState === 'Failed') out.message = 'the gateway declined the refund — retry it from the order edit, or leave it as credit';
      } catch (e) {
        out = { ...out, status: 'failed', message: e instanceof RefundError ? e.message : 'refund could not be issued' };
        out = await recoverEditRefundSettlement(storeId, `order-edit:${input.idempotencyKey}`, out);
      }
      const final = await withStore(storeId, async (tx) => {
        const [edit] = await tx.select().from(s.orderEdit).where(eq(s.orderEdit.id, applied.result.editId)).limit(1).for('update');
        const staged = edit?.settlement as unknown as SettlementOutcome | null;
        // Callback activation may already have advanced phase/receipt. Preserve it.
        out = staged?.phase ? { ...out, ...staged, ...(out.refundId ? { refundId: out.refundId, refundState: out.refundState } : {}), ...(staged.phase === 'activated' || staged.status === 'reconciliation_required' ? {} : { status: out.status, message: out.message }) } : out;
        await tx.update(s.orderEdit).set({ settlement: out as object }).where(eq(s.orderEdit.id, applied.result.editId));
        await tx.insert(s.auditLog).values({ storeId, actor: input.actor, entity: 'order', entityId: ord!.id, action: 'edit_refund', data: { editId: applied.result.editId, ...out } });
        const [o2] = await tx.select().from(s.order).where(eq(s.order.id, ord!.id)).limit(1);
        return { state: o2!.state, total: o2!.grandTotal, due: await amountDueForOrder(tx, storeId, ord!.id, o2!.grandTotal) };
      });
      applied.result.settlement = out; applied.result.state = final.state; applied.result.grandTotal = final.total; applied.result.amountDue = final.due;
    }
    return applied.result;
  });
}

// ── failed edit-refund recovery ──────────────────────────────────────────────
export interface RetryEditRefundInput {
  storeId: string; code: string; editId: string; actor: string; action: 'retry' | 'credit'; paymentId?: string;
}

/**
 * An edit's refund_now that the gateway declined (settlement.status 'failed')
 * cannot be recovered from the generic Refund panel: that refund would not
 * carry source=order_edit, so the order would read as owing the money again.
 * 'retry' issues a NEW refund with the same provenance (source order_edit,
 * fresh deterministic idempotency key per attempt) for the amount currently
 * owed back; 'credit' abandons the refund and leaves the amount as store credit
 * on the order. Either updates the edit's settlement record.
 */
export async function retryOrderEditRefund(input: RetryEditRefundInput): Promise<{ editId: string; state: string; amountDue: number; settlement: SettlementOutcome }> {
  const { storeId } = input;
  const orderId = await lockableOrderId(storeId, input.code);
  return withAdvisoryLocks([`pay:${storeId}:${input.code}`, `refund:${storeId}:${orderId}`], async (held) => {
    const ctx = await withLockedSet(storeId, { kind: 'order', orderId }, async (tx) => {
      const [o] = await tx.select().from(s.order).where(and(eq(s.order.storeId, storeId), eq(s.order.code, input.code))).limit(1).for('update');
      if (!o || o.deletedAt) throw new OrderEditError(404, 'ORDER_NOT_FOUND', 'order not found');
      const [edit] = await tx.select().from(s.orderEdit).where(and(eq(s.orderEdit.storeId, storeId), eq(s.orderEdit.orderId, o.id), eq(s.orderEdit.id, input.editId))).limit(1);
      if (!edit) throw new OrderEditError(404, 'EDIT_NOT_FOUND', 'order edit not found');
      let st = await liveEditSettlement(tx, storeId, (edit.settlement ?? {}) as SettlementOutcome);
      const stage = await preparedStage(tx, storeId, o.id, edit.id);
      if (stage) {
        const completed = async () => { const [current] = await tx.select().from(s.order).where(eq(s.order.id, o.id)).limit(1);
          const [journal] = await tx.select().from(s.orderEdit).where(eq(s.orderEdit.id, edit.id)).limit(1);
          return { editId: edit.id, state: current!.state, amountDue: await amountDueForOrder(tx, storeId, o.id, current!.grandTotal), settlement: journal!.settlement as unknown as SettlementOutcome }; };
        if (stage.settlement.phase === 'activated') return { kind: 'completed' as const, completed: await completed() };
        if (stage.settlement.refundId) {
          const [linked] = await tx.select().from(s.refund).where(eq(s.refund.id, stage.settlement.refundId)).limit(1);
          if (linked?.state === 'Settled') { await activatePreparedOrderEdit(tx, { storeId, orderId: o.id, refundId: linked.id }); return { kind: 'completed' as const, completed: await completed() }; }
        }
        if (input.action === 'credit') {
          const attempts = await tx.select().from(s.paymentAttempt).where(and(eq(s.paymentAttempt.storeId, storeId), eq(s.paymentAttempt.orderId, o.id), sql`${s.paymentAttempt.idempotencyKey} like ${`refund:order-edit:${edit.idempotencyKey}%`}`));
          const refunds = attempts.length ? await tx.select().from(s.refund).where(inArray(s.refund.attemptId, attempts.map(attempt => attempt.id))) : [];
          if (attempts.some(attempt => attempt.status !== 'failed') || refunds.some(refund => refund.state !== 'Failed') ||
            (stage.settlement.refundId && !refunds.some(refund => refund.id === stage.settlement.refundId && refund.state === 'Failed'))) throw new OrderEditError(409, 'REFUND_UNRESOLVED', 'Reconcile every refund attempt before leaving credit.');
          const linked = refunds.find(refund => refund.id === stage.settlement.refundId);
          const amendment = buildEditSettlementAmendment(stage.proposal, linked?.id ?? null, linked?.attemptId ?? null);
          await tx.update(s.orderEdit).set({ after: { ...(edit.after as object), settlementAmendment: amendment }, settlement: { ...stage.settlement, amendmentDigest: amendment.digest, type: 'leave_credit', phase: 'ready', status: 'credit' } }).where(eq(s.orderEdit.id, edit.id));
          await activatePreparedOrderEdit(tx, { storeId, orderId: o.id });
          return { kind: 'completed' as const, completed: await completed() };
        }
        if (input.paymentId && input.paymentId !== st.paymentId) throw new OrderEditError(409, 'ORDER_EDIT_REFUND_INVALID', 'Retry must use accepted original payment.');
      }
      if (st.type !== 'refund_now' || st.status !== 'failed') throw new OrderEditError(409, 'REFUND_NOT_RETRYABLE', 'this edit has no failed refund to recover');
      const amountDue = stage ? -stage.proposal.settlementRequirement.requiredRefund : await amountDueForOrder(tx, storeId, o.id, o.grandTotal);
      if (amountDue >= 0) throw new OrderEditError(409, 'NOTHING_OWED', 'nothing is currently owed back on this order');
      const payments = await tx.select().from(s.payment).where(and(eq(s.payment.orderId, o.id), eq(s.payment.state, 'Settled')));
      const refunds = await tx.select().from(s.refund).where(and(eq(s.refund.orderId, o.id), sql`${s.refund.state} <> 'Failed'`));
      const refundable: RefundablePayment[] = payments.filter((p) => !isDuplicatePayment(p)).map((p) => ({
        id: p.id, method: p.method, amount: p.amount,
        available: p.amount - refunds.filter((r) => r.paymentId === p.id).reduce((n, r) => n + r.amount, 0),
      })).filter((p) => p.available > 0);
      const attempts = await tx.select({ id: s.paymentAttempt.id }).from(s.paymentAttempt)
        .where(and(eq(s.paymentAttempt.storeId, storeId), sql`${s.paymentAttempt.idempotencyKey} like ${`refund:order-edit:${edit.idempotencyKey}:retry:%`}`));
      return { kind: 'retry' as const, o, edit, st, amountDue, refundable, attempt: attempts.length + 1 };
    }).catch(orderBusy);
    if (ctx.kind === 'completed') return ctx.completed;
    const { o, edit, st } = ctx;
    const finish = async (out: SettlementOutcome, auditAction: string) => withStore(storeId, async (tx) => {
      const [journal] = await tx.select().from(s.orderEdit).where(eq(s.orderEdit.id, edit.id)).limit(1).for('update');
      const currentSettlement = journal?.settlement as unknown as SettlementOutcome | null;
      if (currentSettlement?.phase) out = { ...out, ...currentSettlement, ...(out.refundId ? { refundId: out.refundId, refundState: out.refundState } : {}), ...(currentSettlement.phase === 'activated' || currentSettlement.status === 'reconciliation_required' ? {} : { status: out.status, message: out.message }) };
      await tx.update(s.orderEdit).set({ settlement: out as object }).where(eq(s.orderEdit.id, edit.id));
      await tx.insert(s.auditLog).values({ storeId, actor: input.actor, entity: 'order', entityId: o.id, action: auditAction, data: { editId: edit.id, ...out } });
      const [o2] = await tx.select().from(s.order).where(eq(s.order.id, o.id)).limit(1);
      return { editId: edit.id, state: o2!.state, amountDue: await amountDueForOrder(tx, storeId, o.id, o2!.grandTotal), settlement: out };
    });
    if (input.action === 'credit') {
      return finish({ type: 'leave_credit', status: 'credit', amount: -ctx.amountDue, message: 'refund abandoned; left as credit on the order' }, 'edit_refund_credit');
    }
    const f = refundFeasibility({ order: o, refundable: ctx.refundable }, -ctx.amountDue, input.paymentId ?? st.paymentId);
    if (!f.feasible) throw new OrderEditError(409, 'REFUND_NOT_POSSIBLE', f.reason ?? 'refund not possible', { reason: f.reason });
    let out: SettlementOutcome = { ...st, type: 'refund_now', paymentId: f.paymentId, amount: -ctx.amountDue };
    try {
      const r = await requestRefund({
        storeId, orderId: o.id, actor: input.actor, idempotencyKey: `order-edit:${edit.idempotencyKey}:retry:${ctx.attempt}`,
        paymentId: f.paymentId, amount: -ctx.amountDue, reason: editRefundReason(edit.reason), source: 'order_edit', ...(st.phase ? { editId: edit.id } : {}),
      }, held);
      out = { ...out, refundId: r.refundId, refundState: r.refundState, status: r.refundState === 'Settled' ? 'settled' : r.refundState === 'Pending' ? 'pending' : 'failed' };
      out.message = r.refundState === 'Failed' ? 'the gateway declined the refund again — retry later or leave it as credit' : undefined;
    } catch (e) {
      out = { ...out, status: 'failed', message: e instanceof RefundError ? e.message : 'refund could not be issued' };
      out = await recoverEditRefundSettlement(storeId, `order-edit:${edit.idempotencyKey}:retry:${ctx.attempt}`, out);
    }
    return finish(out, 'edit_refund_retry');
  });
}

// ── direct address save (G5) ─────────────────────────────────────────────────
export interface SaveAddressInput {
  storeId: string; code: string; actor: string; kind: 'shipping' | 'billing';
  address: Address; saveToAddressBook?: boolean; reason?: string;
}
export interface SaveAddressResult { code: string; kind: 'shipping' | 'billing'; address: Address; changed: boolean; savedToAddressBook: boolean }

/** Same-country (or billing) address edit on any non-cancelled order. A
 *  shipping COUNTRY change re-derives tax/shipping eligibility, so it is refused
 *  here (409 COUNTRY_CHANGE_REQUIRES_EDIT) and must go through the edit
 *  preview/commit flow that shows the resulting balance. */
export async function saveOrderAddress(input: SaveAddressInput): Promise<SaveAddressResult> {
  const { storeId } = input;
  return withStore(storeId, async (tx) => {
    const [o] = await tx.select().from(s.order).where(eq(s.order.code, input.code)).limit(1).for('update');
    if (!o || o.deletedAt) throw new OrderEditError(404, 'ORDER_NOT_FOUND', 'order not found');
    assertImportedEditAllowed(importedEditAdmission(o.metadata), 'address');
    await assertNoPendingOrderEdit(tx, storeId, o.id);
    assertEditable(o.state, [{ op: 'set_address', kind: input.kind, address: input.address as never }]);
    const before = readAddress(input.kind === 'shipping' ? o.shippingAddress : o.billingAddress);
    if (input.kind === 'shipping' && countryChanged(before, input.address)) {
      throw new OrderEditError(409, 'COUNTRY_CHANGE_REQUIRES_EDIT', 'changing the shipping country changes tax and shipping — use the order edit preview', { requiresPreview: true });
    }
    const changed = !sameAddress(before, input.address);
    let saved = false;
    if (changed) {
      await tx.update(s.order).set(input.kind === 'shipping' ? { shippingAddress: addressRow(input.address), updatedAt: new Date() } : { billingAddress: addressRow(input.address), updatedAt: new Date() }).where(eq(s.order.id, o.id));
    }
    if (input.saveToAddressBook) saved = await saveToAddressBook(tx, storeId, o.customerId, input.address);
    if (changed) {
      const snap = (a: Address | null) => ({ addresses: { [input.kind]: a } });
      await tx.insert(s.orderEdit).values({ storeId, orderId: o.id, before: snap(before) as object, after: snap(input.address) as object, balance: 0, reason: input.reason ?? null, actor: input.actor });
      await tx.insert(s.auditLog).values({ storeId, actor: input.actor, entity: 'order', entityId: o.id, action: 'edit_address', fromState: o.state, toState: o.state, data: { kind: input.kind, before, after: input.address, reason: input.reason ?? null, savedToAddressBook: saved } });
      await emitEvent(tx, storeId, 'order.updated', { code: o.code, address: input.kind, currency: o.currency, reason: input.reason ?? null });
    }
    return { code: o.code, kind: input.kind, address: input.address, changed, savedToAddressBook: saved };
  });
}

// ── context for the admin UI ─────────────────────────────────────────────────
export async function loadEditContext(storeId: string, code: string) {
  return withStore(storeId, async (tx) => {
    const [o] = await tx.select().from(s.order).where(eq(s.order.code, code)).limit(1);
    if (!o || o.deletedAt) throw new OrderEditError(404, 'ORDER_NOT_FOUND', 'order not found');
    const sourceAdmission = importedEditAdmission(o.metadata);
    const lines = await tx.select().from(s.orderLine).where(eq(s.orderLine.orderId, o.id));
    const adjustments = await tx.select().from(s.orderAdjustment).where(eq(s.orderAdjustment.orderId, o.id)).orderBy(asc(s.orderAdjustment.createdAt));
    const methods = await tx.select().from(s.shippingMethod).where(eq(s.shippingMethod.enabled, true));
    const history = await tx.select({ id: s.orderEdit.id, actor: s.orderEdit.actor, reason: s.orderEdit.reason, balance: s.orderEdit.balance, settlement: s.orderEdit.settlement, createdAt: s.orderEdit.createdAt, before: s.orderEdit.before, after: s.orderEdit.after })
      .from(s.orderEdit).where(eq(s.orderEdit.orderId, o.id)).orderBy(desc(s.orderEdit.createdAt)).limit(25);
    const meta = (o.metadata ?? {}) as OrderMeta;
    const amountDue = await amountDueForOrder(tx, storeId, o.id, o.grandTotal);
    const unresolved = await hasUnresolvedPayment(tx, o.id);
    const protectedPricing = await pricingEditProtected(tx, storeId, o);
    const couponCodes = await loadOrderCouponCodes(tx, o);
    const pending = history.find(edit => isPendingEditStage(edit.settlement));
    const items = EDITABLE_STATES.has(o.state) && !protectedPricing && !sourceAdmission.planRefusal && !pending;
    const address = o.state !== 'Cancelled' && !sourceAdmission.addressRefusal && !pending;
    return {
      code: o.code, state: o.state, currency: o.currency, couponCodes, pricingOptions: editPricingOptions({}),
      editable: { items: items && !unresolved, addressOnly: !items && address, address, blockedReason: pending ? 'Resolve the prepared order edit before changing its economics.' : sourceAdmission.planRefusal?.message ?? (o.state === 'Cancelled' ? 'This order is cancelled.' : unresolved ? 'A payment on this order is unresolved — resolve it before editing items.' : protectedPricing ? 'This order supports address changes only; its saved pricing must remain intact.' : !items ? `A ${o.state} order can only have its address edited.` : null) },
      pendingEdit: pending ? { id: pending.id, settlement: pending.settlement, proposal: (pending.after as { proposal?: unknown } | null)?.proposal ?? null, proposed: pending.after } : null,
      lines: lines.map((l) => ({ id: l.id, sku: l.variantSku, name: l.variantName, quantity: l.quantity, unitPrice: l.unitPrice, lineTotal: l.lineTotal, fulfilledQty: l.fulfilledQty, refundedQty: l.refundedQty, minQuantity: lockedQty(l) })),
      adjustments: adjustments.map((a) => ({ id: a.id, label: a.label, amount: a.amount, actor: a.actor, createdAt: a.createdAt.toISOString() })),
      shipping: { amount: o.shippingTotal, override: o.shippingOverride, methodCode: o.shippingMethodCode ?? meta.shipping?.methodCode ?? null },
      shippingMethods: methods.map((m) => ({ code: m.code, name: m.name, rate: shippingRate(m.calculator) })),
      amountDue, shippingAddress: readAddress(o.shippingAddress), billingAddress: readAddress(o.billingAddress), hasCustomer: !!o.customerId,
      importedHistory: await loadImportedOrderHistory(tx, storeId, o.id, lines),
      history: await Promise.all(history.map(async (h) => ({ id: h.id, actor: h.actor, reason: h.reason, balance: h.balance, settlement: h.settlement ? await liveEditSettlement(tx, storeId, h.settlement as SettlementOutcome) : h.settlement, createdAt: h.createdAt.toISOString(), grandTotalBefore: (h.before as { totals?: { grandTotal?: number } }).totals?.grandTotal ?? null, grandTotalAfter: (h.after as { totals?: { grandTotal?: number } }).totals?.grandTotal ?? null }))),
    };
  });
}

/** Variant picker for add / swap: enabled variants matching sku/name, with live availability. */
export async function searchEditVariants(storeId: string, q: string, limit = 20) {
  const term = `%${q.replace(/[%_\\]/g, '\\$&')}%`;
  return withStore(storeId, async (tx) => {
    const rows = await tx.select({ id: s.productVariant.id, sku: s.productVariant.sku, name: s.productVariant.name, productName: s.product.name, price: s.productVariant.price, salePrice: s.productVariant.salePrice, isPreOrder: s.productVariant.isPreOrder, preOrderPrice: s.productVariant.preOrderPrice, onHand: s.stock.onHand, allocated: s.stock.allocated })
      .from(s.productVariant).innerJoin(s.product, eq(s.product.id, s.productVariant.productId))
      .leftJoin(s.stock, eq(s.stock.variantId, s.productVariant.id))
      .where(and(eq(s.productVariant.enabled, true), isNull(s.productVariant.deletedAt), or(ilike(s.productVariant.sku, term), ilike(s.productVariant.name, term), ilike(s.product.name, term))))
      .orderBy(asc(s.productVariant.sku)).limit(Math.min(50, Math.max(1, limit)));
    const [storeRow] = await tx.select({ config: s.store.config }).from(s.store).where(eq(s.store.id, storeId)).limit(1);
    const rule = variantPriceRuleFromConfig(storeRow?.config);
    return rows.map((r) => ({ sku: r.sku, name: r.name, productName: r.productName, unitPrice: selectUnitPrice(r, rule), available: r.onHand == null ? null : r.onHand - (r.allocated ?? 0) }));
  });
}
