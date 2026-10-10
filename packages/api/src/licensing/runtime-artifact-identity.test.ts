import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { createRuntimeArtifactManifestTools, RuntimeArtifactId } from './runtime-artifact-manifest.js';

const tools = createRuntimeArtifactManifestTools({
  appKeys: ['alphaapp'],
  buckets: { private: 'example-updates', public: 'example-downloads' },
});
const { canonicalRuntimeArtifactManifest, verifyRuntimeArtifactEnvelope } = tools;

const digest = 'a'.repeat(64);

function base(extra: Record<string, unknown> = {}, target = { os: 'darwin', arch: 'aarch64' }) {
  const { artifactId, ...rest } = extra as { artifactId?: string };
  const identity = artifactId === undefined ? '' : `${artifactId}/`;
  return {
    schema: 1,
    artifactKind: 'ocr-model',
    ...(artifactId === undefined ? {} : { artifactId }),
    entitlement: { appKey: 'alphaapp', tier: 'pro' },
    distribution: { delivery: 'private-r2', bucket: 'example-updates' },
    target,
    object: {
      r2Key: `alphaapp/runtime-artifacts/objects/sha256/${digest}/pp-ocrv5.onnx`,
      filename: 'pp-ocrv5.onnx',
      sha256: digest,
      sizeBytes: 123,
    },
    pointerKey: `alphaapp/runtime-artifacts/ocr-model/${identity}${target.os}/${target.arch}/current/manifest.json`,
    versions: {
      runtime: 'onnxruntime-1.22.0', model: 'pp-ocrv5-mobile', tokenizer: 'ppocr-dict-2026-07-14',
      preprocessing: 'ocr-0.1.0', license: 'Apache-2.0', provenance: 'alphaapp-approved-2026-07-14',
    },
    provenance: {
      source: 'https://github.com/example/repo', sourceRevision: '0123456789abcdef',
      licenseId: 'Apache-2.0', noticeSha256: 'b'.repeat(64),
    },
    promotion: {
      authorityAppKey: 'alphaapp', promotionId: 'aa-ocr-2026-07-14-001',
      promotedAt: '2026-07-14T12:00:00.000Z', evidenceSha256: 'c'.repeat(64),
    },
    ...rest,
  };
}

const keys = generateKeyPairSync('ed25519');
function accepts(payload: Record<string, unknown>): boolean {
  try {
    const signature = sign(null, Buffer.from(canonicalRuntimeArtifactManifest(payload as never)), keys.privateKey).toString('base64url');
    verifyRuntimeArtifactEnvelope({ manifest: payload, signature: { algorithm: 'Ed25519', keyId: 'example-runtime-2026-01', value: signature } }, keys.publicKey);
    return true;
  } catch {
    return false;
  }
}

describe('runtime artifact identity and any/any targets (de-fork Phase 5)', () => {
  it('keeps the legacy pointer for manifests without artifactId', () => {
    expect(accepts(base())).toBe(true);
  });

  it('accepts an identified artifact only at the identity-scoped pointer', () => {
    expect(accepts(base({ artifactId: 'ocr-main' }))).toBe(true);
    const wrong = base({ artifactId: 'ocr-main' });
    wrong.pointerKey = 'alphaapp/runtime-artifacts/ocr-model/darwin/aarch64/current/manifest.json';
    expect(accepts(wrong)).toBe(false);
  });

  it('rejects an identified artifact that claims a legacy pointer', () => {
    const legacy = base();
    expect(accepts({ ...legacy, artifactId: 'ocr-main' })).toBe(false);
  });

  it('accepts any/any and rejects half-wildcard targets', () => {
    expect(accepts(base({}, { os: 'any', arch: 'any' }))).toBe(true);
    expect(accepts(base({}, { os: 'any', arch: 'aarch64' }))).toBe(false);
    expect(accepts(base({}, { os: 'darwin', arch: 'any' }))).toBe(false);
  });

  it('validates artifact identity slugs', () => {
    expect(RuntimeArtifactId.safeParse('ocr-main').success).toBe(true);
    for (const bad of ['', 'OCR', 'a/b', 'a..b', ' ocr', 'ocr-', '-ocr']) {
      expect(RuntimeArtifactId.safeParse(bad).success, bad).toBe(false);
    }
  });
});
