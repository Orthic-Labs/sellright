import { describe, expect, it } from 'vitest';
import { AGENT_DENIED, IRREVERSIBLE_PATH, agentDenied } from './agent-policy.js';
describe('agent deny set', () => {
  it('reads are never denied', () => {
    expect(agentDenied('GET', '/v1/admin/customers')).toBeNull();
    expect(agentDenied('GET', '/v1/admin/payments/settings')).toBeNull();
  });
  it('additive and reversible writes fall through to role guards', () => {
    for (const [m, p] of [['POST', '/v1/admin/products'], ['PATCH', '/v1/admin/products/:id'], ['PATCH', '/v1/admin/variants/:id'], ['POST', '/v1/admin/draft-orders'], ['POST', '/v1/admin/orders/:code/fulfill'], ['POST', '/v1/admin/orders/bulk-soft-delete'], ['POST', '/v1/admin/orders/bulk-restore'], ['POST', '/v1/admin/reviews/:id/approve'], ['POST', '/v1/admin/discounts'], ['PATCH', '/v1/admin/settings/store'], ['POST', '/v1/admin/email/settings/test-send'], ['POST', '/v1/admin/cache/purge'], ['POST', '/v1/admin/agents/browser-session']] as const) {
      expect([m, p, agentDenied(m, p)]).toEqual([m, p, null]);
    }
  });
  it('irreversible, identity, credential and system routes are denied with a group', () => {
    expect(agentDenied('DELETE', '/v1/admin/products/:id')).toBe('delete');
    expect(agentDenied('POST', '/v1/admin/orders/:code/cancel')).toBe('irreversible_order');
    expect(agentDenied('POST', '/v1/admin/orders/bulk-purge')).toBe('irreversible_order');
    expect(agentDenied('POST', '/v1/admin/orders/:code/refund')).toBe('money_out');
    expect(agentDenied('POST', '/v1/admin/affiliates/:id/settle')).toBe('money_out');
    expect(agentDenied('POST', '/v1/admin/returns/:id/approve')).toBe('money_out');
    expect(agentDenied('POST', '/v1/admin/payment-reconciliation/effects/:id/retry')).toBe('settlement');
    expect(agentDenied('PATCH', '/v1/admin/sheerid/config')).toBe('credentials');
    expect(agentDenied('POST', '/v1/admin/settings/preview-token')).toBe('credentials');
    expect(agentDenied('PATCH', '/v1/admin/settings/payments/stripe-mode')).toBe('credentials');
    expect(agentDenied('POST', '/v1/admin/customers/:id/loyalty/adjust')).toBe('credit');
    expect(agentDenied('POST', '/v1/admin/loyalty/ledger/:id/reverse')).toBe('credit');
    expect(agentDenied('POST', '/v1/admin/licenses')).toBe('entitlement');
    expect(agentDenied('POST', '/v1/admin/apps/releases')).toBe('release');
    expect(agentDenied('POST', '/v1/admin/staff')).toBe('identity');
    expect(agentDenied('PUT', '/v1/admin/staff/:adminUserId/permissions')).toBe('identity');
    expect(agentDenied('POST', '/v1/admin/agents')).toBe('identity');
    expect(agentDenied('POST', '/v1/admin/2fa/setup')).toBe('credentials');
    expect(agentDenied('PUT', '/v1/admin/payments/settings/:provider/:mode')).toBe('credentials');
    expect(agentDenied('POST', '/v1/admin/system/canary')).toBe('system');
  });
  it('every key is well-formed', () => {
    for (const k of AGENT_DENIED.keys()) expect(k).toMatch(/^(POST|PUT|PATCH|DELETE) \/v1\/admin\/[^ ]+$/);
  });
  it('the invariant regex catches bulk and hyphenated irreversible paths (so the CI gate would notice their removal)', () => {
    for (const p of ['/v1/admin/orders/bulk-cancel', '/v1/admin/orders/bulk-purge', '/v1/admin/orders/:code/cancel', '/v1/admin/settings/payments/stripe-mode', '/v1/admin/settings/preview-token', '/v1/admin/returns/:id/approve', '/v1/admin/payment-reconciliation/effects/:id/retry', '/v1/admin/customers/:id/loyalty/adjust', '/v1/admin/loyalty/ledger/:id/reverse']) expect([p, IRREVERSIBLE_PATH.test(p)]).toEqual([p, true]);
    for (const p of ['/v1/admin/products', '/v1/admin/orders/bulk-soft-delete', '/v1/admin/orders/bulk-restore', '/v1/admin/draft-orders', '/v1/admin/settings/store', '/v1/admin/gift-cards']) expect([p, IRREVERSIBLE_PATH.test(p)]).toEqual([p, false]);
  });
});
