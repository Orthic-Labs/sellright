import { describe, expect, it } from 'vitest';
import { AGENT_TOKEN_PREFIX, hashAgentToken, isAgentToken, newAgentToken } from './admin-api-token.js';
describe('agent API tokens', () => {
  it('mints sra_-prefixed 256-bit base64url tokens that differ', () => {
    const a = newAgentToken(), b = newAgentToken();
    expect(a.startsWith(AGENT_TOKEN_PREFIX)).toBe(true); expect(a).toHaveLength(AGENT_TOKEN_PREFIX.length + 43); expect(a).not.toBe(b);
  });
  it('recognises only prefixed tokens (session tokens are 64 hex chars)', () => {
    expect(isAgentToken('sra_abc')).toBe(true); expect(isAgentToken('a'.repeat(64))).toBe(false); expect(isAgentToken(undefined)).toBe(false);
  });
  it('hashes with sha256 hex', () => { expect(hashAgentToken('sra_x')).toMatch(/^[0-9a-f]{64}$/); expect(hashAgentToken('sra_x')).toBe(hashAgentToken('sra_x')); });
});
