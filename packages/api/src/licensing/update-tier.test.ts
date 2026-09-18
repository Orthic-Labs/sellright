import { describe, expect, it } from 'vitest';
import { PATCH_CHANNEL_PREFIX, PUBLIC_PATCH_CHANNELS, isPatchChannel, normalizeReleasePlatform, patchChannel, parsePatchRelease } from './update-tier.js';

const APP_KEYS = ['alphaapp', 'betaapp'] as const;

function patchRelease(appKey: string) {
  const updaterKey = `${appKey}/installers/windows/current/App.exe`;
  return {
    appKey,
    version: '1.2.3',
    channel: 'stable',
    platform: 'windows',
    manifest: {
      version: '1.2.3',
      tier: 'patch',
      platforms: { 'windows-x86_64': { url: `https://downloads.example/${updaterKey}`, signature: 'sig' } },
    },
    artifacts: [{ artifactKey: 'update', path: updaterKey, sha256: 'a'.repeat(64), sizeBytes: 42 }],
    artifactManifest: {
      schema: 1,
      pipelineVersion: '0.2.14',
      appKey,
      appVersion: '1.2.3',
      tier: 'patch',
      platform: 'windows',
      artifacts: [
        { kind: 'installer', r2Key: `${appKey}/installers/windows/current/App-Setup.exe`, sha256: 'b'.repeat(64), sizeBytes: 84, updaterSignature: null },
        { kind: 'updater', r2Key: updaterKey, sha256: 'a'.repeat(64), sizeBytes: 42, updaterSignature: 'sig' },
      ],
    },
  };
}

describe('patch release routing (generic app keys)', () => {
  it.each(APP_KEYS)('accepts registered app %s', (appKey) => {
    const release = parsePatchRelease(patchRelease(appKey), APP_KEYS);
    expect(release.appKey).toBe(appKey);
    expect(patchChannel(release.channel)).toBe(`${PATCH_CHANNEL_PREFIX}stable`);
  });

  it('rejects apps outside the configured set', () => {
    expect(() => parsePatchRelease(patchRelease('unknown'), APP_KEYS)).toThrow();
  });

  it('reads both legacy and canonical stable patch channels during migration', () => {
    expect(PUBLIC_PATCH_CHANNELS).toEqual(['patch', 'patch:stable']);
    expect(isPatchChannel('patch')).toBe(true);
    expect(isPatchChannel('patch:stable')).toBe(true);
    expect(isPatchChannel('stable')).toBe(false);
  });

  it('normalizes updater targets to the stored OS release lane', () => {
    expect(normalizeReleasePlatform('windows-x86_64')).toBe('windows');
    expect(normalizeReleasePlatform('windows-aarch64')).toBe('windows');
    expect(normalizeReleasePlatform('darwin-aarch64')).toBe('darwin');
    expect(normalizeReleasePlatform('darwin-x86_64')).toBe('darwin');
    expect(normalizeReleasePlatform('windows')).toBe('windows');
    expect(normalizeReleasePlatform(undefined)).toBeUndefined();
  });

  it('accepts one signed object serving as both installer and patch updater', () => {
    const release = patchRelease('alphaapp');
    const updater = release.artifactManifest.artifacts[1]!;
    release.artifactManifest.artifacts[0] = {
      ...release.artifactManifest.artifacts[0]!,
      r2Key: updater.r2Key,
      sha256: updater.sha256,
      sizeBytes: updater.sizeBytes,
    };
    expect(() => parsePatchRelease(release, APP_KEYS)).not.toThrow();
  });

  it('rejects shared installer/updater keys when their bytes do not match', () => {
    const release = patchRelease('alphaapp');
    release.artifactManifest.artifacts[0]!.r2Key = release.artifactManifest.artifacts[1]!.r2Key;
    expect(() => parsePatchRelease(release, APP_KEYS)).toThrow(/duplicate R2 object metadata mismatch/);
  });

  it('requires a patch manifest with the matching version', () => {
    const release = patchRelease('betaapp');
    release.manifest.version = '1.2.4';
    release.manifest.tier = 'update';
    expect(() => parsePatchRelease(release, APP_KEYS)).toThrow();
  });
});
