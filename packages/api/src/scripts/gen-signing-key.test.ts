import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./gen-signing-key.ts', import.meta.url));

describe('gen-signing-key script', () => {
  it('prints a PKCS8 PEM private key to stdout and a 32-byte public key to stderr', () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', script], { encoding: 'utf8', timeout: 15_000 });
    expect(result.status).toBe(0);

    expect(result.stdout).toContain('-----BEGIN PRIVATE KEY-----');
    expect(result.stdout).toContain('-----END PRIVATE KEY-----');

    expect(result.stderr).toContain('LICENSE_SIGNING_KEY');
    const hexMatch = result.stderr.match(/hex:\s+([0-9a-f]+)/);
    expect(hexMatch?.[1]).toHaveLength(64); // 32 raw bytes
    const rustMatch = result.stderr.match(/Rust \[u8;32\]: \[([^\]]+)\]/);
    expect(rustMatch?.[1]?.split(',').map((s) => s.trim())).toHaveLength(32);
  });

  it('generates a fresh keypair on every run', () => {
    const a = spawnSync(process.execPath, ['--import', 'tsx', script], { encoding: 'utf8', timeout: 15_000 });
    const b = spawnSync(process.execPath, ['--import', 'tsx', script], { encoding: 'utf8', timeout: 15_000 });
    expect(a.stdout).not.toEqual(b.stdout);
  });
});
