/** Source-only B2.8 authorization gate. Never exported or packed into the engine. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

export const PRINCIPALS = ['owner', 'manager', 'staff', 'read_only', 'agent', 'foreign_store', 'release_service', 'cache_token'] as const;
export type MatrixPrincipal = (typeof PRINCIPALS)[number];
export type ProofDomain = 'response' | 'state';
export interface MatrixProof {
  equal(actual: unknown, expected: unknown, label: string, domain?: ProofDomain): void;
  ok(condition: unknown, label: string, domain?: ProofDomain): asserts condition;
}
export interface PreparedMatrixCell {
  url: string;
  init?: RequestInit;
  /** Synthetic in-process peer bindings; never forged proxy headers. */
  env?: Record<string, unknown>;
  verify(response: Response, proof: MatrixProof): void | Promise<void>;
  /** Complete domain/outbox/files/provider snapshot; exclude only documented auth bookkeeping. */
  snapshot?: () => Promise<unknown>;
}
export interface MatrixCell {
  effect: 'allow' | 'deny';
  status: number;
  errorCode?: string;
  /** Only source-proven named customer/capability auth concealment; requires a real customer control on this case. */
  concealment?: true;
  /** Named webhook sources reject valid-shaped bad cryptographic signatures as exact 400. Never a generic validation exception. */
  signatureFailure?: 'stripe' | 'apple-storekit';
  /** Claimed installation is hidden only after a genuine fresh-install bootstrap qualification. */
  setupClaimed?: true;
  prepare(): Promise<PreparedMatrixCell>;
}
export interface MatrixCase {
  key: string;
  /** This names the route credential contract, not the supplied admin identity. */
  contract: 'admin' | 'public' | 'customer' | 'capability' | 'webhook' | 'service';
  cells: Record<MatrixPrincipal, MatrixCell>;
  /** Same existing target with genuine customer/license credentials, executed after all denial cells. */
  concealmentControl?: () => Promise<PreparedMatrixCell>;
  /** orders.ts GET accepts receipt capability only as rt query; all other target/query components must match. */
  concealmentQueryCredential?: 'rt';
  /** Same seeded payment/event & payload with configured real signing secret. */
  signatureControl?: () => Promise<PreparedMatrixCell>;
  /** Legacy signed contact URL embeds its HMAC in sig; all payload/query bytes otherwise match. */
  signatureQueryCredential?: 'sig';
  /** Same-process branded bootstrap receipt & real DB/admin binding check. */
  setupQualification?: () => Promise<void>;
}
export interface MatrixApp {
  routes: readonly { method: string; path: string }[];
  request(input: string, init?: RequestInit, env?: Record<string, unknown>): Response | Promise<Response>;
}
export interface MatrixDiagnostics {
  /** Complete fixture journal with only existing exact resolver/audit normalization. */
  snapshotFor(principal: MatrixPrincipal, method: string, path: string, status: number): () => Promise<unknown>;
  /** Fatal provider, listener/job & actual DB identity checks; never collected as cell assertions. */
  assertSafe(): void | Promise<void>;
}
export interface MatrixResult {
  routeCount: number;
  cellCount: number;
  allowed: number;
  denied: number;
  deniedMutationsUnchanged: number;
  caseSetSha256: string;
}
const normalize = (p: string) => p.split('/').map(s => s.replace(/^:([A-Za-z0-9_]+)(?:\{[^}]*\})?/, '{$1}')).join('/');
class MatrixResponseAssertionError extends Error {}
function responseFail(label: string): never { throw new MatrixResponseAssertionError('authorization matrix: ' + label); }
function fail(label: string, cause?: Error): never { throw new Error(`authorization matrix: ${label}`, cause ? { cause } : undefined); }
// Intentional concealment is source-bound, never inferred from an arbitrary 404.
// Source guards: routes/account.ts:301; routes/apps.ts:517,569 (named update/download credentials).
const CONCEALED_AUTH = new Map([
  ['GET /v1/shop/account/orders/{code}', ['customer', 'NOT_AUTHENTICATED']],
  // orders.ts + gateway-payments.ts: real order ownership is concealed without receipt capability.
  ['GET /v1/shop/orders/{code}', ['capability', 'ORDER_NOT_FOUND']],
  ['POST /v1/shop/orders/{code}/pay', ['capability', 'ORDER_NOT_FOUND']],
  ['POST /v1/shop/orders/{code}/payment-intent', ['capability', 'ORDER_NOT_FOUND']],
  ['POST /v1/shop/orders/{code}/payment/refresh', ['capability', 'ORDER_NOT_FOUND']],
  ['POST /v1/shop/orders/{code}/gateway-payment', ['capability', 'ORDER_NOT_FOUND']],
  ['POST /v1/shop/orders/{code}/gateway-payment/{attempt}/verify', ['capability', 'ORDER_NOT_FOUND']],
  ['GET /v1/apps/{appKey}/updates/latest', ['capability', 'LICENSE_NOT_FOUND']],
  ['GET /v1/apps/{appKey}/downloads/{artifactKey}', ['capability', 'DOWNLOAD_NOT_FOUND']],
]);
// Source routes/payment-webhooks.ts:160 & routes/storekit-webhooks.ts:289-301: exact crypto failures.
const SIGNED_CONTROLS = new Map([
  ['POST /v1/webhooks/stripe', 'webhook'], ['POST /v1/webhooks/nmi/{storeId}/{accountId}', 'webhook'],
  ['POST /v1/webhooks/sezzle/{storeId}/{accountId}', 'webhook'], ['POST /v1/webhooks/sheerid/{storeId}', 'webhook'],
  ['POST /v1/webhooks/apple/storekit', 'webhook'], ['GET /v1/shop/contact/confirm-legacy', 'capability'],
]);
const CLAIMED_SETUP = new Set(['GET /v1/setup/status', 'POST /v1/setup/claim']);
const same = (a: unknown, b: unknown, label: string, cause?: Error) => { if (!isDeepStrictEqual(a, b)) fail(label, cause); };
const responseSame = (a: unknown, b: unknown, label: string) => { if (!isDeepStrictEqual(a, b)) responseFail(label); };

/** Inventory uses registered handlers, so protected OpenAPI needs no anonymous fetch. */
export function matrixRouteKeys(app: MatrixApp, extraInventory: readonly { method: string; path: string }[] = []): string[] {
  return [...new Set([...app.routes.filter(r => r.method !== 'ALL'), ...extraInventory]
    .map(r => `${r.method.toUpperCase()} ${normalize(r.path)}`))].sort();
}

/** Fail before executing requests when any actual route or principal lacks an explicit contract. */
export function assertMatrixComplete(app: MatrixApp, cases: readonly MatrixCase[], extraInventory: readonly { method: string; path: string }[] = []): void {
  const actual = matrixRouteKeys(app, extraInventory), seen = new Set<string>();
  const missing: string[] = [];
  for (const c of cases) {
    if (seen.has(c.key)) fail(`duplicate route ${c.key}`);
    seen.add(c.key);
    if (!actual.includes(c.key)) fail(`unregistered route ${c.key}`);
    if (!['admin', 'public', 'customer', 'capability', 'webhook', 'service'].includes(c.contract)) fail(`unclassified route ${c.key}`);
    if (c.concealmentQueryCredential && (c.concealmentQueryCredential !== 'rt' || c.key !== 'GET /v1/shop/orders/{code}' || !c.concealmentControl)) fail('invalid concealment query credential ' + c.key);
    if (c.signatureQueryCredential && (c.signatureQueryCredential !== 'sig' || c.key !== 'GET /v1/shop/contact/confirm-legacy' || !c.signatureControl)) fail('invalid signature query credential ' + c.key);
    if (c.setupQualification && !CLAIMED_SETUP.has(c.key)) fail('invalid setup qualification ' + c.key);
    for (const p of PRINCIPALS) {
      const cell = c.cells[p];
      if (!cell) { missing.push(`${c.key} [${p}]`); continue; }
      if (typeof cell.prepare !== 'function' || !['allow', 'deny'].includes(cell.effect)) fail(`invalid cell ${c.key} [${p}]`);
      // A malformed request, missing object, throttle or missing provider is not authorization evidence.
      const concealment = CONCEALED_AUTH.get(c.key);
      if (cell.concealment && (cell.effect !== 'deny' || !concealment || concealment[0] !== c.contract || concealment[1] !== cell.errorCode || cell.status !== 404 || !c.concealmentControl)) fail(`invalid concealment contract ${c.key} [${p}]`);
      if (cell.signatureFailure && (!(['stripe', 'apple-storekit'] as readonly string[]).includes(cell.signatureFailure) || c.key !== (cell.signatureFailure === 'stripe' ? 'POST /v1/webhooks/stripe' : 'POST /v1/webhooks/apple/storekit') || c.contract !== 'webhook' || cell.effect !== 'deny' || cell.status !== 400 || !c.signatureControl)) fail(`invalid signature failure contract ${c.key} [${p}]`);
      if (c.signatureControl && SIGNED_CONTROLS.get(c.key) !== c.contract) fail(`invalid signature control ${c.key}`);
      if (cell.setupClaimed && (!CLAIMED_SETUP.has(c.key) || c.contract !== 'capability' || cell.effect !== 'deny' || cell.status !== 404 || cell.errorCode !== 'NOT_FOUND' || !c.setupQualification)) fail(`invalid claimed setup contract ${c.key} [${p}]`);
      if (cell.effect === 'deny' && ![401, 403].includes(cell.status) && !cell.concealment && !cell.signatureFailure && !cell.setupClaimed) fail(`non-authorization denial ${c.key} [${p}]`);
      if (cell.effect === 'allow' && (cell.status < 200 || cell.status >= 400)) fail(`non-success allow ${c.key} [${p}]`);
    }
    for (const p of Object.keys(c.cells)) if (!(PRINCIPALS as readonly string[]).includes(p)) fail(`unknown principal ${c.key} [${p}]`);
  }
  for (const key of actual) if (!seen.has(key)) missing.push(`${key} [all eight principals]`);
  if (missing.length) fail(`missing ${missing.length} route/cell contracts:\n${missing.join('\n')}`);
}

/** Run every denial before any destructive positive; positives prepare fresh objects per cell. */
export async function runAuthorizationMatrix(options: {
  app: MatrixApp;
  cases: readonly MatrixCase[];
  /** Operational .all handlers require explicit HTTP-method expansion; middleware is not a route. */
  extraInventory?: readonly { method: string; path: string }[];
  /** Diagnostic continuation is allowed only after complete unchanged-state proof. */
  diagnostics?: MatrixDiagnostics;
}): Promise<MatrixResult> {
  const { app, cases, extraInventory = [] } = options;
  assertMatrixComplete(app, cases, extraInventory);
  await options.diagnostics?.assertSafe();
  const failures: MatrixResponseAssertionError[] = [];
  const result: MatrixResult = { routeCount: matrixRouteKeys(app, extraInventory).length, cellCount: 0,
    allowed: 0, denied: 0, deniedMutationsUnchanged: 0,
    caseSetSha256: createHash('sha256').update(JSON.stringify([...cases].sort((a,b) => a.key.localeCompare(b.key))
      .map(c => [c.key, c.contract, PRINCIPALS.map(p => [p, c.cells[p].effect, c.cells[p].status, c.cells[p].errorCode ?? null, c.cells[p].concealment ?? false, c.cells[p].signatureFailure ?? null, c.cells[p].setupClaimed ?? false])]))).digest('hex') };
  for (const c of cases) if (c.setupQualification) await c.setupQualification();
  const signedTarget = (c: MatrixCase, prepared: PreparedMatrixCell): string => {
    let url = prepared.url;
    if (c.signatureQueryCredential) {
      const parsed = new URL(url, 'http://matrix.invalid');
      if (!parsed.searchParams.get(c.signatureQueryCredential)) fail('missing legacy signature query ' + c.key);
      parsed.searchParams.delete(c.signatureQueryCredential); url = parsed.pathname + parsed.search;
    }
    if (c.key === 'POST /v1/webhooks/apple/storekit') {
      const rawBody = prepared.init?.body;
      if (typeof rawBody !== 'string') fail('Apple webhook needs raw JSON body');
      const envelope = JSON.parse(rawBody) as Record<string, unknown>;
      const signedPayload = envelope.signedPayload;
      if (Object.keys(envelope).length !== 1 || typeof signedPayload !== 'string') fail('Apple webhook must contain only signedPayload');
      const parts = signedPayload.split('.');
      if (parts.length !== 3 || parts.some(part => !part)) fail('Apple webhook needs complete signed JWS');
      // Only JWS signature differs; genuine control must retain exact x5c header & notification payload.
      return JSON.stringify([url, parts.slice(0, 2)]);
    }
    if (c.key.startsWith('POST ') && typeof prepared.init?.body !== 'string') fail('signed webhook needs exact raw payload ' + c.key);
    return JSON.stringify([url, prepared.init?.body ?? null]);
  };
  const concealmentTarget = (c: MatrixCase, url: string) => {
    if (!c.concealmentQueryCredential) return url;
    const parsed = new URL(url, 'http://matrix.invalid'); parsed.searchParams.delete(c.concealmentQueryCredential);
    return parsed.pathname + parsed.search;
  };
  const concealedTargets = new Map<string, Set<string>>(), signedTargets = new Map<string, Set<string>>();
  for (const effect of ['deny', 'allow'] as const) for (const c of cases) for (const principal of PRINCIPALS) {
    const cell = c.cells[principal];
    if (cell.effect !== effect) continue;
    const label = `${c.key} [${principal}]`;
    const prepared = await cell.prepare();
    const method = c.key.slice(0, c.key.indexOf(' '));
    if ((prepared.init?.method ?? 'GET').toUpperCase() !== method) fail(`request method mismatch ${label}`);
    if (!prepared.url.startsWith('/') || prepared.url.startsWith('//')) fail(`nonlocal request ${label}`);
    // Match parameters against the real request, preventing a fixture from proving some other route.
    const pattern = c.key.slice(method.length + 1).split('/');
    const path = new URL(prepared.url, 'http://matrix.invalid').pathname.split('/');
    if ((pattern.at(-1) === '*' ? path.length < pattern.length - 1 : pattern.length !== path.length) || pattern.some((s,i) => s === '*' ? false : /^\{[^}]+\}$/.test(s) ? !path[i] : s !== path[i])) fail(`request path mismatch ${label}`);
    if (effect === 'deny' && cell.concealment) {
      const targets = concealedTargets.get(c.key) ?? new Set<string>(); targets.add(concealmentTarget(c, prepared.url)); concealedTargets.set(c.key, targets);
    }
    if (effect === 'deny' && c.signatureControl) {
      const targets = signedTargets.get(c.key) ?? new Set<string>(); targets.add(signedTarget(c, prepared)); signedTargets.set(c.key, targets);
    }
    const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(method);
    if (mutation && effect === 'deny' && !prepared.snapshot) fail(`missing denial effect snapshot ${label}`);
    const requiresDenialSnapshot = effect === 'deny' && (mutation || cell.concealment || c.signatureControl || cell.setupClaimed);
    if (requiresDenialSnapshot && !prepared.snapshot) fail(`missing concealment effect snapshot ${label}`);
    // GET can mutate recovery/auth state. Honor every supplied complete denial
    // snapshot; fixture wrappers retain only their exact attributed auth exclusions.
    const snapshotDenial = effect === 'deny' && !!prepared.snapshot;
    // Positive fixtures also need a complete BEFORE journal: a rejected write
    // can be diagnosed only when it provably committed no domain/I/O change.
    const snapshot = snapshotDenial ? prepared.snapshot : options.diagnostics?.snapshotFor(principal, method, new URL(prepared.url, 'http://matrix.invalid').pathname, cell.status);
    const before = snapshot ? structuredClone(await snapshot()) : undefined;
    let failure: MatrixResponseAssertionError | undefined;
    try {
      const response = await app.request(prepared.url, prepared.init, prepared.env);
      await options.diagnostics?.assertSafe();
      responseSame(response.status, cell.status, 'status ' + label + ': expected ' + cell.status + ', received ' + response.status);
      if (cell.signatureFailure) responseSame(await response.clone().json(), { error: cell.signatureFailure === 'stripe' ? 'bad signature' : 'notification verification failed' }, 'exact ' + cell.signatureFailure + ' signature failure ' + label);
      if (cell.errorCode) {
        const envelope = await response.clone().json() as { error?: { code?: string } | string; code?: string };
        responseSame(typeof envelope.error === 'string' ? envelope.code : envelope.error?.code, cell.errorCode, 'error code ' + label);
      }
      let responseChecks = 0, stateChecks = 0;
      const count = (domain: ProofDomain = 'response') => { if (domain === 'state') stateChecks++; else responseChecks++; };
      const proof: MatrixProof = {
        equal(actual, expected, detail, domain) {
          if (domain === 'state') same(actual, expected, label + ': ' + detail);
          else responseSame(actual, expected, label + ': ' + detail);
          count(domain);
        },
        ok(condition, detail, domain) {
          if (!condition) {
            if (domain === 'state') fail(label + ': ' + detail);
            else responseFail(label + ': ' + detail);
          }
          count(domain);
        },
      };
      await prepared.verify(response, proof);
      if (!responseChecks) fail('missing meaningful response assertion ' + label);
      if (mutation && effect === 'allow' && !stateChecks) fail('missing committed effect assertion ' + label);
    } catch (error) {
      // Preparation, transport, state, invariant & unknown failures retain the
      // original immediate-stop behavior. Never continue after a changed state.
      if (!options.diagnostics || !(error instanceof MatrixResponseAssertionError)) throw error;
      failure = error;
      await options.diagnostics.assertSafe();
      if (!snapshot) fail('diagnostic failure lacks complete journal ' + label);
      same(await snapshot(), before, 'failed cell changed domain/outbox/files/providers ' + label, failure);
    } finally {
      if (snapshotDenial) {
        same(await snapshot!(), before, 'denial changed domain/outbox/files/providers ' + label, failure);
        if (mutation) result.deniedMutationsUnchanged++;
      }
    }
    if (failure) { failures.push(failure); continue; }
    result.cellCount++;
    if (effect === 'allow') result.allowed++; else result.denied++;
  }
  for (const c of cases) if (c.concealmentControl) {
    const prepared = await c.concealmentControl();
    if ((prepared.init?.method ?? 'GET').toUpperCase() !== c.key.slice(0, c.key.indexOf(' ')) || !prepared.url.startsWith('/') || prepared.url.startsWith('//')) fail('invalid concealment control ' + c.key);
    const targets = concealedTargets.get(c.key);
    if ((c.concealmentQueryCredential && !new URL(prepared.url, 'http://matrix.invalid').searchParams.get(c.concealmentQueryCredential)) || !targets?.has(concealmentTarget(c, prepared.url)) || targets.size !== 1) fail('concealment control must prove same existing target ' + c.key);
    const response = await app.request(prepared.url, prepared.init, prepared.env);
    same(response.status, 200, 'genuine credential concealment control status ' + c.key);
    let responseChecks = 0, stateChecks = 0;
    const count = (domain: ProofDomain = 'response') => { if (domain === 'state') stateChecks++; else responseChecks++; };
    await prepared.verify(response, {
      equal(actual, expected, label, domain) { same(actual, expected, c.key + ': ' + label); count(domain); },
      ok(condition, label, domain) { if (!condition) fail(c.key + ': ' + label); count(domain); },
    });
    if (!responseChecks || !stateChecks) fail('concealment control lacks existing-target response/state proof ' + c.key);
  }
  for (const c of cases) if (c.signatureControl) {
    const prepared = await c.signatureControl();
    const targets = signedTargets.get(c.key);
    if ((prepared.init?.method ?? 'GET').toUpperCase() !== c.key.slice(0, c.key.indexOf(' ')) || !prepared.url.startsWith('/') || prepared.url.startsWith('//')
      || !targets?.has(signedTarget(c, prepared)) || targets.size !== 1) fail('signature control must prove same existing payment/event payload ' + c.key);
    const response = await app.request(prepared.url, prepared.init, prepared.env);
    same(response.status, 200, 'genuine signature control status ' + c.key);
    let responseChecks = 0, stateChecks = 0;
    const count = (domain: ProofDomain = 'response') => { if (domain === 'state') stateChecks++; else responseChecks++; };
    await prepared.verify(response, {
      equal(actual, expected, label, domain) { same(actual, expected, c.key + ': ' + label); count(domain); },
      ok(condition, label, domain) { if (!condition) fail(c.key + ': ' + label); count(domain); },
    });
    if (!responseChecks || !stateChecks) fail('signature control lacks authenticated processing response/state proof ' + c.key);
  }
  same(result.cellCount + failures.length, result.routeCount * PRINCIPALS.length, 'executed cell coverage');
  if (failures.length) throw new AggregateError(failures,
    'authorization matrix: ' + failures.length + ' failed cells (terminal FAIL; no partial PASS):\n' + failures.map(error => error.message).join('\n'));
  return result;
}
