/** #395 account credit: permission-gated reads, human-only credit writes; source-only B2.8 fixtures. */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { issue, redeem, reserve } from '../account-credit/service.js';
import type { MatrixMutationFixture } from './authorization-matrix.mutation-cases.testkit.js';
import type { MatrixCase, MatrixCell, MatrixPrincipal, MatrixProof } from './authorization-matrix.testkit.js';

export interface MatrixAccountCreditFixture extends MatrixMutationFixture {
  snapshotFor(principal: MatrixPrincipal, method: string, path: string, expectedStatus?: number, agentGroup?: string): () => Promise<unknown>;
}
type Access = 'credit-read' | 'credit-write';
type Prepared = { url: string; body?: unknown; verify(response: Response, proof: MatrixProof): Promise<void> };
const EXPECTED: Record<Access, Record<MatrixPrincipal, number>> = {
  'credit-read': { owner: 200, manager: 200, staff: 403, read_only: 403, agent: 403, foreign_store: 403, release_service: 401, cache_token: 401 },
  'credit-write': { owner: 200, manager: 200, staff: 403, read_only: 403, agent: 403, foreign_store: 403, release_service: 401, cache_token: 401 },
};
const json = (response: Response) => response.json() as Promise<Record<string, any>>;

export function createAccountCreditCases(fixture: MatrixAccountCreditFixture): MatrixCase[] {
  const cases: MatrixCase[] = [];
  const actor = (principal: MatrixPrincipal) => `${principal}-${fixture.storeSlug}@matrix.invalid`;
  const query = async (sql: string, values: unknown[] = []) => (await fixture.queryStore(fixture.storeId, sql, values)).rows;
  const audit = async (proof: MatrixProof, id: string, action: string, principal: MatrixPrincipal) =>
    proof.equal(await query("select actor from audit_log where entity='account_credit' and entity_id=$1 and action=$2", [id, action]),
      [{ actor: actor(principal) }], 'one account credit audit attributes the session actor', 'state');
  const add = (key: string, access: Access, prepare: (unique: string, principal: MatrixPrincipal) => Promise<Prepared>) => {
    const method = key.split(' ')[0]!;
    const cell = (principal: MatrixPrincipal): MatrixCell => {
      const status = EXPECTED[access][principal], allow = status === 200;
      const group = principal === 'agent' && access === 'credit-write' ? 'credit' : undefined;
      return { effect: allow ? 'allow' : 'deny', status, ...(group ? { errorCode: 'AGENT_NOT_ALLOWED' } : {}), async prepare() {
        const prepared = await prepare(randomUUID(), principal);
        return { url: prepared.url,
          init: { method, headers: { ...fixture.requestHeaders[principal], 'content-type': 'application/json' }, ...(prepared.body === undefined ? {} : { body: JSON.stringify(prepared.body) }) },
          ...(allow ? {} : { snapshot: fixture.snapshotFor(principal, method, prepared.url, status, group) }),
          async verify(response: Response, proof: MatrixProof) {
            if (allow) return prepared.verify(response, proof);
            const body = await json(response);
            if (status === 401) {
              proof.equal(body.error?.code, 'NOT_AUTHENTICATED', 'service/cache cannot authenticate admin');
              proof.ok(['not authenticated', 'invalid or expired session'].includes(body.error?.message), 'authentication denial reason');
            } else if (group) {
              proof.equal(body.error?.code, 'AGENT_NOT_ALLOWED', 'hard agent denial');
              proof.equal(body.error?.message, 'agents cannot issue or adjust customer credit — a human does that', 'exact hard agent reason');
            } else {
              const role = principal === 'agent' ? 'staff' : principal;
              const message = principal === 'foreign_store' ? `no access to store: ${fixture.storeSlug}`
                : access === 'credit-write' && principal === 'read_only' ? "role 'read_only' is read-only"
                : `role '${role}' lacks the 'account_credit' permission`;
              proof.equal(body.error?.message, message, 'exact store/role/permission denial');
            }
          },
        };
      } };
    };
    cases.push({ key, contract: 'admin', cells: { owner: cell('owner'), manager: cell('manager'), staff: cell('staff'), read_only: cell('read_only'),
      agent: cell('agent'), foreign_store: cell('foreign_store'), release_service: cell('release_service'), cache_token: cell('cache_token') } });
  };
  const seedCredit = async (unique: string) => {
    const email = `credit-${unique}@matrix.invalid`;
    const issued = await withStore(fixture.storeId, tx => issue(tx, { storeId: fixture.storeId, email, amount: 1000, issuanceKey: `matrix-seed-${unique}` }));
    return { id: issued.account.id, promotionId: issued.account.promotionId, code: issued.code, email };
  };
  /** A paid order that redeemed 101 cents of the credit as 34/34/33 over three units (as account-credit/service.db.test.ts). */
  const redeemedOrder = (credit: { id: string; promotionId: string }, unique: string) => withStore(fixture.storeId, async tx => {
    const storeId = fixture.storeId;
    const [order] = await tx.insert(s.order).values({ storeId, code: `MATRIX-CREDIT-${unique}`, currency: 'USD', promotionId: credit.promotionId, subtotal: 1500, discountTotal: 101, grandTotal: 1399 }).returning();
    const [line] = await tx.insert(s.orderLine).values({ storeId, orderId: order!.id, variantSku: 'MATRIX-CREDIT', variantName: 'Matrix credit item',
      quantity: 3, unitPrice: 500, lineSubtotal: 1500, lineDiscount: 101, lineTotal: 1399 }).returning();
    await reserve(tx, { storeId, orderId: order!.id, accountId: credit.id, appliedAmount: 101, phase: 'ArrangingPayment' });
    await tx.insert(s.payment).values({ storeId, orderId: order!.id, amount: 1399, method: 'synthetic', state: 'Settled', currency: 'USD' });
    await tx.update(s.order).set({ state: 'Paid' }).where(eq(s.order.id, order!.id));
    await redeem(tx, { storeId, orderId: order!.id, appliedAmount: 101, allocation: { [line!.id]: [34, 34, 33] } });
    return { code: order!.code, lineId: line!.id };
  });

  add('GET /v1/admin/account-credit', 'credit-read', async (unique) => {
    const credit = await seedCredit(unique);
    return { url: `/v1/admin/account-credit?q=${encodeURIComponent(credit.email)}`, async verify(response: Response, proof: MatrixProof) {
      const body = await json(response);
      proof.equal(body.items.map((row: Record<string, unknown>) => [row.id, row.code, row.email, row.balance, row.available, row.disabled]),
        [[credit.id, credit.code, credit.email, 1000, 1000, false]], 'search finds exactly the seeded tenant credit');
    } };
  });
  add('GET /v1/admin/account-credit/{id}', 'credit-read', async (unique) => {
    const credit = await seedCredit(unique);
    return { url: `/v1/admin/account-credit/${credit.id}`, async verify(response: Response, proof: MatrixProof) {
      const body = await json(response);
      proof.equal([body.account.id, body.account.balance], [credit.id, 1000], 'exact seeded account');
      proof.equal(body.ledger.map((row: Record<string, unknown>) => [row.kind, row.status, row.amount]), [['ISSUE', 'POSTED', 1000]], 'issue-only ledger');
      proof.equal(body.redeemedOrders, [], 'no redeemed orders');
    } };
  });
  add('POST /v1/admin/account-credit/issue', 'credit-write', async (unique, principal) => {
    const email = `issue-${unique}@matrix.invalid`;
    const body = { email, amountCents: 2500, issuanceKey: `matrix-issue-${unique}`, reason: 'Matrix goodwill' };
    return { url: '/v1/admin/account-credit/issue', body, async verify(response: Response, proof: MatrixProof) {
      const out = await json(response);
      proof.equal([out.created, out.account.email, out.account.balance, out.account.disabled], [true, email, 2500, false], 'new email-bound credit');
      proof.equal(await query('select balance,initial_amount from account_credit where id=$1', [out.account.id]), [{ balance: 2500, initial_amount: 2500 }], 'credit committed', 'state');
      await audit(proof, out.account.id, 'account_credit_issue', principal);
    } };
  });
  add('POST /v1/admin/account-credit/issue-batch', 'credit-write', async (unique) => {
    const email = `batch-${unique}@matrix.invalid`;
    const body = { batch: `matrix-${unique.slice(0, 8)}`, rows: [{ email, amountCents: 1200 }], apply: false, reason: 'Matrix batch' };
    return { url: '/v1/admin/account-credit/issue-batch', body, async verify(response: Response, proof: MatrixProof) {
      const out = await json(response);
      proof.equal([out.applied, out.count, out.totalCents, out.errors, out.issued], [false, 1, 1200, [], []], 'preview issues nothing');
      proof.ok(/^[0-9a-f]{64}$/.test(out.digest), 'preview digest');
      proof.equal(await query('select id from account_credit where email_normalized=$1', [email]), [], 'preview writes no credit', 'state');
    } };
  });
  add('POST /v1/admin/account-credit/{id}/adjust', 'credit-write', async (unique, principal) => {
    const credit = await seedCredit(unique);
    return { url: `/v1/admin/account-credit/${credit.id}/adjust`, body: { deltaCents: -250, operationKey: `matrix-adjust-${unique}`, reason: 'Matrix correction' }, async verify(response: Response, proof: MatrixProof) {
      proof.equal((await json(response)).account.balance, 750, 'adjusted balance');
      proof.equal(await query('select balance from account_credit where id=$1', [credit.id]), [{ balance: 750 }], 'adjustment committed', 'state');
      await audit(proof, credit.id, 'account_credit_adjust', principal);
    } };
  });
  add('POST /v1/admin/account-credit/{id}/status', 'credit-write', async (unique, principal) => {
    const credit = await seedCredit(unique);
    return { url: `/v1/admin/account-credit/${credit.id}/status`, body: { disabled: true, operationKey: `matrix-status-${unique}`, reason: 'Matrix support request' }, async verify(response: Response, proof: MatrixProof) {
      proof.equal((await json(response)).account.disabled, true, 'disabled account response');
      proof.equal(await query('select disabled from account_credit where id=$1', [credit.id]), [{ disabled: true }], 'disable committed', 'state');
      await audit(proof, credit.id, 'account_credit_disable', principal);
    } };
  });
  add('POST /v1/admin/account-credit/{id}/restore', 'credit-write', async (unique, principal) => {
    const credit = await seedCredit(unique);
    const order = await redeemedOrder(credit, unique);
    const body = { orderCode: order.code, orderLineId: order.lineId, quantity: 1, expectedCents: 34, operationKey: `matrix-restore-${unique}`, reason: 'Matrix returned unit' };
    return { url: `/v1/admin/account-credit/${credit.id}/restore`, body, async verify(response: Response, proof: MatrixProof) {
      const out = await json(response);
      proof.equal([out.restoredCents, out.account.balance], [34, 933], 'one returned unit restores its funded cents');
      proof.equal(await query('select balance from account_credit where id=$1', [credit.id]), [{ balance: 933 }], 'restoration committed', 'state');
      await audit(proof, credit.id, 'account_credit_restore', principal);
    } };
  });
  return cases;
}
