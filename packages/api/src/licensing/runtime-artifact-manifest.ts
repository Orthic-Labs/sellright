import { verify as edVerify, type KeyObject } from 'node:crypto';
import { z } from 'zod';

// Signed runtime/model artifact manifests: one current manifest pointer per
// app/kind/OS/arch, replaced only after the API verifies the configured Ed25519
// authority, exact digest/provenance, and lane scope.
//
// Suite values — licensed app keys, artifact kinds, bucket names, which kinds
// are private — are all supplied by the deployer via
// createRuntimeArtifactManifestTools(config). Nothing here hardcodes them.

const DEFAULT_ARTIFACT_KINDS = [
  'asr-model', 'ocr-model', 'ort-runtime', 'media-runtime', 'tokenizer', 'preprocessing',
] as const;
const DEFAULT_PRIVATE_KINDS = ['asr-model', 'ocr-model', 'tokenizer'] as const;

export interface RuntimeArtifactManifestConfig {
  /** Licensed app keys allowed in entitlement.appKey / promotion.authorityAppKey. */
  appKeys: readonly string[];
  /** Object-store bucket names per delivery lane. `bundled` uses no bucket. */
  buckets: { private: string; public: string };
  /** Artifact kinds; defaults to the generic runtime/model kind list. */
  artifactKinds?: readonly string[];
  /** Kinds that must always ride the private lane. Defaults to the model kinds. */
  privateKinds?: readonly string[];
}

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const ExactString = z.string().min(1).refine((value) => value.trim() === value, 'must be an exact nonempty string');
const SafeFilename = ExactString.refine(
  (value) => value !== '.' && value !== '..' && !value.includes('/') && !value.includes('\\') && !value.includes('..'),
  'must be one safe basename',
);

export function createRuntimeArtifactManifestTools(config: RuntimeArtifactManifestConfig) {
  const kinds = config.artifactKinds ?? DEFAULT_ARTIFACT_KINDS;
  const privateKinds = new Set<string>(config.privateKinds ?? DEFAULT_PRIVATE_KINDS);
  const AppKey = z.string().min(1).refine((k) => config.appKeys.includes(k), 'unknown app key');

  const RuntimeArtifactManifestSchema = z.object({
    schema: z.literal(1),
    artifactKind: z.string().refine((k) => kinds.includes(k), 'unknown artifact kind'),
    entitlement: z.object({
      appKey: AppKey,
      tier: z.enum(['pro', 'public', 'bundled']),
    }).strict(),
    distribution: z.object({
      delivery: z.enum(['private-r2', 'public-r2', 'bundled']),
      bucket: z.string().min(1).nullable(),
    }).strict(),
    target: z.object({
      os: z.enum(['windows', 'darwin', 'linux', 'ios']),
      arch: z.enum(['x86_64', 'aarch64', 'universal']),
    }).strict(),
    object: z.object({
      r2Key: ExactString.nullable(),
      filename: SafeFilename,
      sha256: Sha256,
      sizeBytes: z.number().int().positive().safe(),
    }).strict(),
    pointerKey: ExactString.nullable(),
    versions: z.object({
      runtime: ExactString,
      model: ExactString,
      tokenizer: ExactString,
      preprocessing: ExactString,
      license: ExactString,
      provenance: ExactString,
    }).strict(),
    provenance: z.object({
      source: z.url().refine((value) => value.startsWith('https://'), 'must be HTTPS'),
      sourceRevision: ExactString,
      licenseId: ExactString,
      noticeSha256: Sha256,
    }).strict(),
    promotion: z.object({
      authorityAppKey: AppKey,
      promotionId: ExactString,
      promotedAt: z.iso.datetime({ offset: false, local: false }),
      evidenceSha256: Sha256,
    }).strict(),
  }).strict().superRefine((value, ctx) => {
    const lanes = {
      'private-r2': { tier: 'pro', bucket: config.buckets.private },
      'public-r2': { tier: 'public', bucket: config.buckets.public },
      bundled: { tier: 'bundled', bucket: null },
    } as const;
    const lane = lanes[value.distribution.delivery];
    if (value.entitlement.tier !== lane.tier || value.distribution.bucket !== lane.bucket) {
      ctx.addIssue({ code: 'custom', path: ['distribution'], message: 'distribution lane contradicts entitlement tier or bucket' });
    }
    if (privateKinds.has(value.artifactKind)
        && (value.distribution.delivery !== 'private-r2' || value.entitlement.tier !== 'pro')) {
      ctx.addIssue({ code: 'custom', path: ['distribution'], message: 'private artifacts must use private-r2 with the private entitlement tier' });
    }
    const objectKey = `${value.entitlement.appKey}/runtime-artifacts/objects/sha256/${value.object.sha256}/${value.object.filename}`;
    if (value.distribution.delivery === 'bundled') {
      if (value.object.r2Key !== null || value.pointerKey !== null) {
        ctx.addIssue({ code: 'custom', path: ['distribution'], message: 'bundled artifacts must not claim R2 keys' });
      }
    } else if (value.object.r2Key !== objectKey) {
      ctx.addIssue({ code: 'custom', path: ['object', 'r2Key'], message: 'contradicts immutable SHA-256 object key' });
    }
    const pointerKey = `${value.entitlement.appKey}/runtime-artifacts/${value.artifactKind}/${value.target.os}/${value.target.arch}/current/manifest.json`;
    if (value.distribution.delivery !== 'bundled' && value.pointerKey !== pointerKey) {
      ctx.addIssue({ code: 'custom', path: ['pointerKey'], message: 'must be the replace-only stable current manifest key' });
    }
    if (normalizeLicense(value.versions.license) !== normalizeLicense(value.provenance.licenseId)) {
      ctx.addIssue({ code: 'custom', path: ['provenance', 'licenseId'], message: 'contradicts versions.license' });
    }
  });

  const RuntimeArtifactEnvelopeSchema = z.object({
    manifest: z.unknown(),
    signature: z.object({
      algorithm: z.literal('Ed25519'),
      keyId: ExactString,
      value: z.string().regex(/^[A-Za-z0-9_-]+$/),
    }).strict(),
  }).strict();

  type RuntimeArtifactManifest = z.infer<typeof RuntimeArtifactManifestSchema>;

  function parseRuntimeArtifactManifest(value: unknown): RuntimeArtifactManifest {
    return RuntimeArtifactManifestSchema.parse(value);
  }

  function canonicalRuntimeArtifactManifest(value: unknown): string {
    const manifest = parseRuntimeArtifactManifest(value);
    return JSON.stringify(sortDeep(manifest));
  }

  function canonicalRuntimeArtifactEnvelope(value: unknown): string {
    const envelope = RuntimeArtifactEnvelopeSchema.parse(value);
    parseRuntimeArtifactManifest(envelope.manifest);
    return JSON.stringify(sortDeep(envelope));
  }

  function verifyRuntimeArtifactEnvelope(value: unknown, publicKey: KeyObject, expectedKeyId?: string): RuntimeArtifactManifest {
    const envelope = RuntimeArtifactEnvelopeSchema.parse(value);
    if (expectedKeyId !== undefined && envelope.signature.keyId !== expectedKeyId) {
      throw new Error('invalid runtime artifact manifest: signing key id is not trusted');
    }
    const manifest = parseRuntimeArtifactManifest(envelope.manifest);
    const signature = Buffer.from(envelope.signature.value, 'base64url');
    const canonical = Buffer.from(canonicalRuntimeArtifactManifest(manifest), 'utf8');
    if (signature.length !== 64 || !edVerify(null, canonical, publicKey, signature)) {
      throw new Error('invalid runtime artifact manifest: signature verification failed');
    }
    return manifest;
  }

  return {
    schema: RuntimeArtifactManifestSchema,
    envelopeSchema: RuntimeArtifactEnvelopeSchema,
    parseRuntimeArtifactManifest,
    canonicalRuntimeArtifactManifest,
    canonicalRuntimeArtifactEnvelope,
    verifyRuntimeArtifactEnvelope,
  };
}

export type RuntimeArtifactManifestTools = ReturnType<typeof createRuntimeArtifactManifestTools>;
export type RuntimeArtifactManifest = ReturnType<RuntimeArtifactManifestTools['parseRuntimeArtifactManifest']>;

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortDeep((value as Record<string, unknown>)[key])]));
  }
  return value;
}

function normalizeLicense(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}
