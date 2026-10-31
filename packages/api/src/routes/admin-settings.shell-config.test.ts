import { describe, expect, it, vi } from 'vitest';

vi.mock('../env.js', () => ({ env: {} }));
vi.mock('../db/client.js', () => ({ withStore: vi.fn() }));
vi.mock('../cache/purge-hook.js', () => ({ onStoreShellConfigChanged: vi.fn() }));

describe('shellConfigChanged (ADR-0001 I-4: fail closed for anything the shell/CSP may render)', () => {
  it('flags identity/theme, published, hostnames, storefrontUrl, sign-in providers, seo, payments mode changes', async () => {
    const { shellConfigChanged } = await import('./admin-settings.js');
    const base = { identity: { colors: { primary: '#000' } }, published: true, hostnames: ['a.com'] };
    expect(shellConfigChanged(base, { ...base, identity: { colors: { primary: '#fff' } } })).toBe(true);
    expect(shellConfigChanged(base, { ...base, published: false })).toBe(true);
    expect(shellConfigChanged(base, { ...base, hostnames: ['b.com'] })).toBe(true);
    expect(shellConfigChanged(base, { ...base, storefrontUrl: 'https://a.com' })).toBe(true);
    expect(shellConfigChanged(base, { ...base, googleClientId: 'x' })).toBe(true);
    expect(shellConfigChanged(base, { ...base, auth: { appleServicesId: 'y' } })).toBe(true);
    expect(shellConfigChanged(base, { ...base, someNewUnknownKey: 1 })).toBe(true);
  });
  it('ignores no-op writes and keys that never render (preview token, notifications, email, security, checklist, numbering)', async () => {
    const { shellConfigChanged } = await import('./admin-settings.js');
    const base = { identity: { a: 1 }, published: true };
    expect(shellConfigChanged(base, { ...base })).toBe(false);
    for (const k of ['previewTokenHash', 'notifications', 'email', 'security', 'checklist', 'orderNumbering']) {
      expect(shellConfigChanged(base, { ...base, [k]: { x: 1 } })).toBe(false);
    }
  });
});
