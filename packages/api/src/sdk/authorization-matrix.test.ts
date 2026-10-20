/** Failure-injection tests for the security gate itself; no DB or production fixtures. */
import type { MatrixProof } from './authorization-matrix.testkit.js';
import { describe, expect, it } from 'vitest';
import { PRINCIPALS, assertMatrixComplete, runAuthorizationMatrix, type MatrixCase, type MatrixCell, type MatrixPrincipal } from './authorization-matrix.testkit.js';
const cells = (make: (p: MatrixPrincipal) => MatrixCell) => Object.fromEntries(PRINCIPALS.map(p => [p, make(p)])) as Record<MatrixPrincipal, MatrixCell>;
const route = { method: 'POST', path: '/v1/admin/test' };
function denied(snapshot: () => Promise<unknown>): MatrixCase {
  return { key: 'POST /v1/admin/test', contract: 'admin', cells: cells(() => ({ effect: 'deny', status: 403, errorCode: 'FORBIDDEN',
    async prepare() { return { url: '/v1/admin/test', init: { method: 'POST' }, snapshot,
      async verify(response: Response, proof: MatrixProof) { proof.equal((await response.json() as any).error.message, 'forbidden', 'denial reason'); },
    }; },
  })) };
}
describe('authorization matrix gate failures', () => {
  it('refuses unclassified registrations & absent principals before executing any request', () => {
    const app = { routes: [route], request: () => { throw new Error('must not execute'); } };
    expect(() => assertMatrixComplete(app, [])).toThrow('all eight principals');
    const incomplete = denied(async () => ({}));
    delete (incomplete.cells as Partial<Record<MatrixPrincipal, MatrixCell>>).agent;
    expect(() => assertMatrixComplete(app, [incomplete])).toThrow('[agent]');
  });
  it('never treats malformed, nonexistent, throttled or unconfigured replies as authorization denials', () => {
    const app = { routes: [route], request: () => new Response() };
    for (const status of [400, 404, 429, 503]) {
      const c = denied(async () => ({})); c.cells.owner.status = status;
      expect(() => assertMatrixComplete(app, [c])).toThrow('non-authorization denial');
    }
  });
  it('permits intentional customer concealment only with authentication code, unchanged state & real customer control', async () => {
    const c: MatrixCase = { key: 'GET /v1/shop/account/orders/{code}', contract: 'customer', cells: cells(() => ({
      effect: 'deny', status: 404, errorCode: 'NOT_AUTHENTICATED', concealment: true,
      async prepare() { return { url: '/v1/shop/account/orders/EXISTING', snapshot: async () => ({ order: 'EXISTING' }),
        async verify(response: Response, proof: MatrixProof) { proof.equal((await response.json() as any).error.code, 'NOT_AUTHENTICATED', 'concealed auth error'); } }; },
    })), async concealmentControl() { return { url: '/v1/shop/account/orders/EXISTING', init: { headers: { authorization: 'Bearer customer-session' } },
      async verify(response: Response, proof: MatrixProof) { proof.equal((await response.json() as any).code, 'EXISTING', 'same existing order'); proof.equal('EXISTING', 'EXISTING', 'seeded existing order unchanged', 'state'); } }; } };
    const app = { routes: [{ method: 'GET', path: '/v1/shop/account/orders/:code' }], request: (_url: string, init?: RequestInit) =>
      new Headers(init?.headers).has('authorization') ? Response.json({ code: 'EXISTING' }) : Response.json({ error: { code: 'NOT_AUTHENTICATED' } }, { status: 404 }) };
    const missingControl = { ...c, concealmentControl: undefined };
    expect(() => assertMatrixComplete(app, [missingControl])).toThrow('invalid concealment contract');
    c.cells.owner.errorCode = 'NOT_FOUND';
    expect(() => assertMatrixComplete(app, [c])).toThrow('invalid concealment contract');
    c.cells.owner.errorCode = 'NOT_AUTHENTICATED';
    expect((await runAuthorizationMatrix({ app, cases: [c] })).denied).toBe(8);
  });
  it('rejects a concealment control proving some other existing target', async () => {
    const c: MatrixCase = { key: 'GET /v1/shop/account/orders/{code}', contract: 'customer', cells: cells(() => ({
      effect: 'deny', status: 404, errorCode: 'NOT_AUTHENTICATED', concealment: true,
      async prepare() { return { url: '/v1/shop/account/orders/REAL-A', snapshot: async () => ({}),
        async verify(response: Response, proof: MatrixProof) { proof.equal((await response.json() as any).error.code, 'NOT_AUTHENTICATED', 'auth concealment'); } }; },
    })), async concealmentControl() { return { url: '/v1/shop/account/orders/DIFFERENT-B', verify() {} }; } };
    const app = { routes: [{ method: 'GET', path: '/v1/shop/account/orders/:code' }],
      request: () => Response.json({ error: { code: 'NOT_AUTHENTICATED' } }, { status: 404 }) };
    await expect(runAuthorizationMatrix({ app, cases: [c] })).rejects.toThrow('same existing target');
  });
  it('admits only exact Stripe bad-signature 400 with real same-payload signed processing control', async () => {
    let processed = 0;
    const c: MatrixCase = { key: 'POST /v1/webhooks/stripe', contract: 'webhook', cells: cells(() => ({
      effect: 'deny', status: 400, signatureFailure: 'stripe',
      async prepare() { return { url: '/v1/webhooks/stripe', init: { method: 'POST', body: '{"id":"REAL-EVENT"}' }, snapshot: async () => ({ processed }),
        async verify(response: Response, proof: MatrixProof) { proof.equal(await response.json(), { error: 'bad signature' }, 'exact signature failure'); } }; },
    })), async signatureControl() { return { url: '/v1/webhooks/stripe', init: { method: 'POST', body: '{"id":"REAL-EVENT"}', headers: { 'stripe-signature': 'synthetic-valid-signature' } },
      async verify(response: Response, proof: MatrixProof) { proof.equal(await response.json(), { received: true }, 'real signed processing');
        proof.equal(processed, 1, 'one authenticated event committed', 'state'); } }; } };
    const app = { routes: [{ method: 'POST', path: '/v1/webhooks/stripe' }], request: (_url: string, init?: RequestInit) => {
      if (new Headers(init?.headers).has('stripe-signature')) { processed++; return Response.json({ received: true }); }
      return Response.json({ error: 'bad signature' }, { status: 400 });
    } };
    expect(() => assertMatrixComplete(app, [{ ...c, signatureControl: undefined }])).toThrow('invalid signature failure contract');
    expect((await runAuthorizationMatrix({ app, cases: [c] })).denied).toBe(8);
    processed = 0;
    await expect(runAuthorizationMatrix({ app: { ...app, request: () => Response.json({ error: 'malformed payload' }, { status: 400 }) }, cases: [c] }))
      .rejects.toThrow('exact stripe signature failure');
  });
  it('fails a denied mutation that changed outbox or provider state even when status/error match', async () => {
    let outbox = 0;
    const app = { routes: [route], request: () => {
      outbox++;
      return Response.json({ error: { code: 'FORBIDDEN', message: 'forbidden' } }, { status: 403 });
    } };
    await expect(runAuthorizationMatrix({ app, cases: [denied(async () => ({ outbox, providers: [] }))] })).rejects.toThrow('denial changed domain/outbox/files/providers');
  });
  it('refuses status-only cells even with unchanged denied effects', async () => {
    const c = denied(async () => ({}));
    c.cells.owner.prepare = async () => ({ url: '/v1/admin/test', init: { method: 'POST' }, snapshot: async () => ({}), verify() {} });
    const app = { routes: [route], request: () => Response.json({ error: { code: 'FORBIDDEN', message: 'forbidden' } }, { status: 403 }) };
    await expect(runAuthorizationMatrix({ app, cases: [c] })).rejects.toThrow('missing meaningful response assertion');
  });
  it('orders all eight denials before fresh positive controls', async () => {
    const requests: string[] = [];
    const deny = denied(async () => ({}));
    const allow: MatrixCase = { key: 'POST /v1/admin/create', contract: 'admin', cells: cells(p => ({ effect: 'allow', status: 200,
      async prepare() { return { url: '/v1/admin/create', init: { method: 'POST' }, async verify(response: Response, proof: MatrixProof) {
        proof.equal((await response.json() as any).created, true, 'created response'); proof.ok(requests.includes('/v1/admin/create'), `committed fixture ${p}`, 'state');
      } }; },
    })) };
    const app = { routes: [route, { method: 'POST', path: '/v1/admin/create' }], request: (url: string) => {
      requests.push(url); return url.endsWith('/create') ? Response.json({ created: true }) : Response.json({ error: { code: 'FORBIDDEN', message: 'forbidden' } }, { status: 403 });
    } };
    const result = await runAuthorizationMatrix({ app, cases: [allow, deny] });
    expect(result.cellCount).toBe(16);
    expect(requests.slice(0, 8)).toEqual(Array(8).fill('/v1/admin/test'));
    expect(requests.slice(8)).toEqual(Array(8).fill('/v1/admin/create'));
  });
});

describe('authorization matrix strict batch diagnostics', () => {
  const diagnostics = (snapshot: () => Promise<unknown>, assertSafe: () => void | Promise<void> = () => {}) => ({
    snapshotFor: () => snapshot, assertSafe,
  });
  const refusal = () => Response.json({ error: { code: 'FORBIDDEN', message: 'forbidden' } }, { status: 403 });
  it('collects independent unchanged response failures & ends with AggregateError, never partial PASS', async () => {
    let calls = 0, failure: unknown;
    const snapshot = async () => ({ domain: [], outbox: [], files: [], providers: [] });
    try {
      await runAuthorizationMatrix({ app: { routes: [route], request() {
        calls++; return calls <= 2 ? Response.json({ error: 'unexpected validation' }, { status: 400 }) : refusal();
      } }, cases: [denied(snapshot)], diagnostics: diagnostics(snapshot) });
    } catch (error) { failure = error; }
    expect(calls).toBe(8); expect(failure).toBeInstanceOf(AggregateError);
    const aggregate = failure as AggregateError;
    expect(aggregate.errors).toHaveLength(2);
    expect(aggregate.message).toContain('terminal FAIL; no partial PASS');
    expect(aggregate.errors.map((error: Error) => error.message)).toEqual([
      'authorization matrix: status POST /v1/admin/test [owner]: expected 403, received 400',
      'authorization matrix: status POST /v1/admin/test [manager]: expected 403, received 400',
    ]);
    // Rejected positive requests have no prepared denial journal. The runner
    // must obtain the additional complete baseline before sending any request.
    const positive: MatrixCase = { key: 'POST /v1/admin/create', contract: 'admin', cells: cells(() => ({
      effect: 'allow', status: 200, async prepare() { return {
        url: '/v1/admin/create', init: { method: 'POST' },
        verify(_response: Response, proof: MatrixProof) { proof.equal(true, true, 'success'); proof.equal(true, true, 'committed', 'state'); },
      }; },
    })) };
    let rejectedCalls = 0, positiveFailure: unknown;
    try {
      await runAuthorizationMatrix({ app: { routes: [{ method: 'POST', path: '/v1/admin/create' }],
        request() { rejectedCalls++; return Response.json({ error: 'conflict' }, { status: 409 }); } },
        cases: [positive], diagnostics: diagnostics(snapshot) });
    } catch (error) { positiveFailure = error; }
    expect(rejectedCalls).toBe(8); expect(positiveFailure).toBeInstanceOf(AggregateError);
    expect((positiveFailure as AggregateError).errors).toHaveLength(8);
  });
  it('aborts immediately on changed full state even when response mismatch would be collectable', async () => {
    let writes = 0, failure: unknown;
    const snapshot = async () => ({ writes, outbox: [], files: [], providers: [] });
    try {
      await runAuthorizationMatrix({ app: { routes: [route], request() {
        writes++; return Response.json({ error: 'wrong' }, { status: 400 });
      } }, cases: [denied(snapshot)], diagnostics: diagnostics(snapshot) });
    } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('authorization matrix: denial changed domain/outbox/files/providers POST /v1/admin/test [owner]');
    expect((failure as Error).cause).toBeInstanceOf(Error);
    expect(((failure as Error).cause as Error).message).toBe('authorization matrix: status POST /v1/admin/test [owner]: expected 403, received 400');
    expect(writes).toBe(1);
    const stateFailure = denied(async () => ({}));
    stateFailure.cells.owner.prepare = async () => ({ url: '/v1/admin/test', init: { method: 'POST' }, snapshot: async () => ({}),
      verify(_response: Response, proof: MatrixProof) { proof.equal(false, true, 'state postcondition', 'state'); } });
    let calls = 0;
    await expect(runAuthorizationMatrix({ app: { routes: [route], request() { calls++; return refusal(); } },
      cases: [stateFailure], diagnostics: diagnostics(async () => ({})) })).rejects.toThrow('state postcondition');
    expect(calls).toBe(1);
  });
  it('retains the exact positive response failure when a GET audit makes continuation unsafe', async () => {
    let calls = 0, failure: unknown;
    const audit: string[] = [];
    const snapshot = async () => ({ domain: [], audit: [...audit], outbox: [], files: [], providers: [] });
    const exported: MatrixCase = { key: 'GET /v1/admin/export', contract: 'admin', cells: cells(() => ({
      effect: 'allow', status: 200, async prepare() { return { url: '/v1/admin/export',
        async verify(response: Response, proof: MatrixProof) { proof.equal(await response.text(), 'expected export', 'exact export bytes'); },
      }; },
    })) };
    try {
      await runAuthorizationMatrix({ app: { routes: [{ method: 'GET', path: '/v1/admin/export' }], request() {
        calls++; audit.push('export'); return new Response('unexpected export');
      } }, cases: [exported], diagnostics: diagnostics(snapshot) });
    } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('authorization matrix: failed cell changed domain/outbox/files/providers GET /v1/admin/export [owner]');
    expect((failure as Error).cause).toBeInstanceOf(Error);
    expect(((failure as Error).cause as Error).message).toBe('authorization matrix: GET /v1/admin/export [owner]: exact export bytes');
    expect(calls).toBe(1); expect(audit).toEqual(['export']);
  });
  it('keeps unknown verification exceptions fatal despite an unchanged journal', async () => {
    let calls = 0;
    const c = denied(async () => ({}));
    c.cells.owner.prepare = async () => ({ url: '/v1/admin/test', init: { method: 'POST' }, snapshot: async () => ({}),
      verify() { throw new TypeError('unknown fixture failure'); } });
    await expect(runAuthorizationMatrix({ app: { routes: [route], request() { calls++; return refusal(); } }, cases: [c],
      diagnostics: diagnostics(async () => ({})) })).rejects.toThrow('unknown fixture failure');
    expect(calls).toBe(1);
  });
  it('stops on preparation failure without using a post-prepare journal to pretend isolation', async () => {
    let prepared = 0, calls = 0;
    const c = denied(async () => ({}));
    for (const principal of PRINCIPALS) c.cells[principal].prepare = async () => {
      prepared++; throw new Error('preparation failed after possible fixture writes');
    };
    await expect(runAuthorizationMatrix({ app: { routes: [route], request() { calls++; return refusal(); } }, cases: [c],
      diagnostics: diagnostics(async () => ({})) })).rejects.toThrow('preparation failed');
    expect(prepared).toBe(1); expect(calls).toBe(0);
  });
  it('never aggregates a forbidden network/isolation breach hidden behind a response mismatch', async () => {
    let calls = 0, forbidden = false;
    const safe = () => { if (forbidden) throw new Error('forbidden network attempt'); };
    await expect(runAuthorizationMatrix({ app: { routes: [route], request() {
      calls++; forbidden = true; return Response.json({ error: 'wrong' }, { status: 400 });
    } }, cases: [denied(async () => ({}))], diagnostics: diagnostics(async () => ({}), safe) })).rejects.toThrow('forbidden network attempt');
    expect(calls).toBe(1);
  });
  it('preserves full successful results & accepts genuine positive state changes with all proofs intact', async () => {
    const run = async (batch: boolean) => {
      let writes = 0, snapshots = 0;
      const snapshot = async () => { snapshots++; return { writes }; };
      const create: MatrixCase = { key: 'POST /v1/admin/create', contract: 'admin', cells: cells(() => ({
        effect: 'allow', status: 200, async prepare() { const prior = writes; return {
          url: '/v1/admin/create', init: { method: 'POST' },
          verify(_response: Response, proof: MatrixProof) {
            proof.equal(true, true, 'created response'); proof.equal(writes, prior + 1, 'one write committed', 'state');
          },
        }; },
      })) };
      const result = await runAuthorizationMatrix({ app: { routes: [route, { method: 'POST', path: '/v1/admin/create' }],
        request(url: string) { if (url.endsWith('/create')) { writes++; return Response.json({ created: true }); } return refusal(); } },
        cases: [create, denied(snapshot)], ...(batch ? { diagnostics: diagnostics(snapshot) } : {}) });
      return { result, writes, snapshots };
    };
    const baseline = await run(false), batch = await run(true);
    expect(batch.result).toEqual(baseline.result); expect(batch.result.cellCount).toBe(16);
    expect(batch.result.allowed).toBe(8); expect(batch.result.denied).toBe(8);
    expect(batch.writes).toBe(8); expect(batch.snapshots).toBe(baseline.snapshots + 8);
  });
});
