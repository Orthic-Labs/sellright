import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, desc, eq, isNull, or } from 'drizzle-orm';
import { withStore } from '../db/client.js';
import { resolveStore, DEV_DEFAULT_STORE, type StoreCtx } from '../store-context.js';
import * as s from '../db/schema.js';
import { activateLicenseOnDevice, findActivationByToken } from '../licensing/activations.js';
import { canAccessDownload, canReceiveUpdate } from '../licensing/entitlements.js';
import { bearerToken } from '../licensing/tokens.js';
import { signedDownloadPath, verifyDownloadSig, downloadSigningConfigured } from '../licensing/download-url.js';
import { isAllowedRedirectHost } from '../lib/redirect-allowlist.js';
import { J, errBody, guard, requireAdmin, requireStore, requireWrite, requirePermission } from './admin-helpers.js';
import { err as logErr } from '../lib/logger.js';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { env } from '../env.js';

async function store(c: { req: { header: (k: string) => string | undefined } }): Promise<StoreCtx> {
  const slug = c.req.header('x-store-slug') ?? DEV_DEFAULT_STORE;
  return resolveStore(slug);
}

export const apps = new OpenAPIHono();

// ra-011: appKeyFromHost is intentionally NOT used on the public activate endpoint
// any more — kept for the update/release paths which are read-only and keyed by
// the activation token (not the license key), so host-header spoofing there
// cannot escalate privileges beyond what the bearer token allows.
function appKeyFromHost(host: string | undefined): string | null {
  const hostname = host?.split(':')[0]?.toLowerCase();
  if (!hostname || hostname === 'localhost' || hostname === '127.0.0.1') return null;
  const first = hostname.split('.')[0];
  if (!first || first === 'www' || first === 'api') return null;
  return first;
}

async function publicAppStore(c: { req: { header: (k: string) => string | undefined } }, explicitApp?: string | null) {
  const appKey = explicitApp ?? c.req.header('x-viewright-app') ?? c.req.header('x-app-key') ?? appKeyFromHost(c.req.header('host')) ?? DEV_DEFAULT_STORE;
  return { appKey, st: await resolveStore(appKey) };
}

const ReleaseArtifactIn = z.object({
  artifactKey: z.string().min(1),
  path: z.string().min(1),
  sha256: z.string().nullable().optional(),
  sizeBytes: z.number().int().positive().nullable().optional(),
});
const CreateReleaseIn = z.object({
  appKey: z.string().min(1),
  version: z.string().min(1),
  channel: z.string().default('stable'),
  platform: z.string().nullable().optional(),
  manifest: z.any(),
  artifacts: z.array(ReleaseArtifactIn).optional(),
});
type CreateReleaseBody = z.infer<typeof CreateReleaseIn>;

// ra-011: body.app is now REQUIRED on the public activate endpoint. We never
// fall back to Host-header-derived appKey here — an attacker controlling the
// Host header could otherwise pivot to any store's license namespace.
const PublicActivateIn = z.object({
  app: z.string().min(1),
  deviceId: z.string().min(1),
  licenseKey: z.string().min(1),
  version: z.string().optional(),
});

apps.openapi(
  createRoute({
    method: 'post',
    path: '/v1/apps/{appKey}/licenses/activate',
    summary: 'Activate an app license on a device',
    request: {
      params: z.object({ appKey: z.string().min(1) }),
      body: { content: J(z.object({ licenseKey: z.string().min(1), deviceId: z.string().min(1), deviceLabel: z.string().optional() })) },
    },
    responses: {
      200: { description: 'Activated', content: J(z.object({ activated: z.boolean(), ok: z.boolean(), appKey: z.string(), status: z.string(), licenseId: z.string(), activationToken: z.string(), updatesUntil: z.string().nullable(), expiresAt: z.string().nullable(), seats: z.number().int() })) },
      404: { description: 'Not found', ...errBody },
      409: { description: 'Seat limit reached', ...errBody },
    },
  }),
  async (c) => {
    const st = await store(c);
    const { appKey } = c.req.valid('param');
    const { licenseKey, deviceId, deviceLabel } = c.req.valid('json');
    const out = await withStore(st.id, (tx) => activateLicenseOnDevice(tx, { storeId: st.id, appKey, licenseKey, deviceId, deviceLabel }));
    if (out.kind === 'notfound') return c.json({ error: 'license not found' }, 404);
    if (out.kind === 'full') return c.json({ error: 'license seat limit reached' }, 409);
    return c.json({
      activated: true,
      ok: true,
      appKey,
      status: out.lic.status,
      licenseId: out.lic.id,
      activationToken: out.activationToken,
      updatesUntil: out.lic.updatesUntil?.toISOString() ?? null,
      expiresAt: out.lic.expiresAt?.toISOString() ?? null,
      seats: out.lic.seats,
    }, 200);
  },
);

// ra-011: body.app is required — PublicActivateIn.parse will throw (400) if omitted.
// We pass body.app directly into publicAppStore so the store is always caller-supplied,
// never derived from the Host header.
apps.post('/api/licenses/activate', async (c) => {
  const body = PublicActivateIn.parse(await c.req.json());
  const { appKey, st } = await publicAppStore(c, body.app);
  const out = await withStore(st.id, (tx) => activateLicenseOnDevice(tx, {
    storeId: st.id,
    appKey,
    licenseKey: body.licenseKey,
    deviceId: body.deviceId,
    deviceLabel: body.version ? `app ${body.version}` : null,
  }));
  if (out.kind === 'notfound') return c.json({ ok: false, status: 'not_found', message: 'License not found or inactive' }, 404);
  if (out.kind === 'full') return c.json({ ok: false, status: 'seat_limit_reached', message: 'License device limit reached' }, 409);
  return c.json({
    ok: true,
    status: out.lic.status,
    licenseId: out.lic.id,
    activationToken: out.activationToken,
    updatesUntil: out.lic.updatesUntil?.toISOString() ?? null,
    message: 'Activated',
  }, 200);
});

apps.get('/releases/latest.json', async (c) => {
  const activationToken = bearerToken(c.req.header('authorization')) ?? c.req.header('x-viewright-license');
  if (!activationToken) return c.json({ ok: false, message: 'Missing activation token' }, 401);

  // Require an explicit app identifier — never fall back to DEV_DEFAULT_STORE /
  // Host-header derivation here (mirrors the /api/licenses/activate hardening).
  const explicitApp = c.req.header('x-viewright-app') ?? c.req.header('x-app-key');
  if (!explicitApp) return c.json({ ok: false, message: 'Missing app identifier (X-ViewRight-App header)' }, 400);
  const { appKey, st } = await publicAppStore(c, explicitApp);
  const deviceId = c.req.header('x-viewright-device');
  const channel = c.req.query('channel') ?? 'stable';
  const platform = c.req.query('platform') ?? undefined;

  const out = await withStore(st.id, async (tx) => {
    const activation = await findActivationByToken(tx, { appKey, activationToken, deviceId });
    if (!activation) return { kind: 'unauthorized' as const };
    if (!canReceiveUpdate(activation.license)) return { kind: 'ineligible' as const };
    const [release] = await tx
      .select()
      .from(s.appRelease)
      .where(and(
        eq(s.appRelease.appKey, appKey),
        eq(s.appRelease.channel, channel),
        platform ? or(eq(s.appRelease.platform, platform), isNull(s.appRelease.platform)) : undefined,
      ))
      .orderBy(desc(s.appRelease.publishedAt))
      .limit(1);
    if (!release) return { kind: 'norelease' as const };
    return { kind: 'ok' as const, release };
  });

  if (out.kind === 'unauthorized') return c.json({ ok: false, message: 'Invalid activation token' }, 401);
  if (out.kind === 'ineligible') return c.json({ ok: false, message: 'Updates expired' }, 403);
  if (out.kind === 'norelease') return c.json({ ok: false, message: 'No release available' }, 404);
  return c.json(out.release.manifest as object, 200);
});

apps.openapi(
  createRoute({
    method: 'get',
    path: '/v1/apps/{appKey}/updates/latest',
    summary: 'Return latest app update manifest when the license is eligible',
    request: {
      params: z.object({ appKey: z.string().min(1) }),
      // ra-006: licenseKey is no longer accepted as a query param (proxy/CDN logging).
      // Clients MUST send it as: Authorization: Bearer <licenseKey>
      // CLIENT CONTRACT CHANGE: remove licenseKey from query; add Authorization header.
      query: z.object({
        channel: z.string().default('stable'),
        platform: z.string().optional(),
      }),
    },
    responses: {
      200: { description: 'Eligibility + manifest', content: J(z.object({ eligible: z.boolean(), reason: z.string().optional(), manifest: z.any().optional(), version: z.string().optional() })) },
      401: { description: 'Missing or invalid license key', ...errBody },
      404: { description: 'Not found', ...errBody },
    },
  }),
  async (c) => {
    const st = await store(c);
    const { appKey } = c.req.valid('param');
    // ra-006: read license key from Authorization: Bearer header only.
    const licenseKey = bearerToken(c.req.header('authorization'));
    if (!licenseKey) return c.json({ error: 'Missing license key — provide Authorization: Bearer <licenseKey>' }, 401);
    const { channel, platform } = c.req.valid('query');
    const out = await withStore(st.id, async (tx) => {
      const [lic] = await tx.select().from(s.license).where(and(eq(s.license.licenseKey, licenseKey), eq(s.license.appKey, appKey))).limit(1);
      if (!lic) return { kind: 'notfound' as const };
      if (!canReceiveUpdate(lic)) return { kind: 'ineligible' as const };
      const [release] = await tx
        .select()
        .from(s.appRelease)
        .where(and(
          eq(s.appRelease.appKey, appKey),
          eq(s.appRelease.channel, channel),
          platform ? or(eq(s.appRelease.platform, platform), isNull(s.appRelease.platform)) : undefined,
        ))
        .orderBy(desc(s.appRelease.publishedAt))
        .limit(1);
      if (!release) return { kind: 'norelease' as const };
      return { kind: 'ok' as const, release };
    });
    if (out.kind === 'notfound') return c.json({ error: 'license not found' }, 404);
    if (out.kind === 'ineligible') return c.json({ eligible: false, reason: 'updates_expired' }, 200);
    if (out.kind === 'norelease') return c.json({ eligible: false, reason: 'no_release' }, 200);
    return c.json({ eligible: true, version: out.release.version, manifest: out.release.manifest }, 200);
  },
);

apps.openapi(
  createRoute({
    method: 'get',
    path: '/v1/apps/{appKey}/downloads/{artifactKey}',
    summary: 'Return a licensed digital download artifact',
    request: {
      params: z.object({ appKey: z.string().min(1), artifactKey: z.string().min(1) }),
      // ra-006: licenseKey is no longer accepted as a query param (proxy/CDN logging).
      // Clients MUST send it as: Authorization: Bearer <licenseKey>
      // CLIENT CONTRACT CHANGE: remove licenseKey from query; add Authorization header.
      query: z.object({}),
    },
    responses: {
      200: { description: 'Download artifact', content: J(z.object({ artifactKey: z.string(), url: z.string(), sha256: z.string().nullable(), sizeBytes: z.number().int().nullable() })) },
      401: { description: 'Missing or invalid license key', ...errBody },
      403: { description: 'Not entitled', ...errBody },
      404: { description: 'Not found', ...errBody },
      503: { description: 'Downloads not configured (DOWNLOAD_URL_SECRET unset)', ...errBody },
    },
  }),
  async (c) => {
    const st = await store(c);
    const { appKey, artifactKey } = c.req.valid('param');
    // ra-006: read license key from Authorization: Bearer header only.
    const licenseKey = bearerToken(c.req.header('authorization'));
    if (!licenseKey) return c.json({ error: 'Missing license key — provide Authorization: Bearer <licenseKey>' }, 401);
    const out = await withStore(st.id, async (tx) => {
      const [lic] = await tx.select().from(s.license).where(and(eq(s.license.licenseKey, licenseKey), eq(s.license.appKey, appKey))).limit(1);
      if (!lic) return { kind: 'notfound' as const };
      if (!canAccessDownload(lic)) return { kind: 'forbidden' as const };
      const [artifact] = await tx
        .select({
          artifactKey: s.downloadArtifact.artifactKey,
          path: s.downloadArtifact.path,
          sha256: s.downloadArtifact.sha256,
          sizeBytes: s.downloadArtifact.sizeBytes,
        })
        .from(s.downloadArtifact)
        .innerJoin(s.appRelease, eq(s.appRelease.id, s.downloadArtifact.appReleaseId))
        .where(and(eq(s.downloadArtifact.artifactKey, artifactKey), eq(s.appRelease.appKey, appKey)))
        .limit(1);
      if (!artifact) return { kind: 'notfound' as const };
      return { kind: 'ok' as const, artifact };
    });
    if (out.kind === 'forbidden') return c.json({ error: 'license is not active' }, 403);
    if (out.kind === 'notfound') return c.json({ error: 'download not found' }, 404);
    // ra-005: hand back a short-lived HMAC-signed URL (15 min) to the streaming
    // /v1/dl route instead of the permanent artifact path. Fail loud if the signing
    // secret isn't set — never emit an unsigned permanent link.
    if (!downloadSigningConfigured()) return c.json({ error: 'downloads are not configured for this store' }, 503);
    c.header('Cache-Control', 'no-store');
    return c.json({
      artifactKey: out.artifact.artifactKey,
      url: signedDownloadPath(st.id, out.artifact.artifactKey),
      sha256: out.artifact.sha256,
      sizeBytes: out.artifact.sizeBytes,
    }, 200);
  },
);

// GET /v1/dl/{artifactKey} — fetch a signed, short-lived download. The signature
// (issued by the license-gated /downloads endpoint above) IS the capability here,
// so there is no license re-check. Streams from the PRIVATE DOWNLOAD_DIR — never
// the nginx-served /assets path — so a leaked link expires in minutes and the
// underlying file is not independently reachable.
apps.get('/v1/dl/:artifactKey', async (c) => {
  const artifactKey = c.req.param('artifactKey');
  const storeId = c.req.query('store') ?? '';
  const exp = Number(c.req.query('exp'));
  const sig = c.req.query('sig') ?? '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(storeId) || !verifyDownloadSig(storeId, artifactKey, exp, sig)) {
    return c.json({ error: 'invalid or expired download link' }, 403);
  }
  // storeId is signed, so trusting it for the RLS scope is safe.
  const artifact = await withStore(storeId, async (tx) => {
    const [a] = await tx.select({ path: s.downloadArtifact.path })
      .from(s.downloadArtifact).where(eq(s.downloadArtifact.artifactKey, artifactKey)).limit(1);
    return a ?? null;
  });
  if (!artifact) return c.json({ error: 'not found' }, 404);
  c.header('Cache-Control', 'no-store');
  // External storage (S3/CDN) can't be streamed by us — redirect (best-effort;
  // prefer a local DOWNLOAD_DIR path for full protection). SEC-4: only redirect
  // to an operator-allowlisted host — artifact.path is admin/staff-supplied, and
  // without this check a release could point a signed download link from the
  // legitimate domain at an attacker-controlled host (malware-delivery phishing).
  if (/^https?:\/\//i.test(artifact.path)) {
    if (isAllowedRedirectHost(artifact.path, env.ARTIFACT_EXTERNAL_HOST_ALLOWLIST)) {
      return c.redirect(artifact.path, 302);
    }
    logErr.error('SEC-4 rejected redirect', undefined, { artifactHost: artifact.path });
    return c.json({ error: 'download is not available' }, 502);
  }
  // Local file: resolve under DOWNLOAD_DIR with a traversal guard, then stream.
  const baseDir = resolve(env.DOWNLOAD_DIR);
  const filePath = resolve(baseDir, artifact.path);
  if (filePath !== baseDir && !filePath.startsWith(baseDir + sep)) return c.json({ error: 'not found' }, 404);
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return c.json({ error: 'not found' }, 404);
    c.header('Content-Type', 'application/octet-stream');
    c.header('Content-Length', String(info.size));
    c.header('Content-Disposition', `attachment; filename="${artifactKey.replace(/[^\w.\-]/g, '_')}"`);
    return c.body(Readable.toWeb(createReadStream(filePath)) as unknown as ReadableStream);
  } catch {
    return c.json({ error: 'not found' }, 404);
  }
});

apps.openapi(
  createRoute({
    method: 'post',
    path: '/v1/admin/apps/releases',
    summary: 'Create an app release manifest',
    request: {
      body: { content: J(CreateReleaseIn) },
    },
    responses: {
      200: { description: 'Created', content: J(z.object({ id: z.string() })) },
      401: { description: 'Unauthorized', ...errBody },
    },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireWrite(st); requirePermission(st, 'releases');
    const body = c.req.valid('json') as CreateReleaseBody;
    const id = await withStore(st.storeId, async (tx) => {
      const [row] = await tx.insert(s.appRelease).values({
        storeId: st.storeId,
        appKey: body.appKey,
        version: body.version,
        channel: body.channel,
        platform: body.platform ?? null,
        manifest: body.manifest as object,
      }).returning({ id: s.appRelease.id });
      if (body.artifacts?.length) {
        await tx.insert(s.downloadArtifact).values(body.artifacts.map((artifact) => ({
          storeId: st.storeId,
          appReleaseId: row!.id,
          artifactKey: artifact.artifactKey,
          path: artifact.path,
          sha256: artifact.sha256 ?? null,
          sizeBytes: artifact.sizeBytes ?? null,
        }))).onConflictDoNothing();
      }
      return row!.id;
    });
    return c.json({ id }, 200);
  }),
);

apps.openapi(
  createRoute({
    method: 'get',
    path: '/v1/admin/apps/releases',
    summary: 'List app releases',
    request: { query: z.object({ appKey: z.string().optional(), channel: z.string().optional() }) },
    responses: { 200: { description: 'Releases', content: J(z.object({ items: z.array(z.any()) })) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const { appKey, channel } = c.req.valid('query');
    const items = await withStore(st.storeId, async (tx) => tx
      .select({ id: s.appRelease.id, appKey: s.appRelease.appKey, version: s.appRelease.version, channel: s.appRelease.channel, platform: s.appRelease.platform, publishedAt: s.appRelease.publishedAt })
      .from(s.appRelease)
      .where(and(appKey ? eq(s.appRelease.appKey, appKey) : undefined, channel ? eq(s.appRelease.channel, channel) : undefined))
      .orderBy(desc(s.appRelease.publishedAt))
      .limit(100));
    return c.json({ items: items.map((i) => ({ ...i, publishedAt: i.publishedAt.toISOString() })) }, 200);
  }),
);
