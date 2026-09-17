import { z } from 'zod';

// Update-tier rules for licensed app releases: patch lane vs feature-update
// lane, signed artifact-manifest validation, R2 lane/key discipline.
// The set of licensed app keys is suite configuration — callers pass it in
// (from store config / product metadata); nothing is hardcoded here.

export const PATCH_CHANNEL_PREFIX = 'patch:';
export const PUBLIC_PATCH_CHANNELS = ['patch', `${PATCH_CHANNEL_PREFIX}stable`] as const;

export function isPatchChannel(channel: string): boolean {
  return (PUBLIC_PATCH_CHANNELS as readonly string[]).includes(channel);
}

export function normalizeReleasePlatform(target: string | undefined): string | undefined {
  if (!target) return undefined;
  const normalized = target.toLowerCase();
  if (normalized === 'windows' || normalized.startsWith('windows-')) return 'windows';
  if (normalized === 'darwin' || normalized.startsWith('darwin-')) return 'darwin';
  return target;
}

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/i);
const PipelineVersion = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);

const SignedArtifact = z.object({
  kind: z.enum(['installer', 'updater']),
  r2Key: z.string().min(1),
  sha256: Sha256,
  sizeBytes: z.number().int().positive(),
  updaterSignature: z.string().min(1).nullable(),
}).strict();

const appKeySchema = (appKeys: readonly string[]) =>
  z.string().min(1).refine((k) => appKeys.includes(k), 'unknown app key');

const artifactManifestSchema = (appKeys: readonly string[]) => z.object({
  schema: z.literal(1),
  pipelineVersion: PipelineVersion,
  appKey: appKeySchema(appKeys),
  appVersion: z.string().min(1),
  tier: z.enum(['patch', 'update']),
  platform: z.enum(['darwin', 'windows']),
  artifacts: z.array(SignedArtifact).min(1).max(2),
}).strict();

export type ArtifactManifest = z.infer<ReturnType<typeof artifactManifestSchema>>;

const RegisteredArtifact = z.object({
  artifactKey: z.string().min(1),
  path: z.string().min(1),
  sha256: Sha256,
  sizeBytes: z.number().int().positive(),
}).passthrough();

const TauriManifest = z.object({
  version: z.string().min(1),
  tier: z.enum(['patch', 'update']),
  platforms: z.record(z.string(), z.object({
    url: z.string().url(),
    signature: z.string().min(1),
  }).passthrough()),
}).passthrough();

const releaseRegistrationSchema = (appKeys: readonly string[]) => z.object({
  appKey: appKeySchema(appKeys),
  version: z.string().min(1),
  channel: z.literal('stable').default('stable'),
  platform: z.enum(['darwin', 'windows']),
  manifest: TauriManifest,
  artifacts: z.array(RegisteredArtifact).min(1),
  artifactManifest: artifactManifestSchema(appKeys),
}).passthrough();

const PatchManifest = z.object({
  version: z.string().min(1),
  tier: z.literal('patch'),
  platforms: z.record(z.string(), z.unknown()),
}).passthrough();

const PatchArtifact = z.object({
  artifactKey: z.string().min(1),
  path: z.string().min(1),
  sha256: z.string().nullable().optional(),
  sizeBytes: z.number().int().positive().nullable().optional(),
});

const patchReleaseSchema = (appKeys: readonly string[]) => z.object({
  appKey: appKeySchema(appKeys),
  version: z.string().min(1),
  channel: z.literal('stable').default('stable'),
  platform: z.enum(['darwin', 'windows']),
  manifest: PatchManifest,
  artifacts: z.array(PatchArtifact).optional(),
  artifactManifest: artifactManifestSchema(appKeys),
}).superRefine((value, ctx) => {
  if (value.version !== value.manifest.version) {
    ctx.addIssue({ code: 'custom', path: ['manifest', 'version'], message: 'manifest version must match release version' });
  }
});

export type PatchReleaseBody = z.infer<ReturnType<typeof patchReleaseSchema>>;

export function parsePatchRelease(value: unknown, appKeys: readonly string[]): PatchReleaseBody {
  const parsed = patchReleaseSchema(appKeys).parse(value);
  return validateReleaseRegistration(parsed, 'patch', appKeys) as PatchReleaseBody;
}

export function validateReleaseRegistration(value: unknown, expectedTier: 'patch' | 'update', appKeys: readonly string[]) {
  const body = releaseRegistrationSchema(appKeys).parse(value);
  const manifest = body.artifactManifest;
  const fail = (message: string): never => { throw new Error(`invalid artifact manifest: ${message}`); };

  if (body.manifest.version !== body.version) fail('Tauri manifest version mismatch');
  if (body.manifest.tier !== expectedTier) fail('Tauri manifest tier mismatch');
  if (manifest.appKey !== body.appKey) fail('appKey mismatch');
  if (manifest.appVersion !== body.version) fail('appVersion mismatch');
  if (manifest.tier !== expectedTier) fail('tier mismatch');
  if (manifest.platform !== body.platform) fail('platform mismatch');

  const osPath = body.platform === 'darwin' ? 'mac' : 'windows';
  const lane = expectedTier === 'patch' ? 'installers' : 'updates';
  const expectedKeyPrefix = `${body.appKey}/${lane}/${osPath}/current/`;
  const byKey = new Map<string, Array<z.infer<typeof SignedArtifact>>>();
  const byKind = new Map<string, number>();
  for (const artifact of manifest.artifacts) {
    if (!artifact.r2Key.startsWith(`${body.appKey}/`)) fail('artifact belongs to another app');
    const pathParts = artifact.r2Key.split('/');
    if (pathParts[1] === (expectedTier === 'patch' ? 'updates' : 'installers')) fail('artifact uses the wrong R2 lane');
    if (!artifact.r2Key.startsWith(expectedKeyPrefix) || artifact.r2Key.slice(expectedKeyPrefix.length).includes('/') || artifact.r2Key.length === expectedKeyPrefix.length) {
      fail('artifact must use an exact stable current R2 key');
    }
    const filename = artifact.r2Key.slice(expectedKeyPrefix.length);
    if (/(?:^|[-_.])v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?(?=[-_.]|$)/i.test(filename)) {
      fail('versioned artifact filename would accumulate R2 objects');
    }
    const sameKey = byKey.get(artifact.r2Key) ?? [];
    if (sameKey.length) {
      if (expectedTier !== 'patch' || sameKey.some((entry) => entry.kind === artifact.kind)) {
        fail('duplicate R2 object');
      }
      if (sameKey.some((entry) => entry.sha256 !== artifact.sha256 || entry.sizeBytes !== artifact.sizeBytes)) {
        fail('duplicate R2 object metadata mismatch');
      }
    }
    byKey.set(artifact.r2Key, [...sameKey, artifact]);
    byKind.set(artifact.kind, (byKind.get(artifact.kind) ?? 0) + 1);
    if (artifact.kind === 'updater' && !artifact.updaterSignature) fail('updater signature missing');
    if (artifact.kind === 'installer' && artifact.updaterSignature !== null) fail('installer must not carry an updater signature');
  }
  if (byKind.get('updater') !== 1) fail('exactly one updater artifact is required');
  if (expectedTier === 'patch' && byKind.get('installer') !== 1) fail('patch registration requires one installer artifact');
  if (expectedTier === 'update' && byKind.has('installer')) fail('feature update must not move the installer');

  const registered = new Set<string>();
  if (body.artifacts.length !== 1) fail('exactly one updater registration is required');
  for (const artifact of body.artifacts) {
    const signed = byKey.get(artifact.path)?.find((entry) => entry.kind === 'updater');
    if (signed === undefined) {
      throw new Error('invalid artifact manifest: registered artifact is missing from the signed manifest');
    }
    if (signed.kind !== 'updater') fail('registered artifact is not the signed updater');
    if (signed.sha256 !== artifact.sha256 || signed.sizeBytes !== artifact.sizeBytes) fail('registered artifact metadata mismatch');
    registered.add(artifact.path);
  }
  const updater = manifest.artifacts.find((artifact) => artifact.kind === 'updater')!;
  if (!registered.has(updater.r2Key) || registered.size !== 1) fail('updater registration set mismatch');

  const platformEntries = Object.entries(body.manifest.platforms);
  if (!platformEntries.length) fail('Tauri platforms are empty');
  for (const [target, entry] of platformEntries) {
    if (target !== body.platform && !target.startsWith(`${body.platform}-`)) fail('Tauri target platform mismatch');
    const parsedUrl = parseUpdaterUrl(entry.url);
    const key = decodeURIComponent(parsedUrl.pathname.replace(/^\/+/, ''));
    if (key !== updater.r2Key) fail('updater URL does not match R2 key');
    if (entry.signature !== updater.updaterSignature) fail('updater signature mismatch');
  }

  return body;
}

function parseUpdaterUrl(value: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new Error('invalid artifact manifest: invalid updater URL');
  }
}

export function patchChannel(channel = 'stable'): string {
  return `${PATCH_CHANNEL_PREFIX}${channel}`;
}
