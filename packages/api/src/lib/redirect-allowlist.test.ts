import { describe, expect, it } from 'vitest';
import { isAllowedRedirectHost } from './redirect-allowlist.js';

describe('isAllowedRedirectHost', () => {
  it('allows an exact allowlisted host', () => {
    expect(isAllowedRedirectHost('https://r2.dev/file.zip', 'r2.dev')).toBe(true);
  });

  it('allows a subdomain of an allowlisted suffix', () => {
    expect(isAllowedRedirectHost('https://pub-abc123.r2.dev/file.zip', 'r2.dev')).toBe(true);
  });

  it('rejects a non-allowlisted host', () => {
    expect(isAllowedRedirectHost('https://attacker.example.com/malware.exe', 'r2.dev,cloudfront.net')).toBe(false);
  });

  it('rejects when the allowlist is empty', () => {
    expect(isAllowedRedirectHost('https://r2.dev/file.zip', '')).toBe(false);
  });

  it('rejects a malformed URL', () => {
    expect(isAllowedRedirectHost('not-a-url', 'r2.dev')).toBe(false);
  });
});
