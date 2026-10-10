import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { HttpError, J, errBody, guard, requireAdmin, requireStore, requireWrite, requirePermission } from '../routes/admin-helpers.js';
import { resolveStore } from '../store-context.js';
import { listApiPlugins } from '../plugins.js';
import {
  RELEASE_REGISTRATION_ROUTE, resolvePolicies,
  type PolicyOwner, type ReleaseRegistrationBody, type ReleaseRegistrationPolicy,
} from './registration-policy.js';

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
}).passthrough();

/**
 * The engine-owned release route. `owners` supplies every plugin that may claim it (legacy
 * `ApiPlugin` and SDK `EnginePlugin`); policies are read per request.
 */
export function createReleaseRegistrationRoutes(owners: () => readonly PolicyOwner[]): OpenAPIHono {
  const releaseRegistrationRoutes = new OpenAPIHono();
  releaseRegistrationRoutes.openapi(
    createRoute({
      method: 'post',
      path: RELEASE_REGISTRATION_ROUTE.path,
      summary: 'Create (or republish) an app release manifest',
      request: { body: { content: J(CreateReleaseIn) } },
      responses: {
        200: { description: 'Created', content: J(z.object({ id: z.string() })) },
        400: { description: 'Invalid payload', ...errBody },
        401: { description: 'Unauthorized', ...errBody },
        403: { description: 'Forbidden', ...errBody },
      },
    }),
    async (c) => guard(c, async () => {
      // Policies are read per request: plugins register before createApp(), and
      // tests clear/re-register between runs.
      const policies = resolvePolicies(owners());
      const authz = c.req.header('authorization');

      // 1. Authenticate: tenant-bound service credential OR admin session.
      let storeId: string;
      let auth: 'admin' | 'service';
      let credentialPolicy: ReleaseRegistrationPolicy | undefined;
      const credPolicy = policies.forCredential(authz);
      if (credPolicy) {
        const cred = credPolicy.serviceCredential!;
        const slug = c.req.header('x-store-slug') ?? cred.storeSlug;
        if (slug !== cred.storeSlug) throw new HttpError(403, `release service token is restricted to ${cred.storeSlug}`);
        storeId = (await resolveStore(cred.storeSlug)).id;
        auth = 'service';
        credentialPolicy = credPolicy;
      } else {
        const { admin } = await requireAdmin(c);
        const st = requireStore(admin, c);
        requireWrite(st);
        requirePermission(st, 'releases');
        storeId = st.storeId;
        auth = 'admin';
      }

      // 2. Validate apps/channels via the claiming policy.
      const input = c.req.valid('json') as ReleaseRegistrationBody;
      const invalid = () => new HttpError(400, 'invalid release payload');
      const claiming = policies.forApp(input.appKey);
      if (policies.active && !claiming) throw invalid();
      if (credentialPolicy && claiming !== credentialPolicy) throw invalid();
      if (claiming?.channels && !claiming.channels.includes(input.channel)) throw invalid();
      let body = input;
      if (claiming?.validate) {
        try {
          body = await claiming.validate(input, { storeId, auth });
        } catch {
          throw invalid();
        }
        if (!body || body.appKey !== input.appKey) throw invalid();
      }

      // 3. One transaction: release + artifacts + download_artifact.
      const id = await withStore(storeId, async (tx) => {
        const [row] = await tx.insert(s.appRelease).values({
          storeId,
          appKey: body.appKey,
          version: body.version,
          channel: body.channel,
          platform: body.platform ?? null,
          manifest: body.manifest as object,
        }).onConflictDoUpdate({
          target: [s.appRelease.storeId, s.appRelease.appKey, s.appRelease.channel, s.appRelease.platform, s.appRelease.version],
          set: { manifest: body.manifest as object, publishedAt: new Date() },
        }).returning({ id: s.appRelease.id });
        if (body.artifacts?.length) {
          const q = tx.insert(s.downloadArtifact).values(body.artifacts.map((artifact) => ({
            storeId,
            appReleaseId: row!.id,
            artifactKey: artifact.artifactKey,
            path: artifact.path,
            sha256: artifact.sha256 ?? null,
            sizeBytes: artifact.sizeBytes ?? null,
          })));
          if (claiming?.repointArtifacts) {
            await q.onConflictDoUpdate({
              target: [s.downloadArtifact.storeId, s.downloadArtifact.artifactKey],
              set: {
                appReleaseId: sql`excluded.app_release_id`,
                path: sql`excluded.path`,
                sha256: sql`excluded.sha256`,
                sizeBytes: sql`excluded.size_bytes`,
              },
            });
          } else {
            await q.onConflictDoNothing();
          }
        }
        return row!.id;
      });
      return c.json({ id }, 200);
    }),

  );
  return releaseRegistrationRoutes;
}

/** Legacy singleton: owners are the `registerApiPlugin` list only. */
export const releaseRegistrationRoutes = createReleaseRegistrationRoutes(() => listApiPlugins());
