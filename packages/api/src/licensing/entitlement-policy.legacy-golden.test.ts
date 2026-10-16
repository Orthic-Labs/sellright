/**
 * Legacy wire golden for the policy-driven Watch rejection (de-fork plan 3.6, P36-1).
 *
 * The bytes are the RightSites fork's observable response for a Watch
 * activation (golden: test-vectors/legacy-activate-refusals.golden.txt, copied
 * from rs-compat compat/goldens). The fork shapes errors with its
 * legacy-error-shape plugin (rs-compat rightsites-plugin/legacy-error-shape.ts);
 * `legacyShape` below mirrors that transform so the engine can be compared
 * byte for byte without the plugin. DB-free: the Watch guard runs before any
 * store/license lookup.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { createApp } from '../app.js';
import { _resetSigningKeyCache } from './sign.js';
import { clearEntitlementPolicy, registerEntitlementPolicy } from './entitlement-policy.js';
import { forkReferencePolicy } from './entitlement-policy.fork-reference.testkit.js';

const GOLDEN = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'test-vectors', 'legacy-activate-refusals.golden.txt'), 'utf8');
const REQ_ID = 'compat-req-0001';
const BODY = '{"app":"heardright","licenseKey":"SR-HEARDRIGHT-COMPAT-OK","deviceId":"w1","deviceClass":"watch"}';
const HEADER = `### POST /v1/licenses/activate ${BODY}`;

/** Test-side mirror of the fork's legacy-error-shape transform (`{error:{message}}` -> `{error:"message", code, requestId}`). */
async function legacyShape(res: Response): Promise<Response> {
  if (res.status < 400 || !(res.headers.get('content-type') ?? '').includes('application/json')) return res;
  const body = (await res.clone().json()) as { error?: { code?: string; message?: string; requestId?: string } };
  const err = body.error;
  if (!err || typeof err.message !== 'string') return res;
  const legacy = { ...body, error: err.message, ...(err.code ? { code: err.code } : {}), ...(err.requestId ? { requestId: err.requestId } : {}) };
  return new Response(JSON.stringify(legacy), { status: res.status, headers: res.headers });
}

/** Wire transcript as the fork's compat harness records it (status, content-type, blank line, body). */
async function transcript(res: Response): Promise<string> {
  return `HTTP ${res.status}\ncontent-type: ${res.headers.get('content-type')}\n\n${await res.text()}\n`;
}

/** Golden block for HEADER: from the header line to the next section (or EOF), without the separator blank line. */
function goldenBlock(): string {
  const start = GOLDEN.indexOf(HEADER);
  expect(start, 'watch block present in golden').toBeGreaterThanOrEqual(0);
  const next = GOLDEN.indexOf('\n### ', start + 1);
  return next < 0 ? GOLDEN.slice(start) : GOLDEN.slice(start, next + 1);
}

beforeAll(() => {
  const { privateKey } = generateKeyPairSync('ed25519');
  process.env.LICENSE_SIGNING_KEY = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString().replace(/\n/g, '\\n');
  _resetSigningKeyCache();
});
afterEach(() => clearEntitlementPolicy());
afterAll(() => { delete process.env.LICENSE_SIGNING_KEY; _resetSigningKeyCache(); });

describe('policy Watch rejection matches the fork golden bytes (P36-1)', () => {
  it.each(['/v1/licenses/activate', '/api/licenses/activate'])('%s answers the golden bytes exactly', async (path) => {
    registerEntitlementPolicy(forkReferencePolicy());
    const app = createApp();
    const res = await legacyShape(await app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-request-id': REQ_ID },
      body: BODY,
    }));
    const actual = `${HEADER}\n${await transcript(res)}`;
    const expected = goldenBlock();
    expect(Buffer.from(actual, 'utf8').equals(Buffer.from(expected, 'utf8'))).toBe(true);
  });

  it('without the fork policy the same request is not a Watch rejection (default policy is a no-op)', async () => {
    const app = createApp();
    const res = await app.request('/v1/licenses/activate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: BODY,
    });
    expect(res.status).not.toBe(400);
  });
});
