import { describe, expect, it } from 'vitest';
import { assertGatewayTestTarget as assertTarget } from './gateway-e2e-safety.js';

describe('gateway E2E target authorization', () => {
  it('accepts only an explicitly named test database', () => {
    expect(() => assertTarget('postgres://localhost/sellright_test', 'sellright_test')).not.toThrow();
  });
  it.each([
    ['postgres://user_test:secret@localhost/rightapps', 'rightapps'],
    ['postgres://localhost/rightapps?application_name=foo_test', 'rightapps'],
    ['postgres://localhost/sellright_dev', 'sellright_dev'],
    ['postgres://localhost/sellright_test', undefined],
    ['postgres://localhost/sellright_test', 'different_test'],
    ['https://localhost/sellright_test', 'sellright_test'],
    ['not-a-url', 'sellright_test'],
  ])('rejects an unsafe or unconfirmed target', (url, confirmed) => {
    expect(() => assertTarget(url!, confirmed)).toThrow();
  });
});
