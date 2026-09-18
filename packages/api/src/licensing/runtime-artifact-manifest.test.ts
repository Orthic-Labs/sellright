import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { createRuntimeArtifactManifestTools } from './runtime-artifact-manifest.js';

// Suite values live in the deployer's config, never in the schema itself.
const tools = createRuntimeArtifactManifestTools({
  appKeys: ['alphaapp', 'betaapp'],
  buckets: { private: 'example-updates', public: 'example-downloads' },
});

const { parseRuntimeArtifactManifest, canonicalRuntimeArtifactManifest, verifyRuntimeArtifactEnvelope } = tools;

const digest = 'a'.repeat(64);

function manifest() {
  return {
    schema: 1,
    artifactKind: 'ocr-model',
    entitlement: { appKey: 'alphaapp', tier: 'pro' },
    distribution: { delivery: 'private-r2', bucket: 'example-updates' },
    target: { os: 'darwin', arch: 'aarch64' },
    object: {
      r2Key: `alphaapp/runtime-artifacts/objects/sha256/${digest}/pp-ocrv5.onnx`,
      filename: 'pp-ocrv5.onnx',
      sha256: digest,
      sizeBytes: 123,
    },
    pointerKey: 'alphaapp/runtime-artifacts/ocr-model/darwin/aarch64/current/manifest.json',
    versions: {
      runtime: 'onnxruntime-1.22.0',
      model: 'pp-ocrv5-mobile',
      tokenizer: 'ppocr-dict-2026-07-14',
      preprocessing: 'ocr-0.1.0',
      license: 'Apache-2.0',
      provenance: 'alphaapp-approved-2026-07-14',
    },
    provenance: {
      source: 'https://github.com/example/repo',
      sourceRevision: '0123456789abcdef',
      licenseId: 'Apache-2.0',
      noticeSha256: 'b'.repeat(64),
    },
    promotion: {
      authorityAppKey: 'alphaapp',
      promotionId: 'aa-ocr-2026-07-14-001',
      promotedAt: '2026-07-14T12:00:00.000Z',
      evidenceSha256: 'c'.repeat(64),
    },
  };
}

describe('private runtime artifact manifest boundary', () => {
  it('accepts the exact signed stable pointer to an immutable object', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const payload = manifest();
    const signature = sign(null, Buffer.from(canonicalRuntimeArtifactManifest(payload)), privateKey).toString('base64url');
    const envelope = {
      manifest: payload,
      signature: { algorithm: 'Ed25519', keyId: 'example-runtime-2026-01', value: signature },
    };
    expect(verifyRuntimeArtifactEnvelope(envelope, publicKey)).toEqual(payload);
  });

  it('fails closed on absent and contradictory provenance, digests, versions, promotion, and scope', () => {
    const mutations: Array<(value: any) => void> = [
      (value) => { delete value.versions.model; },
      (value) => { value.provenance.licenseId = 'MIT'; },
      (value) => { value.object.r2Key = value.object.r2Key.replace(digest, 'd'.repeat(64)); },
      (value) => { value.pointerKey = value.pointerKey.replace('/current/', '/v1/'); },
      (value) => { value.entitlement.tier = 'free'; },
      (value) => { value.promotion.authorityAppKey = 'unknown'; },
      (value) => { value.promotion.evidenceSha256 = 'bad'; },
    ];
    for (const mutate of mutations) {
      const value = structuredClone(manifest());
      mutate(value);
      expect(() => parseRuntimeArtifactManifest(value)).toThrow();
    }
  });

  it('rejects tampering, unknown fields, and non-Ed25519 envelopes', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const payload = manifest();
    const signature = sign(null, Buffer.from(canonicalRuntimeArtifactManifest(payload)), privateKey).toString('base64url');
    const envelope = {
      manifest: payload,
      signature: { algorithm: 'Ed25519', keyId: 'example-runtime-2026-01', value: signature },
    };
    const tampered = structuredClone(envelope);
    tampered.manifest.object.sizeBytes += 1;
    expect(() => verifyRuntimeArtifactEnvelope(tampered, publicKey)).toThrow(/signature verification failed/);

    const extra = structuredClone(payload) as any;
    extra.downloadToken = 'secret';
    expect(() => parseRuntimeArtifactManifest(extra)).toThrow();

    const wrongAlgorithm = structuredClone(envelope);
    wrongAlgorithm.signature.algorithm = 'RSA';
    expect(() => verifyRuntimeArtifactEnvelope(wrongAlgorithm, publicKey)).toThrow();
  });

  it('accepts explicit public and bundled runtime lanes but keeps private kinds private', () => {
    const publicMedia: any = structuredClone(manifest());
    publicMedia.artifactKind = 'media-runtime';
    publicMedia.entitlement.tier = 'public';
    publicMedia.distribution = { delivery: 'public-r2', bucket: 'example-downloads' };
    publicMedia.pointerKey = 'alphaapp/runtime-artifacts/media-runtime/darwin/aarch64/current/manifest.json';
    expect(parseRuntimeArtifactManifest(publicMedia).distribution.delivery).toBe('public-r2');

    const bundledOrt: any = structuredClone(manifest());
    bundledOrt.artifactKind = 'ort-runtime';
    bundledOrt.entitlement.tier = 'bundled';
    bundledOrt.distribution = { delivery: 'bundled', bucket: null };
    bundledOrt.object.r2Key = null;
    bundledOrt.pointerKey = null;
    expect(parseRuntimeArtifactManifest(bundledOrt).distribution.delivery).toBe('bundled');

    const publicModel: any = structuredClone(manifest());
    publicModel.entitlement.tier = 'public';
    publicModel.distribution = { delivery: 'public-r2', bucket: 'example-downloads' };
    expect(() => parseRuntimeArtifactManifest(publicModel)).toThrow(/private artifacts must use private-r2 with the private entitlement tier/);
  });
});
