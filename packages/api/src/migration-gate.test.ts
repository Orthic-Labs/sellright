import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { migrationModeFromEnv, SKIP_MIGRATION_VERIFY_ENV, SKIP_MIGRATION_VERIFY_VALUE } from './migration-gate.js';

describe('startup migration gate', () => {
  it('verifies by default', () => {
    expect(migrationModeFromEnv({})).toBe('verify');
  });

  it('skips only for the exact migration-runner literal; any other value still verifies', () => {
    expect(migrationModeFromEnv({ [SKIP_MIGRATION_VERIFY_ENV]: SKIP_MIGRATION_VERIFY_VALUE })).toBe('skip');
    for (const v of ['1', 'true', 'skip', 'yes', '', ' migration-runner']) {
      expect(migrationModeFromEnv({ [SKIP_MIGRATION_VERIFY_ENV]: v })).toBe('verify');
    }
  });

  it("the stock server entrypoint no longer hard-codes migrations: 'skip' and takes its mode from the gate", () => {
    const src = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/migrations:\s*['"]skip['"]/);
    expect(src).toMatch(/migrationModeFromEnv\(process\.env\)/);
    expect(src).toMatch(/createApp\(\{ migrations \}\)/);
  });
});
